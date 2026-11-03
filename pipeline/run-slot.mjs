import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash, freshness, windowFor } from './normalize.mjs';
import {
  loadEnv,
  makeRedactor,
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
import { collectCandidates } from './collect.mjs';
import { assessOffer, detectOffer, offerUsage, reviewText } from './offers.mjs';
import {
  loadState,
  saveState,
  resolveSlot,
  slotStart,
  slotKey,
  dateKey,
  weekKey,
  isSlotSettled,
  markSeen,
  markSlot,
  quotaSnapshot,
  recordPublished,
  pruneState,
} from './store.mjs';
import { sendTelegram, sendText, captionLength, postText } from './telegram.mjs';
import { newsDateLine } from './newstime.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);

const NOW = option('--now', new Date().toISOString());
const SLOT = option('--slot', '');
const DATE = option('--date', '');
const MODEL = option('--model', 'DeepSeek-V4-Flash');
const SEND = flag('--send');
const REVIEW_SEND = flag('--review-send');
const FORCE = flag('--force');
const MAX_CANDIDATES = Number(option('--max-candidates', '4'));
const PER_SOURCE = Number(option('--per-source', '12'));
const MIN_CONTENT = Number(option('--min-content', '300'));
const EARLY_MINUTES = Number(option('--early-minutes', '30'));
const LATE_MINUTES = Number(option('--late-minutes', '90'));
const SOURCE_FILTER = option('--sources', '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const AI_ONLY_SOURCES = new Set(['the-decoder', 'arstechnica-ai']);
const STATE_PATH = resolve(
  ROOT,
  option('--state', SEND ? (REVIEW_SEND ? 'data/state.review.json' : 'data/state.json') : 'data/state.dry.json')
);
const OUT_ROOT = resolve(ROOT, option('--out', 'results/outbox'));
const REVIEW_ROOT = resolve(ROOT, option('--review-out', 'results/review'));
const SOURCES_FILE = option('--sources-file', 'pipeline/sources.json');

let env;
try {
  env = await loadEnv(resolve(ROOT, '.env'));
} catch {
  console.error('ENV_MISSING');
  process.exit(1);
}
const redact = makeRedactor(env);

if (!env.AMD_API_KEY) {
  console.error('AMD_API_KEY_MISSING');
  process.exit(1);
}

const config = JSON.parse(await readFile(resolve(ROOT, 'pipeline/config.json'), 'utf8'));
const registry = JSON.parse(await readFile(resolve(ROOT, SOURCES_FILE), 'utf8'));
const system = await readFile(resolve(ROOT, 'bench/system-prompt.md'), 'utf8');
const base = option('--base', env.AMD_BASE_URL || 'https://developer.amd.com.cn/radeon/api/v1').replace(/\/$/, '');
const REVIEW_CHAT_ID = env[config.offers?.review?.chat_env || 'TELEGRAM_REVIEW_CHAT_ID'] || '';
const CHAT_ID = REVIEW_SEND ? REVIEW_CHAT_ID : option('--chat-id', env.TELEGRAM_CHAT_ID);
const RUN_MODE = SEND ? (REVIEW_SEND ? 'send_review' : 'send') : 'dry';

if (SEND && (!env.TELEGRAM_BOT_TOKEN || !CHAT_ID)) {
  console.error('TELEGRAM_CREDENTIALS_MISSING');
  process.exit(1);
}

const PRIMARY = {
  role: 'primary',
  base,
  apiKey: env.AMD_API_KEY,
  model: MODEL,
  maxTokens: 2600,
  timeoutMs: 150000,
  reasoningEffort: '',
  maxContentChars: 0,
};
const FALLBACK = {
  role: 'fallback',
  base: (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
  apiKey: env.GROQ_API_KEY || '',
  model: option('--fallback-model', env.GROQ_MODEL || 'openai/gpt-oss-120b'),
  maxTokens: Number(option('--fallback-max-tokens', '2000')),
  timeoutMs: Number(option('--fallback-timeout-ms', '90000')),
  reasoningEffort: option('--fallback-reasoning', 'low'),
  maxContentChars: Number(option('--fallback-content-chars', '6000')),
};
const FALLBACK_ENABLED = Boolean(FALLBACK.apiKey) && !flag('--no-fallback');
if (FALLBACK_ENABLED) {
  FALLBACK.system = await readFile(
    resolve(ROOT, option('--fallback-prompt', 'bench/system-prompt-emergency.md')),
    'utf8'
  );
}

const writerOptions = (writer, user) => ({
  base: writer.base,
  apiKey: writer.apiKey,
  model: writer.model,
  system: writer.system || system,
  user,
  maxTokens: writer.maxTokens,
  timeoutMs: writer.timeoutMs,
  reasoningEffort: writer.reasoningEffort,
  redact,
});
const usageOf = (result) => {
  const usage = result?.usage ?? {};
  return { cost: Number(usage.cost ?? 0) || 0, tokens: Number(usage.total_tokens ?? 0) || 0 };
};

function activeSlot() {
  if (SLOT) {
    if (!config.schedule.slots.includes(SLOT)) {
      console.error(`UNKNOWN_SLOT ${SLOT}`);
      process.exit(1);
    }
    const date = DATE || dateKey(NOW);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error(`BAD_DATE ${date}`);
      process.exit(1);
    }
    const start = slotStart(date, SLOT);
    const diffMinutes = (Date.parse(NOW) - start.getTime()) / 60000;
    // --force is a manual override: scheduled runs never pass it.
    if (!FORCE && diffMinutes < -EARLY_MINUTES) {
      console.log(`SLOT_NOT_DUE ${slotKey(date, SLOT)} starts ${start.toISOString()}`);
      process.exit(0);
    }
    if (!FORCE && diffMinutes > LATE_MINUTES) {
      console.log(`SLOT_EXPIRED ${slotKey(date, SLOT)} started ${start.toISOString()}`);
      process.exit(0);
    }
    return { ready: true, date, slot: SLOT, key: slotKey(date, SLOT), startsAt: start.toISOString() };
  }

  const resolved = resolveSlot(NOW, {
    slots: config.schedule.slots,
    earlyMinutes: EARLY_MINUTES,
    lateMinutes: LATE_MINUTES,
  });
  if (!resolved.ready) {
    console.log(`NO_ACTIVE_SLOT next=${resolved.next.key} starts ${resolved.next.startsAt}`);
    process.exit(0);
  }
  return resolved;
}

function outboxDir(slot) {
  const [date, time] = String(slot).split('T');
  return resolve(OUT_ROOT, date, time.slice(0, 5).replace(':', '-'));
}

const importanceOf = (body) => {
  const before = String(body ?? '').split(/^[ \t]*منبع\s*[:：]/m)[0];
  return before.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).at(-1) ?? '';
};

async function main() {
  const slot = activeSlot();
  const state = await loadState(STATE_PATH);
  const previousWhy = [...(state.published ?? [])].reverse().find((entry) => entry.why)?.why ?? '';
  const week = weekKey(slot.date);
  const quota = quotaSnapshot(config, state, week);

  console.log(`SLOT ${slot.key} | WEEK ${week} | MODE ${RUN_MODE.toUpperCase()}`);
  console.log(`QUOTA ${MAIN_CATEGORIES.map((category) => `${category} ${quota[category].used}/${quota[category].quota}`).join(' | ')}`);

  if (isSlotSettled(state, slot.key) && !FORCE) {
    console.log(`SLOT_ALREADY_DONE ${slot.key} status=${state.slots[slot.key].status}`);
    console.log('NOTHING_WAS_SENT');
    return;
  }
  if (MAIN_CATEGORIES.every((category) => quota[category].remaining === 0)) {
    markSlot(state, slot.key, { status: 'empty', reason: 'quota_full' });
    await saveState(STATE_PATH, state);
    console.log('RESULT EMPTY reason=quota_full');
    console.log('NOTHING_WAS_SENT');
    return;
  }

  let sources = registry.sources.filter((source) => source.feed_url);
  if (SOURCE_FILTER.length) {
    sources = sources.filter((source) => SOURCE_FILTER.includes(source.id));
    if (sources.length === 0) {
      console.error(`NO_SOURCES_MATCH ${SOURCE_FILTER.join(',')}`);
      process.exit(1);
    }
  }

  const { candidates, stats } = await collectCandidates({
    sources,
    state,
    now: NOW,
    perSource: PER_SOURCE,
    maxAgeHours: config.freshness_hours.pre_gate,
    redact,
  });
  console.log(`COLLECT sources=${stats.sources} items=${stats.feedItems} stale=${stats.stale} nodate=${stats.noDate} dup=${stats.duplicate} kept=${stats.kept} errors=${stats.errors.length}`);
  for (const error of stats.errors) console.log(`  FEED_ERROR ${error.source}: ${error.error}`);

  if (candidates.length === 0) {
    markSlot(state, slot.key, { status: 'empty', reason: 'no_candidates' });
    await saveState(STATE_PATH, state);
    console.log('RESULT EMPTY reason=no_candidates');
    console.log('NOTHING_WAS_SENT');
    return;
  }

  const relevantCandidates = candidates.filter((candidate) =>
    candidate.offerHint ||
    candidate.sourceType === 'official_blog' ||
    AI_ONLY_SOURCES.has(candidate.sourceId) ||
    candidate.aiCentral
  );
  const relevantSet = new Set(relevantCandidates);
  const droppedCandidates = candidates.filter((candidate) => !relevantSet.has(candidate));
  console.log(`RELEVANCE candidates=${candidates.length} kept=${relevantCandidates.length} dropped=${droppedCandidates.length}`);
  for (const candidate of droppedCandidates.slice(0, 8)) {
    console.log(`  SKIP_NOT_AI ${candidate.sourceName} | ${candidate.title}`);
  }
  if (droppedCandidates.length > 8) {
    console.log(`  SKIP_NOT_AI ... +${droppedCandidates.length - 8} more`);
  }
  if (relevantCandidates.length === 0) {
    markSlot(state, slot.key, { status: 'empty', reason: 'no_ai_candidates' });
    await saveState(STATE_PATH, state);
    console.log('RESULT EMPTY reason=no_ai_candidates');
    console.log('NOTHING_WAS_SENT');
    return;
  }

  const attempts = [];
  let published = null;
  let totalCost = 0;
  let totalTokens = 0;
  let reviews = 0;
  let fallbackSpent = false;

  async function routeReview({ candidate, article, assessment, reason }) {
    const effective = { ...assessment, reason: reason || assessment?.reason };
    const text = reviewText({ article, candidate, assessment: effective, offer: { isOffer: true } });
    const slug = contentHash(candidate.canonical).slice(0, 8);
    const dir = resolve(REVIEW_ROOT, slot.date, `${slot.slot.replace(':', '-')}-${slug}`);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'review.json'), JSON.stringify({
      slot: slot.key,
      mode: RUN_MODE,
      reason: effective.reason,
      source: { id: candidate.sourceId, name: candidate.sourceName, url: article.url },
      title: article.title || candidate.title,
      published_at: article.published || candidate.published,
      expiry: effective.expiry ?? null,
      note: 'این مورد به کانال اصلی منتشر نشده و فقط برای بازبینی ثبت شده است.',
      createdAt: NOW,
    }, null, 2));
    await writeFile(resolve(dir, 'review.txt'), `${text}\n`);

    let messageId = null;
    let sendError = '';
    if (SEND && config.offers?.review?.enabled && REVIEW_CHAT_ID) {
      try {
        const sent = await sendText(text, { token: env.TELEGRAM_BOT_TOKEN, chatId: REVIEW_CHAT_ID });
        messageId = sent.messageId;
      } catch (error) {
        sendError = String(error?.message ?? error);
      }
    }

    markSeen(state, candidate.keys, {
      decision: 'review',
      reason: effective.reason,
      category: '',
      slot: slot.key,
      title: candidate.title,
      url: candidate.canonical,
    });
    reviews += 1;
    attempts.push({ title: candidate.title, result: 'review', reason: effective.reason, dir });
    console.log(`  REVIEW_REQUIRED reason=${effective.reason}${messageId ? ` sent=${messageId}` : ''}`);
    console.log(`  REVIEW_DIR ${dir}`);
    if (SEND && !REVIEW_CHAT_ID) console.log('  REVIEW_CREDENTIALS_MISSING');
    if (sendError) console.log(`  REVIEW_SEND_FAILED ${redact(sendError)}`);
    await saveState(STATE_PATH, state);
    return dir;
  }

  for (const candidate of relevantCandidates.slice(0, MAX_CANDIDATES)) {
    const label = `${candidate.sourceName} | ${candidate.title} | ${candidate.ageHours}h`;
    console.log(`ATTEMPT ${attempts.length + 1}/${Math.min(MAX_CANDIDATES, relevantCandidates.length)} ${label}`);

    let article;
    try {
      const page = await fetchText(candidate.link, { redact });
      article = extractArticle(page.text, candidate.title);
      article.url = page.url || candidate.link;
    } catch (error) {
      attempts.push({ title: candidate.title, result: 'fetch_failed', error: redact(error?.message) });
      console.log(`  FETCH_FAILED ${redact(error?.message)}`);
      continue;
    }

    const publishedAt = article.published || candidate.published;
    const gate = freshness(publishedAt, NOW, { maxAgeHours: config.freshness_hours.pre_gate });
    if (!gate.ok) {
      attempts.push({ title: candidate.title, result: `gate_${gate.reason}` });
      console.log(`  GATE_${gate.reason.toUpperCase()} ${gate.ageHours}h/${gate.maxAgeHours}h`);
      continue;
    }
    if (article.content.length < MIN_CONTENT) {
      attempts.push({ title: candidate.title, result: 'thin_content', chars: article.content.length });
      console.log(`  THIN_CONTENT ${article.content.length} chars`);
      continue;
    }

    const offer = detectOffer({ title: article.title || candidate.title, content: article.content });
    let offerAssessment = null;
    let offerContext = null;
    if (offer.isOffer) {
      offerAssessment = assessOffer({
        offer: { isOffer: true, title: article.title || candidate.title, content: article.content },
        sourceType: candidate.sourceType,
        publishedAt,
        now: NOW,
        config,
        quota,
        usage: offerUsage(state, NOW),
      });
      const reviewReasons = config.offers?.review?.reasons ?? [];
      if (
        offerAssessment.status === 'review' &&
        config.offers?.review?.enabled &&
        reviewReasons.includes(offerAssessment.reason)
      ) {
        await routeReview({ candidate, article, assessment: offerAssessment });
        continue;
      }
      if (offerAssessment.status !== 'publish') {
        markSeen(state, candidate.keys, {
          decision: 'offer_skip',
          reason: offerAssessment.reason,
          category: '',
          slot: slot.key,
          title: candidate.title,
          url: candidate.canonical,
        });
        attempts.push({ title: candidate.title, result: 'offer_skip', reason: offerAssessment.reason });
        console.log(`  OFFER_${offerAssessment.status.toUpperCase()} ${offerAssessment.reason}`);
        continue;
      }
      offerContext = {
        detected: true,
        date: offerAssessment.expiry.date,
        remainingHours: offerAssessment.expiry.remainingHours,
        expiry: offerAssessment.expiry,
        minRemainingHours: config.offers.min_remaining_hours,
      };
      console.log(`  OFFER eligible | expires ${offerAssessment.expiry.date} | ${offerAssessment.expiry.remainingHours}h left`);
    }

    const rawImage = article.imageUrl || candidate.images[0] || '';
    const verdict = imageVerdict(rawImage, article.imageAlt);
    const imageUrl = verdict.ok ? rawImage : '';
    const host = (() => {
      try {
        return new URL(article.url).hostname;
      } catch {
        return '';
      }
    })();

    const story = {
      item: { title: candidate.title, published: candidate.published },
      article,
      url: article.url,
      now: NOW,
      imageUrl,
      maxAgeHours: offerContext ? config.offers.max_age_hours : config.freshness_hours.pre_gate,
      offer: offerContext,
    };
    const user = buildUserMessage(story);
    console.log(`  MODEL ${PRIMARY.model} | image ${imageUrl ? 'allowed' : verdict.reason}`);

    let writer = PRIMARY;
    let activeUser = user;
    let call = await callWithRetry(writerOptions(writer, activeUser), 4, console.log);
    let retry = null;
    let parsed = extractJson(call.content);
    if (!parsed) {
      console.log('  invalid JSON, one corrective retry');
      const corrective = `${activeUser}\n\nخروجی قبلی JSON معتبر نبود. فقط یک آبجکت JSON معتبر بده.`;
      retry = await callWithRetry(writerOptions(writer, corrective), 2, console.log);
      parsed = extractJson(retry.content);
    }
    let fallback = null;

    if (!parsed && FALLBACK_ENABLED && !fallbackSpent) {
      fallbackSpent = true;
      const primaryUsage = usageOf(call);
      const retryUsage = usageOf(retry);
      totalCost += primaryUsage.cost + retryUsage.cost;
      totalTokens += primaryUsage.tokens + retryUsage.tokens;
      console.log(`  FALLBACK ${FALLBACK.model} reason=primary_invalid_json chars=${FALLBACK.maxContentChars}`);
      writer = FALLBACK;
      activeUser = buildUserMessage({ ...story, maxContentChars: FALLBACK.maxContentChars });
      call = await callWithRetry(writerOptions(writer, activeUser), 2, console.log, [45000]);
      retry = null;
      parsed = extractJson(call.content);
      if (!parsed) {
        const corrective = `${activeUser}\n\nخروجی قبلی JSON معتبر نبود. فقط یک آبجکت JSON معتبر بده.`;
        retry = await callWithRetry(writerOptions(writer, corrective), 2, console.log, [45000]);
        parsed = extractJson(retry.content);
      }
      fallback = { used: true, model: FALLBACK.model, parsed: Boolean(parsed) };
      if (!parsed) console.log('  FALLBACK_INVALID_JSON');
    }

    const raw = retry || call;
    const usage = raw.usage ?? {};
    let cost = usageOf(call).cost + usageOf(retry).cost;
    let tokens = usageOf(call).tokens + usageOf(retry).tokens;
    totalCost += cost;
    totalTokens += tokens;

    if (!parsed) {
      attempts.push({ title: candidate.title, result: 'invalid_json', writer: writer.role, cost, tokens });
      markSeen(state, candidate.keys, {
        decision: 'invalid_json',
        category: '',
        slot: slot.key,
        title: candidate.title,
        url: candidate.canonical,
      });
      console.log(`  INVALID_JSON writer=${writer.role} cost $${cost.toFixed(6)}`);
      continue;
    }

    console.log(`  WRITER ${writer.role} model=${writer.model}`);
    parsed = normalizePostFields(parsed);

    const newsDate = newsDateLine(publishedAt);
    const qaContext = {
      url: article.url,
      host,
      sourceType: candidate.sourceType,
      category: parsed.category,
      imageUrl,
      title: article.title,
      description: article.description,
      content: article.content,
      publishedAt,
      now: NOW,
      offer: offerContext,
      previousWhy,
    };
    let qa = qaPost(parsed, qaContext);
    let repair = null;

    const offerQaFailed = Boolean(offerContext) && qa.problems.some((problem) => problem.startsWith('offer_'));
    const relevanceFailed = qa.problems.includes('ai_relevance');
    const styleWarning = qa.warnings.includes('formal_verbs') || qa.warnings.includes('why_repeat');
    if (parsed.decision === 'publish' && (!qa.pass || styleWarning) && !offerQaFailed && !relevanceFailed && !offerContext) {
      console.log(`  ${qa.pass ? 'STYLE_WARNING' : 'QA_FAILED'} ${qa.problems.join(',') || qa.warnings.join(',')} | one repair retry`);
      repair = await callWithRetry(
        writerOptions(writer, buildQaRepairMessage({ user: activeUser, parsed, qa, imageUrl, previousWhy, newsDate })),
        2,
        console.log
      );
      const repairUsage = repair.usage ?? {};
      const repairCost = Number(repairUsage.cost) || 0;
      const repairTokens = Number(repairUsage.total_tokens) || 0;
      cost += repairCost;
      tokens += repairTokens;
      totalCost += repairCost;
      totalTokens += repairTokens;
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
        console.log(`  REPAIR_QA ${qa.pass ? 'PASS' : 'FAIL'} | score ${qa.score}/${qa.possible} | problems ${qa.problems.join(',') || 'none'} | warnings ${qa.warnings.join(',') || 'none'}${better ? '' : ' | kept original'}`);
      } else {
        console.log('  REPAIR_INVALID_JSON');
      }
    }

    if (parsed.decision === 'skip') {
      attempts.push({ title: candidate.title, result: 'model_skip', reason: parsed.reason, cost, tokens });
      markSeen(state, candidate.keys, {
        decision: 'skip',
        reason: parsed.reason_code || '',
        category: '',
        slot: slot.key,
        title: candidate.title,
        url: candidate.canonical,
      });
      console.log(`  MODEL_SKIP ${parsed.reason_code || '-'} | ${String(parsed.reason || '').slice(0, 120)}`);
      continue;
    }

    if (!qa.pass) {
      if (offerContext && qa.problems.some((problem) => problem.startsWith('offer_'))) {
        await routeReview({
          candidate,
          article,
          assessment: { ...offerAssessment, origin: 'qa_failed' },
          reason: 'offer_qa_failed',
        });
        console.log(`  QA_FAILED ${qa.problems.join(',')} | score ${qa.score}/${qa.possible}`);
        continue;
      }
      attempts.push({ title: candidate.title, result: 'qa_failed', problems: qa.problems, cost, tokens });
      markSeen(state, candidate.keys, {
        decision: 'qa_failed',
        reason: qa.problems.join(','),
        category: parsed.category || '',
        slot: slot.key,
        title: candidate.title,
        url: candidate.canonical,
      });
      console.log(`  QA_FAILED ${qa.problems.join(',')} | score ${qa.score}/${qa.possible}`);
      continue;
    }

    const category = parsed.category;
    if (!MAIN_CATEGORIES.includes(category)) {
      attempts.push({ title: candidate.title, result: 'bad_category', category, cost, tokens });
      console.log(`  BAD_CATEGORY ${category}`);
      continue;
    }
    if (quota[category].remaining <= 0) {
      attempts.push({ title: candidate.title, result: 'quota_full', category, cost, tokens });
      markSeen(state, candidate.keys, {
        decision: 'quota',
        category,
        slot: slot.key,
        title: candidate.title,
        url: candidate.canonical,
      });
      console.log(`  QUOTA_FULL ${category}`);
      continue;
    }

    const dir = outboxDir(slot.key);
    await mkdir(dir, { recursive: true });
    let downloaded = null;
    let downloadError = '';
    if (parsed.image_url) {
      try {
        downloaded = await downloadImage(parsed.image_url, dir);
      } catch (error) {
        downloadError = redact(error?.message);
      }
    }

    const post = {
      title: String(parsed.title).trim(),
      news_date: newsDate,
      body: String(parsed.body).trim(),
      quote: String(parsed.quote ?? '').trim(),
    };
    const postFile = resolve(dir, 'post.txt');
    const caption = captionLength(post);
    const report = {
      slot: slot.key,
      week,
      mode: RUN_MODE,
      source: { id: candidate.sourceId, name: candidate.sourceName, url: article.url },
      item: { title: article.title, published_at: publishedAt, age_hours: gate.ageHours },
      category,
      offer: offerContext ? {
        detected: true,
        expiry: offerContext.expiry,
        remaining_hours: offerContext.remainingHours,
        usage: offerUsage(state, NOW),
      } : null,
      image: {
        candidate: rawImage,
        verdict,
        used_url: downloaded ? parsed.image_url : '',
        file: downloaded?.file ?? '',
        error: downloadError,
      },
      model: {
        name: writer.model,
        role: writer.role,
        fallback,
        status: raw.status,
        ms: raw.ms,
        attempts: call.attempts + (retry?.attempts ?? 0) + (repair?.attempts ?? 0),
        finish: raw.finish,
        json_retry: Boolean(retry),
        qa_repair: Boolean(repair),
        usage,
        cost,
        tokens,
      },
      qa,
      post: {
        title: post.title,
        news_date: post.news_date,
        body: post.body,
        quote: post.quote,
        caption_chars: caption,
        quote_chars: post.quote.length,
        dedupe_key: parsed.dedupe_key,
      },
      attempts,
    };

    await writeFile(resolve(dir, 'post.json'), JSON.stringify({
      slot: slot.key,
      mode: RUN_MODE,
      category,
      title: post.title,
      news_date: post.news_date,
      body: post.body,
      quote: post.quote,
      image_url: downloaded ? parsed.image_url : '',
      image_file: downloaded?.file ?? '',
      source_url: article.url,
      source_name: candidate.sourceName,
      dedupe_key: parsed.dedupe_key,
      post_type: parsed.post_type,
      importance: parsed.importance,
      verification: parsed.verification,
      offer: offerContext ? { expiry: offerContext.expiry.date, remaining_hours: offerContext.remainingHours } : null,
      qa: { pass: qa.pass, score: qa.score, possible: qa.possible, warnings: qa.warnings },
      createdAt: NOW,
    }, null, 2));
    await writeFile(postFile, `${[postText(post), post.quote].filter(Boolean).join('\n\n')}\n`);
    await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(
      resolve(dir, 'response.txt'),
      [call.content, retry ? `--- JSON RETRY ---\n\n${retry.content}` : '', repair ? `--- QA REPAIR ---\n\n${repair.content}` : '']
        .filter(Boolean)
        .join('\n\n')
    );
    await writeFile(
      resolve(dir, 'preview.html'),
      renderPreview({
        post,
        qa,
        imageUsed: Boolean(downloaded),
        imagePath: downloaded ? `image.${downloaded.ext}` : '',
        imageVerdict: downloaded ? '' : downloadError || verdict.reason,
        sourceUrl: article.url,
        banner: SEND
          ? 'خروجی ارسال واقعی — وضعیت در گزارش ثبت شده است'
          : 'اجرای خشک محلی — هیچ چیزی به تلگرام ارسال نشده است',
      })
    );

    let status = 'ready';
    let messageId = null;
    if (SEND) {
      try {
        const sent = await sendTelegram(post, {
          token: env.TELEGRAM_BOT_TOKEN,
          chatId: CHAT_ID,
          imagePath: downloaded?.file ?? '',
        });
        status = 'sent';
        messageId = sent.messageId;
        if (sent.quoteError) console.log(`  QUOTE_FAILED ${redact(sent.quoteError)}`);
      } catch (error) {
        status = 'ready';
        markSlot(state, slot.key, {
          status,
          category,
          title: post.title,
          postDir: dir,
          error: String(error?.message ?? error),
        });
        markSeen(state, candidate.keys, {
          decision: 'publish',
          category,
          slot: slot.key,
          title: candidate.title,
          url: candidate.canonical,
        });
        await saveState(STATE_PATH, state);
        console.log(`SEND_FAILED ${String(error?.message ?? error)}`);
        console.log(`OUTBOX ${dir}`);
        console.log('NOTHING_WAS_SENT');
        process.exit(1);
      }
    }

    markSlot(state, slot.key, {
      status,
      category,
      title: post.title,
      postDir: dir,
      messageId,
      mode: RUN_MODE,
    });
    markSeen(state, candidate.keys, {
      decision: 'publish',
      category,
      slot: slot.key,
      title: candidate.title,
      url: candidate.canonical,
    });
    recordPublished(state, {
      slot: slot.key,
      category,
      title: post.title,
      dedupeKey: parsed.dedupe_key,
      postKey: `${slot.date}/${slot.slot.replace(':', '-')}`,
      kind: offerContext ? 'offer' : 'news',
      why: importanceOf(parsed.body),
    });
    pruneState(state, NOW);
    await saveState(STATE_PATH, state);

    published = { post, category, dir, status, messageId, cost, tokens, qa, image: Boolean(downloaded), offer: Boolean(offerContext) };
    break;
  }

  if (!published) {
    markSlot(state, slot.key, { status: 'empty', reason: 'all_candidates_rejected' });
    pruneState(state, NOW);
    await saveState(STATE_PATH, state);
    console.log(`RESULT EMPTY attempts=${attempts.length} reviews=${reviews} | cost $${totalCost.toFixed(6)} | tokens ${totalTokens}`);
    console.log('NOTHING_WAS_SENT');
    return;
  }

  console.log(`RESULT ${published.status === 'sent' ? 'SENT' : 'READY'} category=${published.category} | offer=${published.offer ? 'yes' : 'no'} | image=${published.image ? 'yes' : 'no'} | QA ${published.qa.score}/${published.qa.possible} | cost $${published.cost.toFixed(6)} | tokens ${published.tokens}`);
  console.log(`TITLE ${published.post.title}`);
  console.log(`OUTBOX ${published.dir}`);
  console.log(SEND ? (REVIEW_SEND ? 'SENT_TO_REVIEW' : 'SENT_TO_TELEGRAM') : 'DRY_RUN — NOTHING_WAS_SENT');
}

await main();
