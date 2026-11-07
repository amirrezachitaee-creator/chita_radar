import { canonicalUrl } from './normalize.mjs';
import { isAiCentral } from './relevance.mjs';
import { newsDate } from './newstime.mjs';

export const TELEGRAM_SOURCE_TYPE = 'telegram_channel';

export const DEFAULT_DENY_DOMAINS = [
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'x.com',
  'twitter.com',
  't.co',
  'wa.me',
  'whatsapp.com',
  'facebook.com',
  'fb.watch',
  'threads.net',
  'tiktok.com',
  'linkedin.com',
  'lnkd.in',
  'reddit.com',
  'telegram.org',
  'telegram.me',
  't.me',
  'spotify.com',
  'soundcloud.com',
  'podcasts.apple.com',
  'music.apple.com',
  'pinterest.com',
  'snapchat.com',
  'news.google.com',
  'bit.ly',
  'tinyurl.com',
  'goo.gl',
  'rb.gy',
  'cutt.ly',
  'is.gd',
  'shorturl.at',
  'ow.ly',
  'buff.ly',
  'dlvr.it',
  'ift.tt',
  'b2n.ir',
  'yun.ir',
  's2.ir',
  'mdad.ir',
];

export const DEFAULT_DENY_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.mp4',
  '.mov',
  '.mp3',
  '.wav',
  '.pdf',
  '.zip',
  '.rar',
  '.apk',
  '.exe',
];

export const DEFAULT_PROMO_DOMAINS = [
  'cafebazaar.ir',
  'bazaar.ir',
  'myket.ir',
  'sibapp.com',
  'charkhoneh.com',
  'play.google.com',
  'apps.apple.com',
  'apkpure.com',
  'aptoide.com',
  'fdroid.org',
];

export const DEFAULT_OFFICIAL_COURSE_DOMAINS = [
  'anthropic.com',
  'claude.com',
  'openai.com',
  'chatgpt.com',
  'ai.google',
  'deepmind.google',
  'grow.google',
  'skills.google',
  'cloud.google.com',
  'developers.google.com',
  'blog.google',
  'learn.microsoft.com',
  'microsoft.com',
  'microsoft.github.io',
  'blogs.microsoft.com',
  'developer.nvidia.com',
  'nvidia.com',
  'huggingface.co',
  'ai.meta.com',
  'meta.com',
  'mistral.ai',
  'cohere.com',
  'aws.amazon.com',
  'ibm.com',
  'deepseek.com',
  'qwen.ai',
  'z.ai',
  'x.ai',
  'perplexity.ai',
  'midjourney.com',
  'groq.com',
  'ollama.com',
];

const PROMO_TEXT_PATTERN = new RegExp(
  [
    'کد\\s*(?:تخفیف|رفرال|دعوت)',
    'تخفیف\\s*(?:ویژه|فوق|۵۰|50|۴۰|40|۳۰|30|۲۰|20)',
    'با\\s*تخفیف',
    'فرصت\\s*(?:محدود|ویژه)',
    'ظرفیت\\s*محدود',
    'خرید\\s*(?:اشتراک|دوره|محصول|نسخه)',
    'اشتراک\\s*ویژه',
    'پلن\\s*(?:ویژه|حرفه‌ای|طلایی)',
    'قیمت\\s*ویژه',
    'فروش\\s*ویژه',
    'لینک\\s*خرید',
    '(?:محصول|اپلیکیشن|اپ|نرم‌افزار|سرویس)\\s*(?:جدید\\s*)?ما',
    'کافه[\\s\\u200c]*بازار',
    'مایکت',
    'گوگل\\s*پلی',
    'وقت\\s*کلیم',
    'کلیم\\s*کن',
    'ایردراپ',
    'با\\s*لینک\\s*(?:من|دعوت)',
    'لینک\\s*(?:دعوت|رفرال)',
    'limited\\s*time',
    'discount\\s*code',
    'coupon',
    'buy\\s*now',
    'special\\s*offer',
    'our\\s*(?:app|product|service)',
    'download\\s*our',
    'claim\\s*your',
    'airdrop',
    'referral\\s*(?:code|link)',
  ].join('|'),
  'iu'
);

const PROMO_PATH_PATTERN =
  /(?:^|\/)(?:invite|invitation|referral|refer|affiliate|aff|promo|coupon|discount)(?:\/|$)/i;
const PROMO_QUERY_KEYS = new Set([
  'referral',
  'ref',
  'invite',
  'invitation',
  'affiliate',
  'coupon',
  'promo',
  'discount',
]);

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rlm: '\u200f',
  lrm: '\u200e',
};

export function decodeHtml(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code)) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function stripHtml(value) {
  return decodeHtml(
    String(value ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function attr(tag, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = String(tag).match(pattern);
  return match ? decodeHtml(match[1] ?? match[2] ?? '') : '';
}

function sliceMessageText(block) {
  const open = block.match(/<div\b[^>]*class="[^"]*\btgme_widget_message_text\b[^"]*"[^>]*>/i);
  if (!open) return '';
  const start = open.index + open[0].length;
  const stops = ['tgme_widget_message_footer', 'tgme_widget_message_link_preview']
    .map((marker) => block.indexOf(marker, start))
    .filter((index) => index > start);
  const end = stops.length ? Math.min(...stops) : block.length;
  return block
    .slice(start, end)
    .replace(/<\/div>\s*$/i, '')
    .replace(/<[^>]*$/i, '');
}

function matchDiv(section, className) {
  const pattern = new RegExp(
    `<div[^>]+class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`,
    'i'
  );
  const match = section.match(pattern);
  return match ? stripHtml(match[1]) : '';
}

function parsePreview(block) {
  const anchor = block.match(
    /<a\b[^>]*class="[^"]*\btgme_widget_message_link_preview\b[^"]*"[^>]*>/i
  );
  if (!anchor) return null;
  const url = attr(anchor[0], 'href');
  if (!url) return null;
  const start = anchor.index + anchor[0].length;
  const footerAt = block.indexOf('tgme_widget_message_footer', start);
  const end = footerAt > start ? block.lastIndexOf('<div', footerAt) : block.length;
  const section = block.slice(start, end > start ? end : block.length);
  return {
    url,
    title: matchDiv(section, 'link_preview_title'),
    site: matchDiv(section, 'link_preview_site_name'),
    description: matchDiv(section, 'link_preview_description'),
  };
}

function parseMessageImages(block) {
  const urls = [];
  for (const tag of String(block ?? '').matchAll(/<a\b[^>]*>/gi)) {
    if (!/\btgme_widget_message_photo_wrap\b/i.test(tag[0])) continue;
    const style = attr(tag[0], 'style');
    const match = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
    if (match?.[2]) urls.push(decodeHtml(match[2]));
  }
  for (const tag of String(block ?? '').matchAll(/<img\b[^>]*>/gi)) {
    if (!/\btgme_widget_message_photo\b/i.test(tag[0])) continue;
    const src = attr(tag[0], 'src');
    if (src) urls.push(decodeHtml(src));
  }
  return [...new Set(urls)].filter((url) => /^https?:\/\//i.test(url));
}

export function parseTelegramChannel(html, username = '') {
  const blocks = String(html ?? '').split('tgme_widget_message_wrap').slice(1);
  const messages = [];
  for (const block of blocks) {
    const post = block.match(/data-post="([^"]+)"/);
    if (!post) continue;
    const [owner, idText] = post[1].split('/');
    if (!owner || !idText) continue;
    if (username && owner.toLowerCase() !== String(username).toLowerCase()) continue;
    const id = Number(idText);
    if (!Number.isInteger(id) || id <= 0) continue;

    const times = [...block.matchAll(/<time\b[^>]*datetime="([^"]+)"/gi)];
    const published = times.length ? decodeHtml(times[times.length - 1][1]) : '';
    if (!published || !Number.isFinite(Date.parse(published))) continue;

    const textHtml = sliceMessageText(block);
    const text = stripHtml(textHtml);
    if (/\bpinned\s+an?\s+(?:GIF|message|photo|video|file|poll)\b/i.test(text)) continue;
    const links = [];
    for (const match of textHtml.matchAll(/<a\b[^>]*>/gi)) {
      const href = attr(match[0], 'href');
      if (href) links.push(href);
    }
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      links.push(match[0].replace(/[.,;:!?)]+$/g, ''));
    }
    const preview = parsePreview(block);
    if (preview?.url) links.push(preview.url);

    messages.push({
      id,
      url: `https://t.me/${owner}/${id}`,
      published,
      text,
      links: [...new Set(links)],
      images: parseMessageImages(block),
      preview,
      forwarded: block.includes('tgme_widget_message_forwarded_from'),
    });
  }
  return messages.sort((left, right) => left.id - right.id);
}

export function isAllowedLink(raw, { denyDomains = [], denyExtensions = [] } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === '[::1]') {
    return false;
  }

  const denied = [...DEFAULT_DENY_DOMAINS, ...denyDomains]
    .map((domain) => String(domain).toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
  for (const domain of denied) {
    if (host === domain || host.endsWith(`.${domain}`)) return false;
  }

  const path = url.pathname.toLowerCase();
  const extensions = [...DEFAULT_DENY_EXTENSIONS, ...denyExtensions].map((ext) =>
    String(ext).toLowerCase()
  );
  if (extensions.some((ext) => path.endsWith(ext))) return false;
  if (host === 'google.com' && /^\/url\/?$/.test(path)) return false;
  if (host === 'l.facebook.com' || host === 'lm.facebook.com' || host === 'l.instagram.com') {
    return false;
  }

  let canonical = '';
  try {
    canonical = canonicalUrl(url.href);
  } catch {
    return false;
  }
  const target = new URL(canonical);
  if (!target.pathname.replace(/\/+$/, '') && !target.search) return false;
  return true;
}

const normalizeDomain = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/^www\./, '')
    .trim();

function hostIn(host, domains) {
  return domains.some(
    (domain) => domain && (host === domain || host.endsWith(`.${domain}`))
  );
}

export function isPromotionalUrl(raw, { promoDomains = [] } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = normalizeDomain(url.hostname);
  const domains = [...DEFAULT_PROMO_DOMAINS, ...promoDomains].map(normalizeDomain);
  if (hostIn(host, domains)) return true;
  if (PROMO_PATH_PATTERN.test(url.pathname)) return true;
  for (const key of url.searchParams.keys()) {
    if (PROMO_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

export function hasPromoText(text) {
  return PROMO_TEXT_PATTERN.test(String(text ?? ''));
}

const TOOL_TEXT_PATTERN =
  /(?:ابزار|اپلیکیشن|(?<![\p{L}])اپ(?![\p{L}])|سرویس|پلتفرم|افزونه|بات(?:‌ها)?|نرم‌افزار|داشبورد|کلاینت|\btools?\b|\bapps?\b|\bplatforms?\b|\bplugins?\b|\bextensions?\b|\bapi\b|\bsdk\b|نسخه(?:‌|\s)?(?:جدید|تازه))/iu;

const TOOL_HOSTS = [
  'github.com',
  'gitlab.com',
  'huggingface.co',
  'producthunt.com',
  'replicate.com',
  'npmjs.com',
  'pypi.org',
];

export function hasToolText(text) {
  return TOOL_TEXT_PATTERN.test(String(text ?? ''));
}

export function isToolUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = normalizeDomain(url.hostname);
    if (hostIn(host, TOOL_HOSTS)) return true;
    return /(?:^|\/)(?:tool|tools|app|apps|product|products|features?|pricing|plugin|extension)(?:\/|$)/i.test(
      url.pathname
    );
  } catch {
    return false;
  }
}

export function isPromoHost(raw, { promoDomains = [] } = {}) {
  try {
    const host = normalizeDomain(new URL(String(raw)).hostname);
    return hostIn(host, [...DEFAULT_PROMO_DOMAINS, ...promoDomains].map(normalizeDomain));
  } catch {
    return false;
  }
}

export function isOfficialCourse(raw, text, { officialCourseDomains = [] } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = normalizeDomain(url.hostname);
  const domains = [...DEFAULT_OFFICIAL_COURSE_DOMAINS, ...officialCourseDomains].map(
    normalizeDomain
  );
  if (!hostIn(host, domains)) return false;

  return (
    OFFICIAL_COURSE_TEXT_PATTERN.test(normalizeConceptText(text)) ||
    OFFICIAL_COURSE_PATH_PATTERN.test(url.pathname)
  );
}

const AD_START_PATTERN =
  /^[\s>*•\-–—]*(?:تبلیغات?|اسپانسر|رپورتاژ|پیشنهاد\s*ویژه|sponsored|advertisement|\bad\b)/iu;
const AD_CONTACT_PATTERN =
  /(?:جهت|برای)\s*(?:تبلیغات|همکاری|ارتباط)|ارتباط\s*با\s*ما|تبلیغات\s*در|رپورتاژ\s*آگهی/iu;
const AD_OFFER_PATTERN =
  /(?:کد\s*(?:تخفیف|دعوت|رفرال)|لینک\s*(?:دعوت|رفرال)|با\s*لینک\s*من|تخفیف\s*ویژه|فرصت\s*محدود|همین\s*حالا\s*ثبت)/iu;

export function stripLeadNoise(text, { maxChars = 0 } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push('');
      continue;
    }
    if (AD_START_PATTERN.test(trimmed) || AD_CONTACT_PATTERN.test(trimmed)) break;
    if (AD_OFFER_PATTERN.test(trimmed)) {
      const remainder = trimmed
        .replace(AD_OFFER_PATTERN, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s+(?:با|و|از|به|در|برای|تا)$/u, '')
        .trim();
      if (remainder.split(/\s+/).filter(Boolean).length < 3) continue;
      kept.push(remainder);
      continue;
    }
    if (/^https?:\/\//i.test(trimmed) || /^t\.me\//i.test(trimmed)) continue;
    kept.push(trimmed);
  }
  let value = kept
    .join('\n')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const limit = Number(maxChars) || 0;
  if (limit > 0 && value.length > limit) {
    const cut = value.slice(0, limit);
    const boundary = cut.search(/\s+\S*$/);
    value = `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()} …`;
  }
  return value;
}

export function classifyLead(
  url,
  text,
  {
    promoDomains = [],
    officialCourseDomains = [],
    aiRelevant = false,
    aiCentral = false,
    offerCue = false,
  } = {}
) {
  if (isOfficialCourse(url, text, { officialCourseDomains }) && (aiRelevant || aiCentral)) {
    return 'official_course';
  }
  if (isPromoHost(url, { promoDomains })) return 'promotion';
  if (isEducationLead(text)) return aiCentral ? 'education' : 'off_topic_education';
  if (aiRelevant && offerCue) return 'free_offer';
  if (aiRelevant && (isToolUrl(url) || hasToolText(text))) return 'tool_lead';
  if (isPromotionalUrl(url, { promoDomains }) || hasPromoText(text)) return 'promotion';
  return 'news';
}

export function hasExternalLink(message) {
  if (message?.preview?.url) return true;
  return (message?.links ?? []).some((url) => {
    try {
      const protocol = new URL(String(url)).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  });
}

export function selectLeadLink(
  message,
  { denyDomains = [], denyExtensions = [], promoDomains = [] } = {}
) {
  const candidates = [];
  if (message?.preview?.url) {
    candidates.push({ url: message.preview.url, previewTitle: message.preview.title ?? '' });
  }
  for (const url of message?.links ?? []) {
    candidates.push({ url, previewTitle: '' });
  }
  const seen = new Set();
  for (const candidate of candidates) {
    let canonical = '';
    try {
      canonical = canonicalUrl(candidate.url);
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    if (!isAllowedLink(candidate.url, { denyDomains, denyExtensions })) continue;
    if (isPromotionalUrl(candidate.url, { promoDomains })) continue;
    return { url: candidate.url, canonical, previewTitle: candidate.previewTitle };
  }
  return null;
}

export function selectReviewLink(
  message,
  { denyDomains = [], denyExtensions = [], promoDomains = [] } = {}
) {
  const candidates = [];
  if (message?.preview?.url) {
    candidates.push({ url: message.preview.url, previewTitle: message.preview.title ?? '' });
  }
  for (const url of message?.links ?? []) {
    candidates.push({ url, previewTitle: '' });
  }
  const seen = new Set();
  for (const candidate of candidates) {
    let canonical = '';
    try {
      canonical = canonicalUrl(candidate.url);
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    if (!isAllowedLink(candidate.url, { denyDomains, denyExtensions })) continue;
    // A referral path or tracking parameter is allowed here so it can be reviewed;
    // app-store hosts are still advertising and never become leads.
    if (isPromoHost(candidate.url, { promoDomains })) continue;
    return { url: candidate.url, canonical, previewTitle: candidate.previewTitle };
  }
  return null;
}

export function leadTitle(message, previewTitle = '') {
  const fromPreview = String(previewTitle ?? '').trim();
  if (fromPreview) return clipTitle(fromPreview);
  const lines = String(message?.text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const cleaned = line.replace(/https?:\/\/\S+/g, '').trim();
    if (cleaned.split(/\s+/).filter(Boolean).length >= 3) return clipTitle(cleaned);
  }
  return clipTitle(lines[0] ?? '') || `سرنخ ${message?.id ?? ''}`.trim();
}

function clipTitle(value) {
  const words = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  return words.slice(0, 16).join(' ').slice(0, 110);
}

function normalizeConceptText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/(?:(?:گوگل|google)\s*)?(?:کلاس[\s\u200c-]*(?:روم|room)|classroom)/giu, ' ')
    .replace(/آموزش[\s\u200c]*و[\s\u200c]*پرورش/giu, ' ')
    .replace(/آموزش[\s\u200c]*عالی/giu, ' ')
    .replace(/(?:معاون|مدیر|رئیس|سخنگوی|سرپرست|وزیر)\s*(?:بخش\s*)?آموزش(?![\p{L}\p{N}])/giu, ' ')
    .replace(/برای\s*(?:مشاهده|تماشای|دیدن)\s*(?:آموزش|وید[ئيی]و(?:[^\s]*)?|یوتیوب)/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ML_TRAINING_PATTERN =
  /(آموزش\s*(?:مدل|مدل‌ها|شبکه|شبکه‌های|داده)|داده(?:[\u200c\s])*های\s*آموزشی|آموزش\s*دیده|آموزش\s*دیدن)/iu;

const OFFICIAL_COURSE_TEXT_PATTERN =
  /(دوره|وبینار|کلاس|کارگاه|بوت[\s\u200c]*کمپ|مدرک|certificate|course|bootcamp|webinar|workshop|academy|curriculum|lesson|learning[\s-]+path|training[\s-]+(?:course|program|session))/iu;

const OFFICIAL_COURSE_PATH_PATTERN =
  /(?:^|\/)(?:learn|learning|academy|courses?|training|education|certification|curriculum|lessons?)(?:\/|$)/i;

const EDUCATION_CONCEPTS = [
  {
    name: 'enrollment',
    weight: 3,
    pattern:
      /(?:ثبت[\s\u200c]*نام|پیش[\s\u200c]*ثبت|شهریه|ظرفیت[\s\u200c]*(?:محدود|تکمیل)|پرداخت|خرید|تخفیف)[^\n]{0,60}(?:دوره|کلاس|وبینار|کارگاه|بوت[\s\u200c]*کمپ|کورس|course|bootcamp|webinar|workshop)|(?:دوره|کلاس|وبینار|کارگاه|بوت[\s\u200c]*کمپ|کورس|course|bootcamp|webinar|workshop)[^\n]{0,60}(?:ثبت[\s\u200c]*نام|پیش[\s\u200c]*ثبت|شهریه|ظرفیت|پرداخت|خرید|تخفیف|enroll|tuition)/iu,
  },
  {
    name: 'course',
    weight: 2,
    pattern:
      /(?<![\p{L}\p{N}])دوره(?![\s\u200c]*(?:ای|زمانی|متوسطه|ابتدایی|راهنمایی|دبیرستان|اعتبار|زیر[\s\u200c]*و[\s\u200c]*رو))|(?<![\p{L}\p{N}])کلاس(?![\p{L}\p{N}])|وبینار|کارگاه|بوت[\s\u200c]*کمپ|کورس|\bcourse\b|\bbootcamp\b|\bwebinar\b|\bworkshop\b|\bacademy\b/iu,
  },
  {
    name: 'tutorial',
    weight: 3,
    pattern:
      /(?:(?:آموزش|یادگیری)[\s\u200c]+[^\n]{0,30}?(?:وید[ئيی]و|یوتیوب|تصویری|قدم|نصب|راه[\s\u200c]*اندازی|استفاده|کار[\s\u200c]*با|ساخت|اجرا|برنامه|پروژه|تلگرام|هوش[\s\u200c]*مصنوعی)|^آموزش(?=[\s:：،]|$)|در[\s\u200c]*این[\s\u200c]*وید[ئيی]و|یاد[\s\u200c]*می[\s\u200c]*د[هم]م|آموزش[\s\u200c]+قدم[\s\u200c]*به[\s\u200c]*قدم|tutorial|how[\s\u200c]*to[\s\u200c]+(?:build|use|make|install|set[\s-]*up|create|run|deploy|train|fine[\s-]*tune|write|prompt|code|integrate|automate|configure|connect|generate|start|get[\s-]*started)\b|راهنمای[\s\u200c]+(?:نصب|استفاده|کار)|(?:وید[ئيی]و|یوتیوب|tutorial)[^\n]{0,30}?(?:آموزش|یادگیری))/iu,
  },
  {
    name: 'guide',
    weight: 2,
    pattern:
      /(?:راهنما|راهنمای)[\s\u200c]+[^\n]{0,25}?(?:فارسی|PDF|نصب|استفاده|کار|قدم|گام|ابزار)|(?:فایل|نسخه)[\s\u200c]*(?:PDF|پی[\s\u200c]*دی[\s\u200c]*اف)|پرامپت[\s\u200c]*(?:های)?[\s\u200c]*آماده|نصب[\s\u200c]*(?:قدم[\s\u200c]*به[\s\u200c]*قدم|گام[\s\u200c]*به[\s\u200c]*گام)/iu,
  },
  {
    name: 'credential',
    weight: 3,
    pattern:
      /(?:مدرک|گواهی)[^\n]{0,30}(?:دوره|کلاس|وبینار|کارگاه|بوت[\s\u200c]*کمپ|course|bootcamp|webinar)|(?:دوره|کلاس|وبینار|کارگاه|بوت[\s\u200c]*کمپ|course|bootcamp|webinar)[^\n]{0,30}(?:مدرک|گواهی|certificate)/iu,
  },
  {
    name: 'qualifier',
    weight: 1,
    pattern:
      /(?:رایگان|مقدماتی|پیشرفته|تخصصی|جامع|آنلاین|حضوری|زنده|مجازی|خصوصی|گروهی|رسمی|هوش[\s\u200c]*مصنوعی|برنامه[\s\u200c]*نویسی|یادگیری|آموزشی|بین[\s\u200c]*المللی|beginner|beginners|advanced|professional|free|online)/iu,
  },
];

const NEWS_CONCEPTS = [
  {
    name: 'announcement',
    weight: 2,
    pattern:
      /(?:اعلام|گفت|گفته|تصمیم|قرار[\s\u200c]*است|از[\s\u200c]*(?:سال|ماه|هفته)|طرح|قانون|دستور|ممنوع|اجازه|حذف|افزود|برگزار|شروع|متوقف|توقف|رونمایی|منتشر|عرضه|معرفی)/iu,
  },
  {
    name: 'institution',
    weight: 1,
    pattern:
      /(?:گوگل|مایکروسافت|اپن[\s\u200c]*ای[\s\u200c]*آی|آنتروپیک|متا|انویدیا|آمازون|اپل|دولت|وزارت|کمیسیون|کنگره|مجلس|شهرداری|دانشگاه|شرکت|استارتاپ|سازمان|اتحادیه)/iu,
  },
  {
    name: 'educationTopic',
    weight: 2,
    pattern:
      /(?:مدارس|مدرسه|دانش[\s\u200c]*آموز(?:ان)?|دانش[\s\u200c]*جو(?:یان)?|معلمان?|دبیران?|کلاس[\s\u200c]*درس|سیاست[\s\u200c]*آموزشی|نظام[\s\u200c]*آموزشی|آموزش[\s\u200c]*و[\s\u200c]*پرورش)/iu,
  },
  {
    name: 'research',
    weight: 1,
    pattern: /(?:گزارش|پژوهش|تحقیق|مطالعه|بررسی|نظرسنجی|داده[\s\u200c]*ها|یافته)/iu,
  },
  {
    name: 'market',
    weight: 1,
    pattern:
      /(?:سرمایه[\s\u200c]*گذاری|درآمد|سهام|ارزش|خرید|همکاری|توافق|قرارداد|میلیارد|میلیون)/iu,
  },
];

export function educationSignals(text) {
  const value = normalizeConceptText(text);
  if (!value) {
    return { education: [], news: [], educationScore: 0, newsScore: 0 };
  }
  const education = EDUCATION_CONCEPTS.filter((concept) => concept.pattern.test(value));
  const news = NEWS_CONCEPTS.filter((concept) => concept.pattern.test(value));
  return {
    education: education.map((concept) => concept.name),
    news: news.map((concept) => concept.name),
    educationScore: education.reduce((sum, concept) => sum + concept.weight, 0),
    newsScore: news.reduce((sum, concept) => sum + concept.weight, 0),
  };
}

const PERSONAL_NARRATIVE_PATTERN =
  /(?:دارم\s*فکر\s*می\s*کنم|پیام\s*پارسال|یادم\s*می\s*(?:آید|اد|آد)|یادش\s*بخیر|خاطره(?:[\s\u200c]*ای)?\s*(?:از|بود))/iu;

const ENROLL_CTA_PATTERN =
  /(?:ثبت[\s\u200c]*نام|پیش[\s\u200c]*ثبت)[^\n]{0,25}(?:کنید|کن|بشه|فرمایید|از\s*طریق|از\s*لینک|در\s*سایت)|(?:برای|جهت)\s*(?:ثبت[\s\u200c]*نام|شرکت\s*در)/iu;

const EARLY_CUE_CHARS = 400;
const PREFIX_OPTIONAL_CONCEPTS = new Set(['tutorial', 'guide']);
const STRONG_EDUCATION_CONCEPTS = new Set([
  'enrollment',
  'course',
  'tutorial',
  'guide',
  'credential',
]);

export function isEducationLead(text) {
  const value = normalizeConceptText(text);
  if (!value) return false;
  if (ML_TRAINING_PATTERN.test(value)) return false;
  if (PERSONAL_NARRATIVE_PATTERN.test(value) && !ENROLL_CTA_PATTERN.test(value)) return false;

  const signals = educationSignals(value);
  if (!signals.education.length) return false;
  const earlySignals = educationSignals(value.slice(0, EARLY_CUE_CHARS));
  const earlyStrong = earlySignals.education.some((name) =>
    STRONG_EDUCATION_CONCEPTS.has(name)
  );
  const anchoredStrong = signals.education.some(
    (name) => STRONG_EDUCATION_CONCEPTS.has(name) && !PREFIX_OPTIONAL_CONCEPTS.has(name)
  );
  // A tutorial or guide mentioned deep inside a long post is usually a side
  // reference; only a course or enrollment makes the whole post a lead.
  if (!earlyStrong && !anchoredStrong) return false;
  if (signals.education.length === 1 && signals.educationScore < 3) return false;
  if (
    signals.news.length >= 2 &&
    signals.newsScore >= signals.educationScore &&
    signals.education.length < 3
  ) {
    return false;
  }
  return true;
}

const stripJoiners = (value) => String(value ?? '').replace(/[\u200c\u200d]/g, '');

const STORY_STOPWORDS = new Set([
  'است', 'بود', 'هست', 'شد', 'شده', 'کرد', 'کرده', 'کند', 'کنند', 'دهد', 'دهند',
  'رسید', 'رسیده', 'رسد', 'گفت', 'گفته', 'اعلام', 'جدید', 'تازه', 'خبر', 'گزارش',
  'سال', 'ماه', 'روز', 'هفته', 'امروز', 'دیروز', 'فردا', 'میلادی', 'آینده', 'اوایل',
  'این', 'آن', 'از', 'به', 'با', 'در', 'را', 'که', 'و', 'یا', 'برای', 'تا', 'بر', 'هم',
  'نیز', 'اما', 'اگر', 'چه', 'همه', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت',
  'نه', 'ده', 'های', 'ها', 'هایی', 'خود', 'خودش', 'رو', 'می‌شود', 'می‌کند', 'می‌دهد',
  'نمی‌شود', 'نیست', 'دارد', 'دارند', 'داریم', 'صورت', 'طور', 'مورد', 'درباره', 'بین',
  'پس', 'قبل', 'بعد', 'حالا', 'الان', 'همین', 'همان', 'دیگر', 'بیشتر', 'کمتر', 'بسیار',
  'خیلی', 'فناوری', 'بازار', 'ابزار', 'حساب', 'هوش', 'مصنوعی', 'هوش‌مصنوعی', 'پیش‌فرض',
  'به‌صورت',
].map(stripJoiners));

const STORY_SYNONYMS = new Map([
  ['مدارس', 'مدرسه'],
  ['دانش‌آموزی', 'دانش‌آموز'],
  ['دانش‌آموزان', 'دانش‌آموز'],
  ['سرچ', 'جست‌وجو'],
  ['جستجو', 'جست‌وجو'],
  ['جستجوی', 'جست‌وجو'],
  ['جست‌وجوی', 'جست‌وجو'],
  ['حساب‌های', 'حساب'],
  ['حساب‌ها', 'حساب'],
  ['ابزارهای', 'ابزار'],
  ['ابزارها', 'ابزار'],
  ['دیتاسنترها', 'دیتاسنتر'],
].map(([key, value]) => [stripJoiners(key), stripJoiners(value)]));

function storyTokens(value) {
  const tokens = normalizeConceptText(value)
    .toLowerCase()
    .replace(/[\u200c\u200d]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => STORY_SYNONYMS.get(token) ?? token)
    .filter((token) => token.length >= 3 && !STORY_STOPWORDS.has(token));
  return new Set(tokens);
}

export function matchesPublishedStory(text, entry = {}) {
  const leadTokens = storyTokens(text);
  if (!leadTokens.size) return false;
  const sourceText = String(entry.sourceText ?? '');
  const stories = [
    entry.title,
    entry.sourceTitle,
    sourceText.length <= 600 ? sourceText : '',
  ].filter(Boolean);
  for (const story of stories) {
    const publishedTokens = storyTokens(story);
    if (!publishedTokens.size) continue;
    let shared = 0;
    for (const token of publishedTokens) {
      if (leadTokens.has(token)) shared += 1;
    }
    if (shared >= 3 && shared / publishedTokens.size >= 0.6) return true;
  }
  return false;
}

export function selectAnyLink(message) {
  const candidates = [message?.preview?.url, ...(message?.links ?? [])];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const url = new URL(String(raw));
      if (url.protocol === 'http:' || url.protocol === 'https:') return String(raw);
    } catch {
      continue;
    }
  }
  return '';
}

const COURSE_SALE_PATTERN =
  /(?:(?:دوره|کلاس|وبینار|کارگاه|بوت[\s\u200c]*کمپ|course|class|bootcamp)[^\n]{0,50}(?:قیمت|تخفیف|کد\s*تخفیف|شهریه|هزینه|پرداخت|خرید|ظرفیت[\s\u200c]*محدود|تومان|ریال|دلار|price|discount|tuition|enroll|cohort)|(?:قیمت|تخفیف|کد\s*تخفیف|شهریه|هزینه|پرداخت|خرید|ظرفیت[\s\u200c]*محدود|تومان|ریال|دلار|price|discount|tuition|enroll|cohort)[^\n]{0,50}(?:دوره|کلاس|وبینار|کارگاه|course|class|bootcamp))/iu;

const COURSE_SALE_PATH_PATTERN =
  /(?:^|\/)(?:product|products|pricing|plans?|shop|store|checkout|cart|buy)(?:\/|$)/i;

function isCourseSaleLink(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return COURSE_SALE_PATH_PATTERN.test(url.pathname);
  } catch {
    return false;
  }
}

const SOCIAL_TUTORIAL_DOMAINS = ['youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'instagram.com'];

function isSocialTutorialLink(raw) {
  try {
    return hostIn(normalizeDomain(new URL(String(raw)).hostname), SOCIAL_TUTORIAL_DOMAINS);
  } catch {
    return false;
  }
}

export function educationLeadLabel(lead = {}) {
  const text = normalizeConceptText(`${lead.title ?? ''} ${stripLeadNoise(lead.messageText ?? '')}`);
  const social =
    isSocialTutorialLink(lead.link) ||
    isSocialTutorialLink(lead.canonical) ||
    isSocialTutorialLink(lead.leadPostUrl);
  if (!isEducationLead(text)) return social ? 'آموزش' : 'نامشخص';
  const sale =
    COURSE_SALE_PATTERN.test(text) ||
    isCourseSaleLink(lead.link) ||
    isCourseSaleLink(lead.canonical);
  if (sale) return 'فروش دوره';
  return 'آموزش';
}

export function educationDigestLeads(leads = [], { max = 5 } = {}) {
  const unique = [];
  const seenUrls = new Set();
  const seenTitles = new Set();
  for (const lead of leads) {
    const url = String(lead?.canonical || lead?.link || lead?.leadPostUrl || '').trim();
    const titleKey = String(lead?.title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!url || seenUrls.has(url)) continue;
    if (titleKey && seenTitles.has(titleKey)) continue;
    seenUrls.add(url);
    if (titleKey) seenTitles.add(titleKey);
    const aiCentral =
      lead?.aiCentral ??
      isAiCentral(lead?.title ?? '', stripLeadNoise(lead?.messageText ?? '', { maxChars: 600 }));
    const titleAi = isAiCentral(lead?.title ?? '', '');
    const publishedMs = Date.parse(String(lead?.published ?? ''));
    unique.push({
      ...lead,
      url,
      aiCentral,
      digestScore: (aiCentral ? 4 : 0) + (titleAi ? 3 : 0),
      digestPublished: Number.isFinite(publishedMs) ? publishedMs : 0,
    });
  }
  unique.sort(
    (left, right) =>
      right.digestScore - left.digestScore ||
      right.digestPublished - left.digestPublished ||
      String(left.title ?? '').localeCompare(String(right.title ?? ''))
  );
  const cap = Number(max);
  return cap > 0 ? unique.slice(0, cap) : unique;
}

function educationSourceLine(lead) {
  return [lead.sourceName, lead.leadSource ? `@${lead.leadSource}` : '']
    .filter(Boolean)
    .join(' | ');
}

export function buildEducationDigest({ leads = [], date = '', slot = '' } = {}) {
  const unique = educationDigestLeads(leads);
  if (unique.length === 0) return '';
  const lines = [
    'لیدهای آموزشی — فقط برای مرور شما',
    `تاریخ: ${date} | اسلات: ${slot}`,
    '',
  ];
  for (const [index, lead] of unique.entries()) {
    const title = String(lead.title ?? '').replace(/\s+/g, ' ').trim() || 'بدون عنوان';
    const source = educationSourceLine(lead);
    const published = newsDate(lead.published) || String(lead.published ?? '').trim();
    lines.push(`${index + 1}. ${title}`);
    lines.push(`برچسب: ${educationLeadLabel(lead)}`);
    if (source) lines.push(`منبع: ${source}`);
    if (published) lines.push(`انتشار: ${published}`);
    lines.push(`لینک: ${lead.url}`);
    if (lead.leadPostUrl && lead.leadPostUrl !== lead.url) {
      lines.push(`پست اصلی: ${lead.leadPostUrl}`);
    }
    lines.push('');
  }
  lines.push('این موارد در کانال اصلی منتشر نمی‌شوند؛ فقط در همین صف بازبینی برای مرور شما ثبت شده‌اند.');
  return lines.join('\n');
}

const EDUCATION_MESSAGE_MAX = 3800;
const EDUCATION_CONTINUATION = '🎓 لید آموزشی | ادامه';

function splitChunks(value, max) {
  const chunks = [];
  let rest = String(value ?? '').trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function buildEducationMessages(lead = {}, { maxTextChars = 1200 } = {}) {
  const title = String(lead.title ?? '').replace(/\s+/g, ' ').trim() || 'بدون عنوان';
  const label = educationLeadLabel(lead);
  const source = educationSourceLine(lead);
  const published = newsDate(lead.published) || String(lead.published ?? '').trim();
  const postUrl = String(lead.leadPostUrl ?? '').trim();
  const external = String(lead.link ?? lead.url ?? '').trim();
  const rawText = stripLeadNoise(lead.messageText ?? '', { maxChars: maxTextChars });
  const firstLine = rawText.split('\n').find((line) => line.trim())?.trim() ?? '';
  const titleAlreadyInText = firstLine.replace(/\s+/g, ' ').trim() === title;
  const header = `🎓 لید آموزشی | ${label}`;
  const content = [titleAlreadyInText ? '' : title, rawText].filter(Boolean).join('\n\n');
  const footerLines = [];
  if (source) footerLines.push(`منبع: ${source}`);
  if (published) footerLines.push(`انتشار: ${published}`);
  if (postUrl) footerLines.push(`پست اصلی: ${postUrl}`);
  if (external && external !== postUrl) footerLines.push(`لینک: ${external}`);
  const footer = footerLines.join('\n');
  const single = [header, content, footer].filter(Boolean).join('\n\n');
  if (single.length <= EDUCATION_MESSAGE_MAX) return [single];

  const messages = splitChunks(content, EDUCATION_MESSAGE_MAX - 500).map((chunk, index) =>
    [index === 0 ? header : EDUCATION_CONTINUATION, chunk].filter(Boolean).join('\n\n')
  );
  if (footer) {
    const lastIndex = messages.length - 1;
    if ((`${messages[lastIndex]}\n\n${footer}`).length <= EDUCATION_MESSAGE_MAX) {
      messages[lastIndex] = `${messages[lastIndex]}\n\n${footer}`;
    } else {
      messages.push(`🎓 لید آموزشی | مشخصات\n\n${footer}`);
    }
  }
  return messages;
}

export function buildEducationMessage(lead = {}) {
  return buildEducationMessages(lead).join('\n\n');
}

function clipVerbatim(value, maxChars = 0) {
  const limit = Number(maxChars) || 0;
  if (limit <= 0 || value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const boundary = cut.search(/\s+\S*$/);
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()} …`;
}

export function buildEducationForward(lead = {}, { maxTextChars = 0 } = {}) {
  const title = String(lead.title ?? '').replace(/\s+/g, ' ').trim();
  const raw = clipVerbatim(
    String(lead.messageText ?? '').trim() || String(lead.summary ?? '').trim(),
    maxTextChars
  );
  const source = educationSourceLine(lead);
  const published = newsDate(lead.published) || String(lead.published ?? '').trim();
  const postUrl = String(lead.leadPostUrl ?? '').trim();
  const external = String(lead.link ?? lead.url ?? '').trim();
  const content = lead.webEducation
    ? [title, raw].filter(Boolean).join('\n\n')
    : raw || title;
  const footerLines = [];
  if (source) footerLines.push(`منبع: ${source}`);
  if (published) footerLines.push(`انتشار: ${published}`);
  if (postUrl) footerLines.push(`پست اصلی: ${postUrl}`);
  if (external && external !== postUrl) footerLines.push(`لینک: ${external}`);
  if (!postUrl && !external && lead.canonical) footerLines.push(`لینک: ${lead.canonical}`);
  const footer = footerLines.join('\n');
  const single = [content, footer ? `—\n${footer}` : ''].filter(Boolean).join('\n\n');
  if (single.length <= EDUCATION_MESSAGE_MAX) return [single];

  const messages = splitChunks(content, EDUCATION_MESSAGE_MAX - 500).map((chunk, index) =>
    [index === 0 ? '' : '🎓 ادامه آموزش', chunk].filter(Boolean).join('\n\n')
  );
  if (footer) {
    const lastIndex = messages.length - 1;
    if ((`${messages[lastIndex]}\n\n—\n${footer}`).length <= EDUCATION_MESSAGE_MAX) {
      messages[lastIndex] = `${messages[lastIndex]}\n\n—\n${footer}`;
    } else {
      messages.push(`—\n${footer}`);
    }
  }
  return messages;
}

export function telegramSourceEnabled(source, settings = {}) {
  return (
    settings.enabled !== false &&
    source?.type === TELEGRAM_SOURCE_TYPE &&
    Boolean(source.username)
  );
}
