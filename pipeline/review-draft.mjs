import {
  applyLeadPolicy,
  applyMechanicalFixes,
  buildUserMessage,
  extractJson,
  imageVerdict,
  qaPost,
} from './engine.mjs';
import { newsDateLine } from './newstime.mjs';

export function candidateFromItem(item) {
  return {
    title: String(item?.title ?? ''),
    published: String(item?.publishedAt ?? ''),
    messageText: String(item?.messageText ?? ''),
    images: Array.isArray(item?.images) ? item.images : [],
    link: String(item?.url ?? ''),
    canonical: String(item?.url ?? ''),
    leadPostUrl: String(item?.leadPostUrl ?? ''),
    sourceName: String(item?.sourceName ?? ''),
    sourceType: String(item?.sourceType ?? ''),
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

export function qaContextForItem(item, post, now, config = {}) {
  const url = String(item?.url || item?.leadPostUrl || '');
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  return {
    url,
    host,
    sourceType: String(item?.sourceType ?? ''),
    category: String(post?.category ?? ''),
    imageUrl: resolvedImageUrl(item),
    title: String(item?.title ?? ''),
    description: '',
    content: String(item?.messageText ?? ''),
    links: Array.isArray(item?.relatedLinks) ? item.relatedLinks : [],
    usageUrl: '',
    publishedAt: String(item?.publishedAt ?? ''),
    now,
    newsDate: newsDateLine(item?.publishedAt),
    policy: item?.policy === true,
    offer: offerContextFromItem(item, config),
    officialResolved: item?.kind === 'offer',
  };
}

export async function draftReviewPost({
  item,
  now,
  minChars = 320,
  maxAgeHours = 72,
  config = {},
  request,
  log = () => {},
} = {}) {
  const content = String(item?.messageText ?? '').trim();
  if (content.length < Math.max(0, Number(minChars) || 0)) {
    return { post: null, qa: null, reason: 'short' };
  }
  if (item?.kind === 'offer' && !item?.expiry) {
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
  };
  const nowLine = newsDateLine(item?.publishedAt);
  const offer = offerContextFromItem(item, config);
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
    toolUrl: item?.relatedLinks?.[0] ?? '',
  };
  if (typeof request !== 'function') throw new Error('REVIEW_DRAFT_REQUEST_MISSING');
  const call = await request(story);
  const usage = call?.usage ?? {};
  const cost = Number(usage.cost ?? 0) || 0;
  const tokens = Number(usage.total_tokens ?? 0) || 0;
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
  const fixed = applyMechanicalFixes(applyLeadPolicy(parsed, candidate), {
    sourceName: item?.sourceName,
    sourceUrl: article.url,
    imageUrl,
    newsDate: nowLine,
    sourceType: item?.sourceType,
  });
  const qa = qaPost(fixed, qaContextForItem(item, fixed, now, config));
  log(
    `REVIEW_REWRITE_QA ${qa.pass ? 'PASS' : 'FAIL'} ${qa.problems.join(',') || 'none'} | $${cost.toFixed(6)}`
  );
  return { post: fixed, qa, reason: qa.pass ? 'ok' : 'qa_failed', cost, tokens };
}
