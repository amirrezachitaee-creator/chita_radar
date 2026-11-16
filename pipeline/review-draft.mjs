import {
  applyLeadPolicy,
  applyMechanicalFixes,
  buildUserMessage,
  extractJson,
  imageVerdict,
  pickToolUsageLink,
  qaPost,
  TITLE_QA_PROBLEMS,
} from './engine.mjs';
import { newsDateLine } from './newstime.mjs';

export function candidateFromItem(item) {
  const type = String(item?.sourceType ?? '');
  return {
    title: String(item?.title ?? ''),
    published: String(item?.publishedAt ?? ''),
    messageText: String(item?.messageText ?? ''),
    images: Array.isArray(item?.images) ? item.images : [],
    link: String(item?.url ?? ''),
    canonical: String(item?.url ?? ''),
    leadPostUrl: String(item?.leadPostUrl ?? ''),
    sourceName: String(item?.sourceName ?? ''),
    sourceType:
      type || (String(item?.source ?? '').startsWith('tg-') ? 'telegram_channel' : ''),
    relatedLinks: Array.isArray(item?.relatedLinks) ? item.relatedLinks : [],
    keys: Array.isArray(item?.keys) ? item.keys : [],
    toolHint: item?.toolHint === true,
    offerHint: item?.offerHint === true,
    rumorHint: item?.rumorHint === true,
    benchmark: item?.benchmark === true,
    policy: item?.policy === true,
    officialCourse: false,
    educationHint: false,
  };
}

export function offerContextFromItem(item, config = {}) {
  if (item?.kind !== 'offer') return null;
  const expiry = item?.expiry;
  if (!expiry) {
    return {
      detected: true,
      openEnded: true,
      note: String(config?.offers?.no_expiry_note ?? ''),
      date: '',
      remainingHours: null,
      expiry: null,
      minRemainingHours: Number(config?.offers?.min_remaining_hours ?? 24) || 24,
    };
  }
  return {
    detected: true,
    openEnded: expiry.openEnded === true || !expiry.date,
    note: String(config?.offers?.no_expiry_note ?? ''),
    date: String(expiry.date ?? ''),
    remainingHours: Number.isFinite(Number(expiry.remainingHours)) ? Number(expiry.remainingHours) : null,
    expiry,
    minRemainingHours: Number(config?.offers?.min_remaining_hours ?? 24) || 24,
  };
}

export function resolvedImageUrl(item) {
  const raw = String(item?.imageUrl || item?.images?.[0] || '');
  return imageVerdict(raw, '').ok ? raw : '';
}

export function externalUrlForItem(item) {
  const raw = String(item?.url || item?.leadPostUrl || '');
  if (!raw) return '';
  try {
    const host = new URL(raw).hostname;
    if (/^(?:t\.me|telegram\.me|telegram\.dog)$/i.test(host)) return '';
    return raw;
  } catch {
    return '';
  }
}

function noteLinks(text) {
  const links = [];
  for (const match of String(text ?? '').matchAll(/https?:\/\/[^\s)\]>«»"]+/g)) {
    const value = match[0].replace(/[.,،؛!؟]+$/u, '');
    try {
      const parsed = new URL(value);
      if (!/^https?:$/.test(parsed.protocol)) continue;
      if (/^(?:t\.me|telegram\.me|telegram\.dog)$/i.test(parsed.hostname)) continue;
      if (!links.includes(value)) links.push(value);
    } catch {
      // not a usable link
    }
    if (links.length >= 8) break;
  }
  return links;
}

export function noteLinksForItem(item) {
  return noteLinks(item?.note);
}

export function toolUsageForItem(item) {
  const sourceUrl = String(item?.url || item?.leadPostUrl || '');
  if (!sourceUrl) return null;
  return pickToolUsageLink({
    article: {
      title: String(item?.title ?? ''),
      description: '',
      content: String(item?.messageText ?? ''),
      links: (Array.isArray(item?.relatedLinks) ? item.relatedLinks : []).map((url) => ({
        url: String(url),
        text: '',
      })),
    },
    sourceUrl,
    sourceType: String(item?.sourceType ?? ''),
    offer: item?.kind === 'offer',
  });
}

export function qaContextForItem(item, post, now, config = {}, usageUrl = '', options = {}) {
  const url = String(item?.url || item?.leadPostUrl || '');
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const manual = options.manual === true || item?.manual === true;
  const noSource = manual && !externalUrlForItem(item) && !usageUrl;
  const note = String(item?.note ?? '').trim().slice(0, 2000);
  const baseOffer = offerContextFromItem(item, config);
  const offer = manual && baseOffer?.openEnded
    ? { ...baseOffer, note: String(config?.offers?.manual_no_expiry_note ?? baseOffer.note) }
    : baseOffer;
  return {
    url,
    host,
    sourceType: String(item?.sourceType ?? ''),
    category: String(post?.category ?? ''),
    imageUrl: options.imageUrl !== undefined ? options.imageUrl : resolvedImageUrl(item),
    title: String(item?.title ?? ''),
    description: '',
    content: [String(item?.messageText ?? ''), note].filter(Boolean).join('\n\n'),
    links: [...(Array.isArray(item?.relatedLinks) ? item.relatedLinks : []), ...noteLinks(note)],
    usageUrl,
    publishedAt: String(item?.publishedAt ?? ''),
    now,
    newsDate: newsDateLine(item?.publishedAt),
    policy: item?.policy === true,
    offer,
    officialResolved: item?.kind === 'offer',
    manual,
    noSource,
  };
}

export async function draftReviewPost({
  item,
  now,
  minChars = 320,
  maxAgeHours = 72,
  config = {},
  manual = false,
  request,
  repairPost = null,
  repairTitle = null,
  log = () => {},
} = {}) {
  const content = String(item?.messageText ?? '').trim();
  const note = String(item?.note ?? '').trim().slice(0, 2000);
  const minimum = manual ? 1 : Math.max(0, Number(minChars) || 0);
  if (content.length < minimum) {
    return { post: null, qa: null, reason: 'short' };
  }
  if (!manual && item?.kind === 'offer' && !item?.expiry) {
    return { post: null, qa: null, reason: 'offer_context_missing' };
  }
  const candidate = candidateFromItem(item);
  const imageUrl = resolvedImageUrl(item);
  const article = {
    title: item?.title || '',
    description: '',
    published: item?.publishedAt || '',
    modified: '',
    imageUrl,
    imageAlt: '',
    content,
    url: item?.url || item?.leadPostUrl || '',
    links: (Array.isArray(item?.relatedLinks) ? item.relatedLinks : []).map((url) => ({
      url: String(url),
      text: '',
    })),
  };
  const nowLine = newsDateLine(item?.publishedAt);
  const baseOffer = offerContextFromItem(item, config);
  const toolUsage = toolUsageForItem(item);
  const noSource = manual && !externalUrlForItem(item) && !toolUsage?.url;
  const offer = manual && baseOffer?.openEnded
    ? { ...baseOffer, note: String(config?.offers?.manual_no_expiry_note ?? baseOffer.note) }
    : baseOffer;
  const story = {
    item: { title: item?.title, published: item?.publishedAt },
    article,
    url: article.url,
    now,
    imageUrl,
    maxAgeHours: Number(maxAgeHours) || 72,
    offer,
    benchmark: item?.benchmark === true,
    policy: item?.policy === true,
    toolUrl: toolUsage?.url ?? '',
    manual,
    noSource,
    note,
  };
  if (typeof request !== 'function') throw new Error('REVIEW_DRAFT_REQUEST_MISSING');
  const call = await request(story);
  const usage = call?.usage ?? {};
  let cost = Number(usage.cost ?? 0) || 0;
  let tokens = Number(usage.total_tokens ?? 0) || 0;
  if (!call?.content) {
    return {
      post: null,
      qa: null,
      reason: 'model_failed',
      detail: [call?.status ? `status ${call.status}` : '', call?.error]
        .filter(Boolean)
        .join(': ')
        .slice(0, 240),
      cost,
      tokens,
    };
  }
  const parsed = extractJson(call.content);
  if (!parsed) return { post: null, qa: null, reason: 'model_failed', detail: 'invalid_json', cost, tokens };
  if (parsed.decision === 'skip') {
    return {
      post: null,
      qa: null,
      reason: 'model_skip',
      detail: String(parsed.reason ?? '').slice(0, 300),
      cost,
      tokens,
    };
  }
  const prepared = manual && !String(parsed.source_url ?? '').trim() && article.url
    ? { ...parsed, source_url: article.url }
    : parsed;
  const finalize = (value) =>
    applyMechanicalFixes(applyLeadPolicy(value, candidate), {
      sourceName: item?.sourceName,
      sourceUrl: article.url,
      usageUrl: toolUsage?.url ?? '',
      usageName: toolUsage?.name ?? '',
      imageUrl,
      newsDate: nowLine,
      sourceType: candidate.sourceType,
      openEnded: manual && offer?.openEnded === true,
      noExpiryNote: manual && offer?.openEnded ? offer.note : '',
    });
  let fixed = finalize(prepared);
  let qa = qaPost(
    fixed,
    qaContextForItem(item, fixed, now, config, toolUsage?.url ?? '', { manual })
  );
  const contentRejected = qa.problems.includes('ai_relevance') || qa.problems.includes('category_fresh');
  const offerProblem = qa.problems.some((problem) => problem.startsWith('offer_'));
  const onlyTitle = qa.problems.length > 0 && qa.problems.every((problem) => TITLE_QA_PROBLEMS.has(problem));
  if (!qa.pass && !contentRejected && !offerProblem && !onlyTitle && typeof repairPost === 'function') {
    log(`REVIEW_QA_REPAIR ${qa.problems.join(',') || 'none'} | one repair retry`);
    let repair = null;
    try {
      repair = await repairPost({ story, parsed: fixed, qa });
    } catch (error) {
      log(`REVIEW_QA_REPAIR_FAILED ${String(error?.message ?? error).slice(0, 240)}`);
    }
    const repairUsage = repair?.usage ?? {};
    cost += Number(repairUsage.cost ?? 0) || 0;
    tokens += Number(repairUsage.total_tokens ?? 0) || 0;
    const repaired = extractJson(repair?.content);
    if (repaired) {
      const repairedFixed = finalize(repaired);
      const repairedQa = qaPost(
        repairedFixed,
        qaContextForItem(item, repairedFixed, now, config, toolUsage?.url ?? '', { manual })
      );
      const better =
        (repairedQa.pass && !qa.pass) ||
        (repairedQa.pass === qa.pass &&
          (repairedQa.problems.length < qa.problems.length ||
            (repairedQa.problems.length === qa.problems.length &&
              (repairedQa.warnings.length < qa.warnings.length ||
                (repairedQa.warnings.length === qa.warnings.length && repairedQa.score >= qa.score)))));
      if (better) {
        fixed = repairedFixed;
        qa = repairedQa;
      }
      log(
        `REVIEW_QA_REPAIR_QA ${qa.pass ? 'PASS' : 'FAIL'} | problems ${
          qa.problems.join(',') || 'none'
        } | ${better ? 'applied' : 'kept original'}`
      );
    } else {
      log('REVIEW_QA_REPAIR_INVALID_JSON');
    }
  }
  const titleProblems = qa.problems.filter((problem) => TITLE_QA_PROBLEMS.has(problem));
  const rejectedNow = qa.problems.includes('ai_relevance') || qa.problems.includes('category_fresh');
  if (!qa.pass && titleProblems.length && !rejectedNow && typeof repairTitle === 'function') {
    log(`REVIEW_TITLE_REPAIR ${titleProblems.join(',')} | focused retry`);
    let repair = null;
    try {
      repair = await repairTitle({ story, parsed: fixed, qa });
    } catch (error) {
      log(`REVIEW_TITLE_REPAIR_FAILED ${String(error?.message ?? error).slice(0, 240)}`);
    }
    const repairUsage = repair?.usage ?? {};
    cost += Number(repairUsage.cost ?? 0) || 0;
    tokens += Number(repairUsage.total_tokens ?? 0) || 0;
    const nextTitle = String(extractJson(repair?.content)?.title ?? '').trim();
    if (nextTitle) {
      const merged = finalize({ ...fixed, title: nextTitle });
      const mergedQa = qaPost(
        merged,
        qaContextForItem(item, merged, now, config, toolUsage?.url ?? '', { manual })
      );
      const remaining = mergedQa.problems.filter((problem) => TITLE_QA_PROBLEMS.has(problem)).length;
      const better = mergedQa.pass || remaining < titleProblems.length;
      if (better) {
        fixed = merged;
        qa = mergedQa;
      }
      log(
        `REVIEW_TITLE_REPAIR_QA ${qa.pass ? 'PASS' : 'FAIL'} | title_problems ${remaining} | ${better ? 'applied' : 'kept original'}`
      );
    } else {
      log('REVIEW_TITLE_REPAIR_INVALID_JSON');
    }
  }
  log(
    `REVIEW_REWRITE_QA ${qa.pass ? 'PASS' : 'FAIL'} ${qa.problems.join(',') || 'none'} | $${cost.toFixed(6)}`
  );
  return { post: fixed, qa, reason: qa.pass ? 'ok' : 'qa_failed', cost, tokens };
}
