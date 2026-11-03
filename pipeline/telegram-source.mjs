import { canonicalUrl } from './normalize.mjs';
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
    OFFICIAL_COURSE_TEXT_PATTERN.test(String(text ?? '')) ||
    OFFICIAL_COURSE_PATH_PATTERN.test(url.pathname)
  );
}

export function classifyLead(
  url,
  text,
  { promoDomains = [], officialCourseDomains = [] } = {}
) {
  if (isOfficialCourse(url, text, { officialCourseDomains })) return 'official_course';
  if (isEducationLead(text)) return 'education';
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

const COURSE_CONTEXT_PATTERN =
  /(دوره|کلاس|وبینار|کارگاه|بوت[\s\u200c]*کمپ|course|bootcamp|webinar|workshop|academy|curriculum|lesson|learning[\s-]+path|training[\s-]+(?:course|program))/iu;

const TUTORIAL_CONTEXT_PATTERN =
  /((?:آموزش|یاد[\s\u200c]*گیری)[\s\u200c]*(?:[^\n]{0,30})?(?:وید[ئيی]و|یوتیوب|تصویری|قدم|نصب|راه[\s\u200c]*اندازی|استفاده|کار[\s\u200c]*با|ساخت|اجرا|برنامه|پروژه|تلگرام|هوش[\s\u200c]*مصنوعی)|^آموزش(?=[\s:：،]|$)|در[\s\u200c]*این[\s\u200c]*وید[ئيی]و|یاد[\s\u200c]*می[\s\u200c]*د[هم]م?|قدم[\s\u200c]*به[\s\u200c]*قدم|tutorial|how[\s\u200c]*to|راهنمای[\s\u200c]+(?:نصب|استفاده|کار)|(?:وید[ئيی]و|یوتیوب|tutorial)[^\n]{0,30}(?:آموزش|یادگیری))/iu;

const CERTIFICATE_PATTERN = /(مدرک\s*(?:دوره|کلاس|وبینار)|certificate)/iu;

const ML_TRAINING_PATTERN =
  /(آموزش\s*(?:مدل|مدل‌ها|شبکه|شبکه‌های|داده)|داده(?:[\u200c\s])*های\s*آموزشی|آموزش\s*دیده|آموزش\s*دیدن)/iu;

const OFFICIAL_COURSE_TEXT_PATTERN =
  /(دوره|وبینار|کلاس|کارگاه|بوت[\s\u200c]*کمپ|مدرک|certificate|course|bootcamp|webinar|workshop|academy|curriculum|lesson|learning[\s-]+path|training[\s-]+(?:course|program|session))/iu;

const OFFICIAL_COURSE_PATH_PATTERN =
  /(?:^|\/)(?:learn|learning|academy|courses?|training|education|certification|curriculum|lessons?)(?:\/|$)/i;

export function isEducationLead(text) {
  const value = String(text ?? '');
  if (!value) return false;
  if (ML_TRAINING_PATTERN.test(value)) return false;
  return (
    COURSE_CONTEXT_PATTERN.test(value) ||
    TUTORIAL_CONTEXT_PATTERN.test(value) ||
    CERTIFICATE_PATTERN.test(value)
  );
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
  /(?:(?:دوره|کلاس|وبینار|کارگاه|بوت[\s\u200c]*کمپ|course|class|bootcamp)[^\n]{0,50}(?:ثبت[\s\u200c]*نام|پیش[\s\u200c]*ثبت|شهریه|قیمت|تخفیف|کد\s*تخفیف|ظرفیت|پرداخت|خرید|enroll|tuition|price|discount|cohort)|(?:ثبت[\s\u200c]*نام|شهریه|قیمت|تخفیف|خرید)[^\n]{0,50}(?:دوره|کلاس|وبینار|کارگاه|course|class|bootcamp))/iu;

const TUTORIAL_PATTERN =
  /(آموزش|یاد\s*می\s*د[هم]م?|قدم\s*به\s*قدم|در\s*این\s*ویدئو|ویدئو|tutorial|how\s*to|guide|راهنما|github|وبلاگ|مقاله|یوتیوب)/iu;

const SOCIAL_TUTORIAL_DOMAINS = ['youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'instagram.com'];

function isSocialTutorialLink(raw) {
  try {
    return hostIn(normalizeDomain(new URL(String(raw)).hostname), SOCIAL_TUTORIAL_DOMAINS);
  } catch {
    return false;
  }
}

export function educationLeadLabel(lead = {}) {
  const text = `${lead.title ?? ''} ${lead.messageText ?? ''}`;
  if (COURSE_SALE_PATTERN.test(text)) return 'فروش دوره';
  if (
    TUTORIAL_PATTERN.test(text) ||
    isSocialTutorialLink(lead.link) ||
    isSocialTutorialLink(lead.canonical) ||
    isSocialTutorialLink(lead.leadPostUrl)
  ) {
    return 'آموزش';
  }
  return 'نامشخص';
}

export function educationDigestLeads(leads = []) {
  const unique = [];
  const seen = new Set();
  for (const lead of leads) {
    const url = String(lead?.canonical || lead?.link || lead?.leadPostUrl || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push({ ...lead, url });
  }
  return unique;
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

export function buildEducationMessages(lead = {}) {
  const title = String(lead.title ?? '').replace(/\s+/g, ' ').trim() || 'بدون عنوان';
  const label = educationLeadLabel(lead);
  const source = educationSourceLine(lead);
  const published = newsDate(lead.published) || String(lead.published ?? '').trim();
  const postUrl = String(lead.leadPostUrl ?? '').trim();
  const external = String(lead.link ?? lead.url ?? '').trim();
  const rawText = String(lead.messageText ?? '').replace(/\r\n?/g, '\n').trim();
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

export function telegramSourceEnabled(source, settings = {}) {
  return (
    settings.enabled !== false &&
    source?.type === TELEGRAM_SOURCE_TYPE &&
    Boolean(source.username)
  );
}
