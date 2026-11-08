import { dateKey, slotDateKey, tehranParts, weekKey } from './store.mjs';

const STRONG_OFFER = [
  /\bfree\s+(?:api\s+)?(?:credits?|tier|plan|trial|access|usage|quota|tokens?|month|year)\b/i,
  /\bfree\s+(?:inference|endpoints?|hosting|compute|gpus?|gpu\s+hours?)\b/i,
  /\bfree\s+for\s+(?:a\s+)?(?:limited\s+time|\d+\s+(?:days?|weeks?|months?))\b/i,
  /\bno[- ]cost\b/i,
  /\b(?:no|without)\s+(?:a\s+)?(?:credit|bank|debit)\s+card\b/i,
  /\bon[- ]us\b/i,
  /\bpromo(?:tion(?:al)?)?\b/i,
  /\bcoupon\b/i,
  /\bdiscount\b/i,
  /\bgiveaway\b/i,
  /\b(?:credits?|tokens?)\s+(?:worth|for)\b/i,
  /\bfree\s+trial\b/i,
  /\bwaiv(?:e|ed|er)\b/i,
  /\bcomplimentary\s+(?:access|credits?|tokens?|plan)\b/i,
  /رایگان/,
  /اعتبار\s+رایگان/,
  /بدون\s+(?:نیاز\s+به\s+)?کارت\s+بانکی/,
  /کد\s*تخفیف/,
  /تخفیف/,
  /ترایال/,
  /فرصت\s+محدود/,
];

const EXPIRY_CUE =
  /\b(?:expir(?:e|es|ation|ing)|valid\s+(?:until|through|till)|ends?(?:\s+on)?|deadline|offer\s+ends?|available\s+until|until|through|last\s+day|no\s+later\s+than)\b|معتبر\s*تا|تا\s*تاریخ|پایان|منقضی/i;

const MONTHS = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const MONTH_NAMES_FA = [
  'ژانویه', 'فوریه', 'مارس', 'آوریل', 'مه', 'ژوئن',
  'ژوئیه', 'اوت', 'سپتامبر', 'اکتبر', 'نوامبر', 'دسامبر',
];
const MONTH_NAMES_EN = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const REFERRAL = /(?:[?&](?:ref|referral|aff|affiliate|via|partner|promo)=|\baffiliate\b|\breferral\s+(?:link|code|program)\b)/i;

const pad = (value) => String(value).padStart(2, '0');

export function offerHint(text) {
  const value = String(text ?? '');
  return STRONG_OFFER.some((pattern) => pattern.test(value));
}

export function expiryHint(text) {
  return EXPIRY_CUE.test(String(text ?? ''));
}

export function hasReferral(text) {
  return REFERRAL.test(String(text ?? ''));
}

export function detectOffer({ title = '', content = '' } = {}) {
  const titleHits = STRONG_OFFER.filter((pattern) => pattern.test(title)).map((pattern) => pattern.source);
  const contentHits = STRONG_OFFER.filter((pattern) => pattern.test(content)).map((pattern) => pattern.source);
  const isOffer =
    titleHits.length > 0 ||
    contentHits.length >= 2 ||
    (contentHits.length >= 1 && EXPIRY_CUE.test(content));
  return {
    isOffer,
    hits: [...new Set([...titleHits, ...contentHits])].slice(0, 5),
    titleHits: titleHits.length,
    contentHits: contentHits.length,
  };
}

function validDate(year, month, day, evidence) {
  if (!month || !day) return null;
  if (!year) return { date: '', year: 0, month, day, evidence };
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    year,
    month,
    day,
    evidence,
  };
}

function monthIndex(name) {
  return MONTHS[String(name ?? '').toLowerCase().replace(/\.$/, '')] ?? 0;
}

function datesInSentence(sentence) {
  const found = [];
  const occupied = [];

  const overlaps = (start, end) => occupied.some(([from, to]) => start < to && end > from);
  const push = (match, value) => {
    if (!value) return;
    found.push({ ...value, index: match.index });
    occupied.push([match.index, match.index + match[0].length]);
  };

  for (const match of sentence.matchAll(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/g)) {
    push(match, validDate(Number(match[1]), Number(match[2]), Number(match[3]), match[0]));
  }

  const monthFirst = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi;
  for (const match of sentence.matchAll(monthFirst)) {
    if (overlaps(match.index, match.index + match[0].length)) continue;
    push(match, validDate(match[3] ? Number(match[3]) : 0, monthIndex(match[1]), Number(match[2]), match[0]));
  }

  const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?(?:,?\s+(20\d{2}))?\b/gi;
  for (const match of sentence.matchAll(dayFirst)) {
    if (overlaps(match.index, match.index + match[0].length)) continue;
    push(match, validDate(match[3] ? Number(match[3]) : 0, monthIndex(match[2]), Number(match[1]), match[0]));
  }

  let ambiguous = '';
  for (const match of sentence.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/g)) {
    if (overlaps(match.index, match.index + match[0].length)) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = Number(match[3]);
    let day;
    let month;
    if (first > 12 && second <= 12) {
      day = first;
      month = second;
    } else if (second > 12 && first <= 12) {
      month = first;
      day = second;
    } else {
      ambiguous = match[0];
      continue;
    }
    push(match, validDate(year, month, day, match[0]));
  }

  return { dates: found, ambiguous };
}

function withYear(value, now) {
  if (value.year) return value;
  const today = tehranParts(now);
  let year = today.year;
  const candidate = Date.UTC(year, value.month - 1, value.day);
  const todayMs = Date.UTC(today.year, today.month - 1, today.day);
  if (candidate < todayMs) year += 1;
  return validDate(year, value.month, value.day, value.evidence);
}

export function extractExpiry(text, now) {
  const nowMs = now instanceof Date
    ? now.getTime()
    : typeof now === 'number'
      ? now
      : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');

  const sentences = String(text ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => EXPIRY_CUE.test(sentence));

  const dates = [];
  let ambiguous = '';
  for (const sentence of sentences) {
    const parsed = datesInSentence(sentence);
    for (const value of parsed.dates) {
      const complete = withYear(value, nowMs);
      if (!complete) continue;
      if (dates.some((existing) => existing.date === complete.date)) continue;
      dates.push(complete);
    }
    if (parsed.ambiguous) ambiguous = parsed.ambiguous;
  }

  if (dates.length === 0) {
    return {
      ok: false,
      reason: ambiguous ? 'expiry_ambiguous' : 'expiry_missing',
      date: '',
      remainingHours: null,
      evidence: ambiguous,
    };
  }

  const latest = dates.sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0];
  const endOfDayTehran = Date.UTC(latest.year, latest.month - 1, latest.day, 23, 59) - 210 * 60000;
  const remainingHours = Math.round(((endOfDayTehran - nowMs) / 36e5) * 10) / 10;

  if (remainingHours <= 0) {
    return {
      ok: false,
      reason: 'expiry_expired',
      date: latest.date,
      remainingHours,
      evidence: latest.evidence,
    };
  }

  return {
    ok: true,
    reason: 'ok',
    date: latest.date,
    remainingHours,
    evidence: latest.evidence,
    alternatives: dates.slice(1).map((value) => value.date),
  };
}

export function openEndedKey({ vendor = '', host = '' } = {}) {
  return String(vendor || host || '')
    .toLowerCase()
    .trim()
    .replace(/^www\./, '');
}

export function openEndedUsage(state, { key = '', now, days = 14 } = {}) {
  const entry = key ? state?.openOffers?.[key] : null;
  if (!entry) return { status: 'none', within: false, entry: null };
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const at = Date.parse(String(entry.publishedAt || entry.firstSeen || ''));
  const windowMs = Math.max(1, Number(days) || 14) * 86400000;
  return {
    status: String(entry.status || 'active'),
    within: Number.isFinite(at) && Number.isFinite(nowMs) && nowMs - at < windowMs,
    entry,
  };
}

export function recordOpenEnded(state, { key = '', vendor = '', url = '', title = '', at = '' } = {}) {
  const id = openEndedKey({ vendor: key || vendor });
  if (!id || !url) return null;
  const parsed = Date.parse(String(at));
  const iso = new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
  if (!state.openOffers || typeof state.openOffers !== 'object') state.openOffers = {};
  const previous = state.openOffers[id] ?? null;
  state.openOffers[id] = {
    key: id,
    vendor: String(vendor || ''),
    url: String(url),
    title: String(title || '').slice(0, 300),
    firstSeen: previous?.firstSeen || iso,
    publishedAt: iso,
    lastCheck: iso,
    status: 'active',
    misses: 0,
  };
  return state.openOffers[id];
}

export function markOpenEndedEnded(state, key, at = '') {
  const entry = state?.openOffers?.[openEndedKey({ vendor: key })];
  if (!entry) return null;
  const parsed = Date.parse(String(at));
  entry.status = 'ended';
  entry.endedAt = new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
  return entry;
}

export function offerUsage(state, now) {
  const today = dateKey(now);
  const week = weekKey(now);
  const offers = (state.published ?? []).filter((entry) => entry.kind === 'offer');
  return {
    today: offers.filter((entry) => slotDateKey(entry.slot) === today).length,
    week: offers.filter((entry) => entry.week === week).length,
  };
}

export function offerReviewUsage(states, now) {
  const today = dateKey(now);
  const entries = [];
  const seen = new Set();
  for (const state of states ?? []) {
    for (const entry of state?.offerReviews ?? []) {
      if (String(entry?.date ?? '') !== today) continue;
      const id = String(entry?.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      entries.push(entry);
    }
  }
  const perSource = new Map();
  for (const entry of entries) {
    const key = String(entry?.source ?? '');
    perSource.set(key, (perSource.get(key) ?? 0) + 1);
  }
  return { today: entries.length, perSource };
}

export function recordOfferReview(
  state,
  { source = '', title = '', url = '', reason = '', slot = '', at = '', mainEligible = false, kind = 'offer' }
) {
  if (!Array.isArray(state.offerReviews)) state.offerReviews = [];
  const parsed = Date.parse(String(at));
  const atMs = Number.isFinite(parsed) ? parsed : Date.now();
  const date = dateKey(atMs);
  const id = `${date}|${source}|${url || title}`;
  const entry = {
    id,
    date,
    at: new Date(atMs).toISOString(),
    source,
    title,
    url,
    reason,
    slot,
    kind,
    mainEligible: Boolean(mainEligible),
  };
  const index = state.offerReviews.findIndex((existing) => existing.id === id);
  if (index >= 0) state.offerReviews[index] = entry;
  else state.offerReviews.push(entry);
  return entry;
}

export const REVIEW_PENDING_TTL_HOURS = 240;

export function enqueueReviewPending(state, payload = {}) {
  if (!state.reviewPending || typeof state.reviewPending !== 'object') state.reviewPending = {};
  const at = payload.at || new Date().toISOString();
  const date = dateKey(at);
  const id = payload.id || `${date}|${payload.source || ''}|${payload.url || payload.title || ''}`;
  const previous = state.reviewPending[id];
  const entry = {
    ...previous,
    ...payload,
    id,
    queuedAt: previous?.queuedAt || at,
    attempts: Number(payload.attempts ?? previous?.attempts ?? 0),
  };
  if (!entry.text) return null;
  state.reviewPending[id] = entry;
  return entry;
}

export function listReviewPending(
  state,
  now,
  { ttlHours = REVIEW_PENDING_TTL_HOURS, limit = 0 } = {}
) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const entries = Object.values(state.reviewPending ?? {})
    .filter((entry) => {
      if (!entry || !entry.text) return false;
      const at = Date.parse(String(entry.queuedAt ?? ''));
      if (!Number.isFinite(at)) return false;
      if (nowMs - at > ttlHours * 3600000) return false;
      const expiry = String(entry?.expiry?.date ?? '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
        const end = Date.parse(`${expiry}T23:59:59+03:30`);
        if (Number.isFinite(end) && end < nowMs) return false;
      }
      return true;
    })
    .sort((left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt));
  return limit > 0 ? entries.slice(0, limit) : entries;
}

export function removeReviewPending(state, id) {
  if (!state.reviewPending?.[id]) return 0;
  delete state.reviewPending[id];
  return 1;
}

export function reviewCapacity({ config, usage, sourceKey = '' }) {
  const review = config?.offers?.review ?? {};
  if (review.enabled === false) return { ok: false, reason: 'review_disabled' };
  if (!usage) return { ok: true, reason: 'ok' };
  const maxDay = Number(review.max_per_day ?? 0);
  const maxSource = Number(review.max_per_source_per_day ?? 0);
  if (maxDay > 0 && usage.today >= maxDay) return { ok: false, reason: 'review_daily_cap' };
  if (maxSource > 0 && sourceKey && (usage.perSource?.get(sourceKey) ?? 0) >= maxSource) {
    return { ok: false, reason: 'review_source_cap' };
  }
  return { ok: true, reason: 'ok' };
}

export function assessOffer({
  offer,
  sourceType,
  sourceUrl = '',
  sourceKey = '',
  publishedAt,
  now,
  config,
  quota,
  usage,
  reviewUsage = null,
  officialResolved = false,
  vendorKey = '',
  openEnded = null,
}) {
  if (!offer?.isOffer) return { status: 'not_offer', reason: 'not_offer' };
  if (config.offers?.status !== 'active') return { status: 'skip', reason: 'offers_inactive' };

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const publishedMs = Date.parse(String(publishedAt ?? ''));
  if (!Number.isFinite(publishedMs)) return { status: 'skip', reason: 'offer_no_date' };
  const ageHours = Math.round(((nowMs - publishedMs) / 36e5) * 10) / 10;
  if (ageHours > Number(config.offers.max_age_hours ?? 24)) {
    return { status: 'skip', reason: 'offer_stale', ageHours };
  }

  const expiry = extractExpiry(
    `${offer.title ?? ''}\n${offer.content ?? ''}`,
    nowMs
  );

  if (expiry.reason === 'expiry_expired') {
    return { status: 'skip', reason: 'offer_expired', ageHours, expiry };
  }

  const reviewFor = (reason, extra = {}) => {
    const capacity = reviewCapacity({ config, usage: reviewUsage, sourceKey });
    if (!capacity.ok) {
      return { status: 'defer', reason, cap: capacity.reason, ageHours, expiry, ...extra };
    }
    return { status: 'review', reason, ageHours, expiry, ...extra };
  };

  const officialPage = sourceType === 'official_blog' || officialResolved === true;
  if (config.offers.official_source_only && !officialPage) {
    return reviewFor('source_not_official');
  }

  let openEndedPublish = false;
  if (config.offers.requires_expiry && !expiry.ok) {
    const canOpenEnded =
      config.offers.allow_no_expiry !== false &&
      expiry.reason === 'expiry_missing' &&
      officialPage &&
      Boolean(vendorKey);
    if (!canOpenEnded) return reviewFor(expiry.reason);
    if (openEnded?.within) {
      return { status: 'skip', reason: 'offer_vendor_repeat', ageHours, expiry, vendorKey };
    }
    openEndedPublish = true;
  }

  if (!openEndedPublish && expiry.ok && expiry.remainingHours < Number(config.offers.min_remaining_hours ?? 24)) {
    return reviewFor('expiry_soon');
  }

  const referral = hasReferral(sourceUrl) || REFERRAL.test(`${offer.title ?? ''}\n${offer.content ?? ''}`);
  if (config.offers.referral_allowed === false && referral) {
    return reviewFor('offer_referral', { referral: true });
  }

  if (!quota?.tools || quota.tools.remaining <= 0) {
    return reviewFor('offer_quota_full');
  }

  const limits = {
    today: Number(config.offers.max_per_day ?? 1),
    week: Number(config.offers.max_per_week ?? 3),
  };
  if (usage && usage.today >= limits.today) {
    return reviewFor('offer_daily_cap', { usage });
  }
  if (usage && usage.week >= limits.week) {
    return reviewFor('offer_weekly_cap', { usage });
  }

  return {
    status: 'publish',
    reason: openEndedPublish ? 'ok_no_expiry' : 'ok',
    openEnded: openEndedPublish,
    ageHours,
    expiry,
  };
}

export function dateMentioned(body, expiry) {
  if (!expiry?.year || !expiry?.month || !expiry?.day) return false;
  const text = String(body ?? '')
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
  const day = String(expiry.day);
  const year = String(expiry.year);
  const monthName = MONTH_NAMES_EN[expiry.month];
  const monthFa = MONTH_NAMES_FA[expiry.month - 1];

  if (text.includes(expiry.date)) return true;
  if (text.includes(`${year}/${pad(expiry.month)}/${pad(expiry.day)}`)) return true;
  if (text.includes(`${pad(expiry.day)}/${pad(expiry.month)}/${year}`)) return true;

  const hasDay = new RegExp(`(?:^|\\D)${day}(?:\\D|$)`).test(text);
  const hasYear = text.includes(year);
  if (!hasDay || !hasYear) return false;
  return new RegExp(`\\b${monthName}\\b`, 'i').test(text) || text.includes(monthFa);
}

export const REASON_FA = {
  source_not_official: 'منبع رسمی شرکت نیست',
  expiry_missing: 'تاریخ انقضا در منبع نیامده',
  expiry_ambiguous: 'تاریخ انقضا روشن نیست',
  expiry_soon: 'اعتبار باقی‌مانده کمتر از حد مجاز است',
  offer_expired: 'آفر منقضی شده است',
  offer_stale: 'خبر آفر قدیمی‌تر از حد مجاز است',
  offer_referral: 'نشانه لینک ارجاعی پیدا شد',
  offer_quota_full: 'سهمیه دسته ابزارها پر است',
  offer_daily_cap: 'سقف روزانه آفر پر شده است',
  offer_weekly_cap: 'سقف هفتگی آفر پر شده است',
  offer_qa_failed: 'خروجی مدل برای آفر کامل نبود',
  review_daily_cap: 'سقف روزانه صف بازبینی پر شده است',
  review_source_cap: 'سقف روزانه این منبع در صف بازبینی پر شده است',
  review_disabled: 'صف بازبینی غیرفعال است',
  referral_link: 'لینک ارجاعی حل نشده است',
  link_missing: 'لینک معتبر برای این آفر پیدا نشد',
  research_paper: 'مقاله پژوهشی منتخب',
  quiet_hours: 'در ساعات آرام پیدا شد',
  daily_cap: 'سقف پست روزانه پر شده است',
  send_failed: 'ارسال به کانال اصلی ناموفق بود',
  thin_content: 'متن کافی برای ساخت پست نبود',
  fetch_failed: 'دریافت صفحه اصلی ناموفق بود',
  tool_incomplete: 'جزئیات ابزار کامل نشد',
  model_skip: 'مدل این مورد را رد کرد',
  model_failed: 'مدل خروجی معتبر نداد',
  bad_category: 'دسته پیشنهادی مدل معتبر نبود',
  quota_full: 'سهمیه دسته پر است',
  gate_future: 'تاریخ انتشار در آینده است',
  gate_no_date: 'تاریخ انتشار روشن نیست',
  gate_bad_date: 'تاریخ انتشار نامعتبر است',
  denied_link: 'لینک خارجی این پست پذیرفته نشد',
  no_link: 'لینک قابل استفاده ندارد',
  offer_watch: 'از رصد آفر پیدا شد',
  qa_failed: 'بررسی کیفیت پاس نشد',
};

const KIND_FA = { offer: 'آفر', tool: 'ابزار', post: 'پست' };

function aliasIndex(haystack, alias) {
  if (/^[a-z0-9._-]+$/.test(alias)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = haystack.match(new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`));
    return match ? match.index : -1;
  }
  return haystack.indexOf(alias);
}

export function resolveVendorLink(text, vendors = []) {
  const haystack = String(text ?? '').toLowerCase();
  if (!haystack) return null;
  const hits = [];
  for (const vendor of vendors) {
    const aliases = Array.isArray(vendor?.aliases) ? vendor.aliases : [];
    for (const alias of aliases) {
      const needle = String(alias ?? '').toLowerCase().trim();
      if (needle.length < 3) continue;
      const index = aliasIndex(haystack, needle);
      if (index >= 0) hits.push({ vendor, index });
    }
  }
  if (!hits.length) return null;
  hits.sort((left, right) => left.index - right.index);
  const best = hits[0];
  if (hits.some((hit) => hit.index === best.index && hit.vendor.id !== best.vendor.id)) return null;
  const url = String(best.vendor.offer_url || best.vendor.url || best.vendor.watch_url || '');
  if (!/^https?:\/\//i.test(url)) return null;
  return { vendor: best.vendor.id, name: best.vendor.name, url };
}

export const REVIEW_BANNER = '🚨 نیازمند بررسی و انتشار در کانال اصلی';

export function ensureReviewBanner(text) {
  const body = String(text ?? '').trim();
  if (!body) return body;
  return body.startsWith(REVIEW_BANNER) ? body : `${REVIEW_BANNER}\n\n${body}`;
}

export function refreshQueuedReviewText(text, reason = '') {
  const body = ensureReviewBanner(text);
  const reasonFa = REASON_FA[reason];
  if (!reasonFa) return body;
  const escaped = String(reason).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body
    .replace(new RegExp(`^(بازبینی[^\\n]*?—\\s*)${escaped}\\s*$`, 'mu'), `$1${reasonFa}`)
    .replace(new RegExp(`^(دلیل بازبینی:\\s*)${escaped}\\s*$`, 'mu'), `$1${reasonFa}`);
}

export function reviewText({
  article,
  candidate,
  assessment,
  offer = null,
  kind = '',
  mainEligible = false,
  note = '',
  post = null,
  text = '',
} = {}) {
  const resolvedKind =
    kind || (offer?.isOffer || assessment?.expiry ? 'offer' : candidate?.toolHint ? 'tool' : 'post');
  const reason = assessment?.reason ?? '';
  const reasonFa = REASON_FA[reason] ?? reason ?? 'دلیل نامشخص';
  const expiry = assessment?.expiry;
  const expiryLine = expiry?.date
    ? `${expiry.date}${Number.isFinite(expiry.remainingHours) ? ` (${expiry.remainingHours} ساعت اعتبار باقی‌مانده)` : ''}`
    : 'روشن نیست';
  const link = article?.url || candidate?.link || candidate?.canonical || '';
  const needsLinkApproval = reason === 'link_missing';
  const original = String(text || candidate?.messageText || article?.content || '').trim();
  const latinLetters = (original.match(/[A-Za-z]/g) ?? []).length;
  const persianLetters = (original.match(/[\u0600-\u06FF]/g) ?? []).length;
  const englishOriginal = latinLetters >= 40 && latinLetters > persianLetters * 2;
  const lines = [
    REVIEW_BANNER,
    '',
    mainEligible
      ? 'نسخهٔ کانال اصلی آماده است و فقط برای تأیید نهایی به این کانال کپی شد.'
      : 'این مورد به کانال اصلی نرفته است؛ پیش از انتشار، منبع و لینک آن باید بررسی و تأیید شود.',
    ...(needsLinkApproval
      ? ['لینک معتبر پیدا نشد؛ اگر لینک را تأیید یا پیدا کردید، پست را دستی در کانال اصلی منتشر کنید.']
      : []),
    '',
    `بازبینی ${KIND_FA[resolvedKind] ?? KIND_FA.post} — ${reasonFa}`,
    '',
    `عنوان: ${article?.title || candidate?.title || ''}`,
    `منبع: ${candidate?.sourceName || ''}`,
    `تاریخ انتشار: ${article?.published || candidate?.published || ''}`,
  ];
  if (resolvedKind === 'offer') lines.push(`تاریخ انقضا: ${expiryLine}`);
  lines.push(`دلیل بازبینی: ${reasonFa}`);
  lines.push(
    `وضعیت کانال اصلی: ${
      mainEligible ? 'واجد شرایط — نسخه کانال اصلی آماده است و فقط به بازبینی کپی شد' : 'نیازمند بررسی پیش از انتشار'
    }`
  );
  if (link) lines.push(`لینک: ${link}`);
  if (candidate?.leadPostUrl) lines.push(`پست تلگرام: ${candidate.leadPostUrl}`);
  if (post) {
    const draft = reason === 'qa_failed' || (reason === 'tool_incomplete' && !mainEligible);
    lines.push('', draft ? 'پیش‌نویس پست (نیازمند اصلاح):' : 'پست آماده انتشار:', `عنوان: ${post.title ?? ''}`);
    if (post.news_date) lines.push(String(post.news_date));
    lines.push(String(post.body ?? '').slice(0, 1200));
    if (post.quote) lines.push(`نقل‌قول: ${String(post.quote).slice(0, 400)}`);
  }
  if (original) {
    lines.push('', 'متن اصلی:', original.slice(0, post ? 900 : 2400));
  }
  if (!post) {
    lines.push(
      '',
      englishOriginal
        ? 'نکته: پست آمادهٔ فارسی ساخته نشده و متن اصلی انگلیسی است؛ پیش از انتشار ترجمه و تکمیل شود.'
        : 'نکته: پست آمادهٔ فارسی ساخته نشده؛ متن بالا فقط از منبع آمده و باید ترجمه و تکمیل شود.'
    );
  } else if (englishOriginal) {
    lines.push('', 'متن اصلی انگلیسی است؛ نسخهٔ فارسی در «پست آماده انتشار» بالا آمده است.');
  } else if (original && original.length < 220) {
    lines.push('', 'نکته: متن منبع کوتاه است؛ پیش از انتشار جزئیات پست را کامل کنید.');
  }
  if (note) lines.push('', String(note).slice(0, 400));
  lines.push('', 'این پیام فقط برای بازبینی است و به کانال اصلی منتشر نشده است.');
  return lines.join('\n');
}
