import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateItem, freshness, windowFor } from './normalize.mjs';
import {
  loadEnv,
  makeRedactor,
  parseFeed,
  fetchText,
  extractArticle,
  imageVerdict,
  downloadImage,
  buildUserMessage,
  buildQaRepairMessage,
  callWithRetry,
  extractJson,
  qaPost,
  normalizePostFields,
  renderPreview,
  MAIN_CATEGORIES,
} from './engine.mjs';
import { postText } from './telegram.mjs';
import { newsDateLine } from './newstime.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);
const SOURCE_ID = option('--source', 'techcrunch');
const FEED_URL = option('--feed-url', '');
const SOURCE_NAME = option('--source-name', SOURCE_ID);
const MATCH = option('--match', '');
const MODEL = option('--model', 'DeepSeek-V4-Flash');
const INSPECT = flag('--inspect');
const OUT_ROOT = resolve(ROOT, 'results/local');

let env;
try {
  env = await loadEnv(resolve(ROOT, '.env'));
} catch {
  console.error('ENV_MISSING');
  process.exit(1);
}
const redact = makeRedactor(env);

async function main() {
  if (!env.AMD_API_KEY) {
    console.error('AMD_API_KEY_MISSING');
    process.exit(1);
  }

  const sources = JSON.parse(await readFile(resolve(ROOT, 'pipeline/sources.json'), 'utf8'));
  const source = FEED_URL
    ? { id: SOURCE_ID, name: SOURCE_NAME, type: 'news', feed_url: FEED_URL }
    : sources.sources.find((entry) => entry.id === SOURCE_ID);
  if (!source) {
    console.error(`UNKNOWN_SOURCE ${SOURCE_ID}`);
    process.exit(1);
  }
  if (!source.feed_url) {
    console.error(`NO_FEED_URL ${SOURCE_ID}`);
    process.exit(1);
  }

  const feed = await fetchText(source.feed_url, {
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    redact,
  });
  const items = parseFeed(feed.text);
  if (items.length === 0) {
    console.error('NO_FEED_ITEMS');
    process.exit(1);
  }

  const item = MATCH
    ? items.find((entry) => entry.title.toLowerCase().includes(MATCH.toLowerCase()))
    : items[0];
  if (!item) {
    console.error(`NO_MATCH ${MATCH}`);
    console.log('AVAILABLE:');
    for (const entry of items.slice(0, 12)) console.log(`- ${entry.title}`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  let article;
  try {
    const page = await fetchText(item.link, { redact });
    article = extractArticle(page.text, item.title);
    article.url = page.url || item.link;
  } catch (error) {
    article = {
      title: item.title,
      description: item.summary,
      published: item.published,
      imageUrl: item.images[0] || '',
      imageAlt: '',
      content: item.summary,
      meta: {},
      jsonLd: [],
      url: item.link,
      fetchError: redact(error?.message),
    };
  }

  const publishedAt = article.published || item.published;
  const newsDate = newsDateLine(publishedAt);
  const preGate = freshness(publishedAt, now, { maxAgeHours: windowFor(undefined) });
  const preGateResult = evaluateItem(
    { id: item.title, published_at: publishedAt, url: article.url, content: article.content },
    { now }
  );

  const feedImage = item.images[0] || '';
  const rawImage = article.imageUrl || feedImage;
  const verdict = imageVerdict(rawImage, article.imageAlt);
  const imageUrl = verdict.ok ? rawImage : '';
  const host = (() => {
    try {
      return new URL(article.url).hostname;
    } catch {
      return '';
    }
  })();

  const baseInfo = {
    ranAt: now,
    source: { id: source.id, name: source.name, type: source.type, feed_url: source.feed_url },
    item: { title: item.title, link: item.link, published: item.published },
    article: {
      title: article.title,
      url: article.url,
      published_at: publishedAt,
      description: article.description,
      contentChars: article.content.length,
      fetch_error: article.fetchError || '',
    },
    gate: {
      pre: preGate,
      evaluate: preGateResult,
      category: null,
    },
    image: {
      candidate: rawImage,
      alt: article.imageAlt,
      verdict,
      used_url: imageUrl,
    },
  };

  if (INSPECT) {
    console.log(`SOURCE ${source.id} | FEED_ITEMS ${items.length}`);
    console.log(`TITLE ${item.title}`);
    console.log(`URL ${article.url}`);
    console.log(`PUBLISHED ${publishedAt} | AGE ${preGate.ageHours}h | PRE_GATE ${preGate.ok ? 'ok' : preGate.reason} (${preGate.maxAgeHours}h)`);
    console.log(`CONTENT ${article.content.length} chars | DESC ${article.description.slice(0, 160)}`);
    console.log(`IMAGE ${rawImage || '-'} | ${verdict.ok ? 'allowed' : `rejected:${verdict.reason}`}`);
    console.log(`FIRST ${article.content.slice(0, 500).replace(/\s+/g, ' ')}`);
    await mkdir(OUT_ROOT, { recursive: true });
    await writeFile(
      resolve(OUT_ROOT, 'inspect.json'),
      JSON.stringify({ ...baseInfo, article: { ...baseInfo.article, content: article.content } }, null, 2)
    );
    console.log(`WROTE ${resolve(OUT_ROOT, 'inspect.json')}`);
    return;
  }

  if (!preGate.ok) {
    console.error(`PRE_GATE_REJECT ${preGate.reason} (${preGate.ageHours}h / ${preGate.maxAgeHours}h)`);
    process.exit(2);
  }

  const stamp = now.replace(/[:.]/g, '-');
  const outDir = resolve(OUT_ROOT, `run-${stamp}`);
  await mkdir(outDir, { recursive: true });

  let downloaded = null;
  let imageRejected = verdict.ok ? '' : verdict.reason;
  if (imageUrl) {
    try {
      downloaded = await downloadImage(imageUrl, outDir);
    } catch (error) {
      imageRejected = `download:${redact(error?.message)}`;
    }
  }

  const system = await readFile(resolve(ROOT, 'bench/system-prompt.md'), 'utf8');
  const user = buildUserMessage({ item, article, url: article.url, now, imageUrl, maxAgeHours: windowFor(undefined) });
  const base = (env.AMD_BASE_URL || 'https://developer.amd.com.cn/radeon/api/v1').replace(/\/$/, '');

  console.log(`SOURCE ${source.id} | ITEM ${item.title}`);
  console.log(`AGE ${preGate.ageHours}h | PRE_GATE ok (${preGate.maxAgeHours}h)`);
  console.log(`CONTENT ${article.content.length} chars | IMAGE ${imageUrl ? 'allowed' : `rejected:${imageRejected}`}`);
  console.log(`MODEL ${MODEL} | CALLING`);

  const first = await callWithRetry(
    { base, apiKey: env.AMD_API_KEY, model: MODEL, system, user, redact },
    4,
    console.log
  );
  let parsed = extractJson(first.content);
  let second = null;
  if (!parsed) {
    console.log('  invalid JSON, one corrective retry');
    const corrective = `${user}\n\nخروجی قبلی JSON معتبر نبود. فقط یک آبجکت JSON معتبر بده.`;
    second = await callWithRetry(
      { base, apiKey: env.AMD_API_KEY, model: MODEL, system, user: corrective, redact },
      2,
      console.log
    );
    parsed = extractJson(second.content);
  }
  let repair = null;
  parsed = parsed ? normalizePostFields(parsed) : parsed;

  const qaContext = {
    url: article.url,
    host,
    sourceType: source.type,
    category: parsed?.category,
    imageUrl,
    title: article.title,
    description: article.description,
    content: article.content,
    publishedAt,
    now,
    previousWhy: '',
  };
  let qa = qaPost(parsed, qaContext);

  const relevanceFailed = qa.problems.includes('ai_relevance');
  const styleWarning = qa.warnings.includes('formal_verbs') || qa.warnings.includes('why_repeat');
  if (parsed?.decision === 'publish' && (!qa.pass || styleWarning) && !relevanceFailed) {
    console.log(`${qa.pass ? 'STYLE_WARNING' : 'QA_FAILED'} ${qa.problems.join(',') || qa.warnings.join(',')} | one repair retry`);
    repair = await callWithRetry(
      {
        base,
        apiKey: env.AMD_API_KEY,
        model: MODEL,
        system,
        user: buildQaRepairMessage({ user, parsed, qa, imageUrl, previousWhy: '', newsDate }),
        redact,
      },
      2,
      console.log
    );
    const repaired = extractJson(repair.content);
    if (repaired) {
      const candidate = normalizePostFields(repaired);
      const candidateQa = qaPost(candidate, { ...qaContext, category: candidate.category });
      const better =
        (candidateQa.pass && !qa.pass) ||
        (candidateQa.pass === qa.pass && candidateQa.warnings.length < qa.warnings.length) ||
        (candidateQa.pass === qa.pass &&
          candidateQa.warnings.length === qa.warnings.length &&
          candidateQa.score >= qa.score);
      if (better) {
        parsed = candidate;
        qa = candidateQa;
      }
      console.log(`REPAIR_QA ${qa.pass ? 'PASS' : 'FAIL'} | score ${qa.score}/${qa.possible} | problems ${qa.problems.join(',') || 'none'} | warnings ${qa.warnings.join(',') || 'none'}${better ? '' : ' | kept original'}`);
    } else {
      console.log('REPAIR_INVALID_JSON');
    }
  }

  const calls = [first, second, repair].filter(Boolean);
  const usage = calls.reduce(
    (total, entry) => ({
      prompt_tokens: (total.prompt_tokens ?? 0) + (Number(entry.usage?.prompt_tokens) || 0),
      completion_tokens: (total.completion_tokens ?? 0) + (Number(entry.usage?.completion_tokens) || 0),
      total_tokens: (total.total_tokens ?? 0) + (Number(entry.usage?.total_tokens) || 0),
    }),
    {}
  );
  const cost = calls.reduce((sum, entry) => sum + (Number(entry.usage?.cost) || 0), 0);
  const lastCall = calls[calls.length - 1];

  const effectiveCategory = parsed?.category && MAIN_CATEGORIES.includes(parsed.category) ? parsed.category : null;
  const categoryGate = effectiveCategory
    ? freshness(publishedAt, now, { maxAgeHours: windowFor(effectiveCategory) })
    : null;

  const post =
    parsed?.decision === 'publish'
      ? {
          title: String(parsed.title ?? '').trim(),
          news_date: newsDate,
          body: String(parsed.body ?? ''),
          quote: String(parsed.quote ?? '').trim(),
        }
      : { title: 'رد شده', body: `دلیل: ${parsed?.reason || 'بدون دلیل'}` };

  const imageUsed = Boolean(parsed?.image_url && downloaded);
  const imagePath = downloaded ? downloaded.file : '';
  const report = {
    ...baseInfo,
    gate: { ...baseInfo.gate, category: { category: effectiveCategory, result: categoryGate } },
    image: {
      ...baseInfo.image,
      downloaded: downloaded ? { bytes: downloaded.bytes, type: downloaded.type, file: downloaded.file } : null,
      rejected_reason: imageRejected,
    },
    model: {
      name: MODEL,
      status: lastCall.status,
      ms: lastCall.ms,
      attempts: calls.reduce((sum, entry) => sum + (entry.attempts ?? 0), 0),
      finish: lastCall.finish,
      reasoning_chars: lastCall.reasoningChars,
      usage,
      cost,
      raw_chars: lastCall.content.length,
      json_retry: Boolean(second),
      qa_repair: Boolean(repair),
      error: lastCall.error,
    },
    qa,
    post,
    output: {
      dir: outDir,
      post: resolve(outDir, 'post.txt'),
      parsed: resolve(outDir, 'parsed.json'),
      raw: resolve(outDir, 'response.txt'),
      input: resolve(outDir, 'input.json'),
      report: resolve(outDir, 'report.json'),
      preview: resolve(outDir, 'preview.html'),
      image: imagePath,
    },
  };

  await writeFile(resolve(outDir, 'input.json'), JSON.stringify({
    source: baseInfo.source,
    item: baseInfo.item,
    article: { ...baseInfo.article, content: article.content },
    image: baseInfo.image,
    now,
    max_age_hours: windowFor(undefined),
  }, null, 2));
  await writeFile(
    resolve(outDir, 'response.txt'),
    [first.content, second ? `--- JSON RETRY ---\n\n${second.content}` : '', repair ? `--- QA REPAIR ---\n\n${repair.content}` : '']
      .filter(Boolean)
      .join('\n\n')
  );
  await writeFile(resolve(outDir, 'parsed.json'), JSON.stringify(parsed, null, 2));
  await writeFile(resolve(outDir, 'post.txt'), `${postText(post)}\n`);
  await writeFile(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(
    resolve(outDir, 'preview.html'),
    renderPreview({
      post,
      qa,
      imageUsed,
      imagePath: imagePath ? `image.${downloaded.ext}` : '',
      imageVerdict: imageRejected,
      sourceUrl: article.url,
      inspectOnly: false,
    })
  );

  console.log('');
  console.log(`MODEL_HTTP ${lastCall.status} | ${lastCall.ms}ms | attempts ${report.model.attempts} | finish ${lastCall.finish || '-'}`);
  console.log(`TOKENS prompt ${usage.prompt_tokens ?? '-'} | completion ${usage.completion_tokens ?? '-'} | total ${usage.total_tokens ?? '-'} | cost $${cost.toFixed(6)}`);
  console.log(`CATEGORY ${effectiveCategory || '-'} | CATEGORY_AGE ${categoryGate ? `${categoryGate.ageHours}h/${categoryGate.maxAgeHours}h ${categoryGate.ok ? 'ok' : categoryGate.reason}` : '-'}`);
  console.log(`IMAGE_USED ${imageUsed ? 'yes' : 'no'}${imageRejected ? ` (${imageRejected})` : ''}`);
  console.log(`QA ${qa.pass ? 'PASS' : 'FAIL'} | score ${qa.score}/${qa.possible} | problems ${qa.problems.join(',') || 'none'}`);
  console.log(`TITLE ${post.title}`);
  console.log(`OUT ${outDir}`);
  console.log('NOTHING_WAS_PUBLISHED');
}

await main();
