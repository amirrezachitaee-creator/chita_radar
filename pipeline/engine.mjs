import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalUrl, contentHash, freshness, windowFor } from './normalize.mjs';
import { dateMentioned, hasReferral } from './offers.mjs';
import { hasAiMention } from './relevance.mjs';
import { newsDateLine } from './newstime.mjs';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
export const MAIN_CATEGORIES = ['tools', 'models', 'security', 'business'];
export const POST_TYPES = ['breaking', 'standard', 'deep'];
export const VERIFICATIONS = ['official', 'reported', 'rumor', 'unverified'];
export const RANGES = { breaking: [150, 400], standard: [400, 900], deep: [900, 1800] };
export const CAPTION_SAFE_LIMIT = 900;
export const QUOTE_MAX_CHARS = 1200;
export const TITLE_MAX_WORDS = 12;
export const BANNED = [
  'باورنکردنی',
  'شوکه‌کننده',
  'شگفت‌انگیز',
  'انقلابی',
  'تاریخ‌ساز',
  'بی‌نظیر',
  'همین حالا',
  'فرصت را از دست نده',
  'در دنیای امروز',
  'همان‌طور که می‌دانید',
  'بازی را عوض می‌کند',
  'متحول',
  'دگرگون',
  'game changer',
  'game-changer',
];

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function loadEnv(path) {
  const env = {};
  const raw = await readFile(path, 'utf8');
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function makeRedactor(env) {
  const secrets = Object.values(env).filter((value) => typeof value === 'string' && value.length >= 8);
  return (input) => {
    let out = String(input ?? '');
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join('***');
    return out.replace(/\s+/g, ' ').trim().slice(0, 300);
  };
}

export function decodeEntities(input) {
  let out = String(input ?? '').replace(/<!\[CDATA\[|\]\]>/g, '');
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
  out = out.replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)));
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  };
  return out.replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

export function stripHtml(input) {
  return decodeEntities(
    String(input ?? '')
      .replace(/<!\[CDATA\[|\]\]>/g, ' ')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

export function pickTag(block, name) {
  const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match?.[1] ?? '';
}

export function parseFeed(xml) {
  const blocks = [
    ...[...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]),
    ...[...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]),
  ];
  return blocks
    .map((block) => {
      const title = stripHtml(pickTag(block, 'title'));
      let link = stripHtml(pickTag(block, 'link'));
      const alternate =
        block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
        block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["']/i);
      if (alternate) link = alternate[1];
      if (!link) link = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] ?? '';
      const publishedRaw = stripHtml(pickTag(block, 'pubDate') || pickTag(block, 'published'));
      const updatedRaw = stripHtml(pickTag(block, 'updated'));
      const published = publishedRaw || updatedRaw;
      const summary = stripHtml(
        pickTag(block, 'description') ||
          pickTag(block, 'summary') ||
          pickTag(block, 'content:encoded') ||
          pickTag(block, 'content')
      );
      const media = [...block.matchAll(/<(?:media:content|media:thumbnail)\b[^>]*>/gi)]
        .map((match) => match[0].match(/\burl=["']([^"']+)["']/i)?.[1])
        .filter(Boolean);
      const enclosure = block.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*>/i)?.[1];
      const inline = block.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1];
      return { title, link, published, updated: updatedRaw, summary, images: [...new Set([...media, enclosure, inline].filter(Boolean))] };
    })
    .filter((item) => item.title && item.link);
}

export async function fetchText(url, { accept = 'text/html', timeout = 30000, redact = (value) => String(value ?? '').slice(0, 200) } = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${redact(text).slice(0, 120)}`);
  return { text, url: response.url || url, status: response.status };
}

export function extractMeta(html) {
  const meta = {};
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const match of tag[0].matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
    }
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content) meta[key] = decodeEntities(attrs.content);
  }
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!meta['og:title'] && titleTag) meta['og:title'] = stripHtml(titleTag);
  return meta;
}

export function extractJsonLd(html) {
  const values = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      values.push(JSON.parse(decodeEntities(match[1].trim())));
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  return values;
}

export function findDeep(value, key, depth = 0) {
  if (depth > 6 || value == null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeep(item, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key];
    for (const item of Object.values(value)) {
      const found = findDeep(item, key, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function findImage(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImage(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    if (typeof value.image === 'string') return value.image;
    if (Array.isArray(value.image) && typeof value.image[0] === 'string') return value.image[0];
    if (value.image && typeof value.image.url === 'string') return value.image.url;
    for (const item of Object.values(value)) {
      const found = findImage(item, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

const BOILERPLATE = [
  /^TechCrunch (Desktop|Mobile) Logo/i,
  /^TechCrunch$/i,
  /^Subscribe/i,
  /^Sign in/i,
  /^Register/i,
  /^Latest News/i,
  /^Back to homepage/i,
  /^Newsletters/i,
  /^Search/i,
  /^Toggle/i,
  /^Advertisement/i,
  /TechCrunch (Desktop|Mobile) Logo/i,
  /Register now|Get your pass|REGISTER HERE|Sign up for/i,
];

const isBodyParagraph = (text) => text.length >= 60 && !BOILERPLATE.some((pattern) => pattern.test(text));

export function extractArticle(html, fallbackTitle = '') {
  const meta = extractMeta(html);
  const jsonLd = extractJsonLd(html);
  const title = meta['og:title'] || findDeep(jsonLd, 'headline') || fallbackTitle;
  const description = meta['og:description'] || findDeep(jsonLd, 'description') || '';
  const published = meta['article:published_time'] || meta['date'] || findDeep(jsonLd, 'datePublished') || '';
  const modified =
    meta['article:modified_time'] ||
    meta['og:updated_time'] ||
    meta['last-modified'] ||
    findDeep(jsonLd, 'dateModified') ||
    '';
  let imageUrl = meta['og:image'] || meta['twitter:image'] || findImage(jsonLd) || '';
  if (Array.isArray(imageUrl)) imageUrl = imageUrl[0] || '';
  const imageAlt = meta['og:image:alt'] || meta['twitter:image:alt'] || '';
  let content = findDeep(jsonLd, 'articleBody') || '';

  if (!content) {
    const container = html.search(/<div\b[^>]*class=["'][^"']*entry-content[^"']*["'][^>]*>/i);
    const articleEnd = container >= 0 ? html.indexOf('</article>', container) : -1;
    const slice =
      container >= 0
        ? html.slice(container, articleEnd > container ? articleEnd : Math.min(html.length, container + 120000))
        : html;
    content = [...slice.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((match) => stripHtml(match[1]))
      .filter(isBodyParagraph)
      .join('\n\n');
  }

  if (!content) {
    content = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((match) => stripHtml(match[1]))
      .filter(isBodyParagraph)
      .join('\n\n');
  }

  return {
    title: stripHtml(title),
    description: stripHtml(description),
    published,
    modified,
    imageUrl,
    imageAlt,
    content: content.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000),
    meta,
    jsonLd,
  };
}

const FORBIDDEN_IMAGE = /(getty|shutterstock|istock|depositphotos|alamy|(?:^|[/_?&.-])(?:stock|logo|avatar|icon|favicon|sprite|banner)(?:[._/?&=-]|$)|tracking|pixel)/i;
const SMALL_IMAGE = /(?:^|[/_?&])(?:40|64|100|128|150|200|258|300)x(?:40|64|100|128|150|200|258|300)(?:[._/?&]|$)/i;

export function imageVerdict(url, alt = '') {
  if (!url) return { ok: false, reason: 'no_image' };
  if (!/^https:\/\//i.test(url)) return { ok: false, reason: 'not_https' };
  if (FORBIDDEN_IMAGE.test(url)) return { ok: false, reason: 'forbidden_url' };
  if (/\b(logo|avatar|icon)\b|stock photo|getty|shutterstock/i.test(alt)) return { ok: false, reason: 'forbidden_alt' };
  if (SMALL_IMAGE.test(url)) return { ok: false, reason: 'too_small' };
  return { ok: true, reason: 'ok' };
}

export async function downloadImage(url, outDir, { timeout = 30000 } = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/jpeg,image/png,image/*' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`image HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('avif') ? 'avif' : 'jpg';
  const buffer = Buffer.from(await response.arrayBuffer());
  const file = resolve(outDir, `image.${ext}`);
  await writeFile(file, buffer);
  return { file, bytes: buffer.length, type, ext };
}

export function clampText(value, maxChars = 0) {
  const text = String(value ?? '');
  const limit = Number(maxChars) || 0;
  if (limit <= 0 || text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const boundary = cut.search(/\s+\S*$/);
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()} …`;
}

export function buildUserMessage({ item, article, url, now, imageUrl, maxAgeHours = 72, offer = null, maxContentChars = 0, officialCourse = false }) {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const imageBlock = imageUrl
    ? `تصویر شاخص (image_url): ${imageUrl}\nتوضیح تصویر (image_alt): ${article.imageAlt || ''}`
    : 'تصویر شاخص (image_url): ندارد';
  const offerBlock = offer
    ? [
        'این خبر یک آفر است:',
        `تاریخ انقضا: ${offer.date}`,
        `اعتبار باقی‌مانده: ${offer.remainingHours} ساعت`,
        'دسته باید tools باشد و تاریخ انقضا با روز، ماه و سال در متن پست نوشته شود.',
      ].join('\n')
    : '';
  const courseBlock = officialCourse
    ? [
        'این ورودی یک دوره رسمی از خود شرکت هوش مصنوعی روی دامنه رسمی است:',
        'دسته tools است و اعلان دوره خبر محسوب می‌شود؛ آن را با reason_code promo یا off_topic رد نکن.',
        'اگر صفحه اطلاعات کافی دارد، پست خبری کوتاه بنویس و لینک ثبت‌نام رسمی را به عنوان منبع بیاور.',
      ].join('\n')
    : '';
  return [
    `عنوان: ${article.title || item.title}`,
    `تاریخ انتشار: ${article.published || item.published}`,
    `لینک: ${url}`,
    `نام منبع: ${host}`,
    `تاریخ جاری: ${now}`,
    `حداکثر سن مجاز: ${maxAgeHours} ساعت`,
    imageBlock,
    offerBlock,
    courseBlock,
    'یادآوری نگارش: تیتر بدون Markdown و حداکثر ۱۲ کلمه؛ اهمیت را بدون برچسب «چرا مهمه:» داخل یک جمله طبیعی بیاور؛ جزئیات اضافه را در فیلد quote بگذار.',
    '',
    'متن خبر:',
    clampText(article.content, maxContentChars),
  ].filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== '')).join('\n');
}

export async function callModel({ base, apiKey, model, system, user, maxTokens = 2600, timeoutMs = 150000, reasoningEffort = '', redact = (value) => String(value ?? '').slice(0, 200) }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.6,
  };
  if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // The raw text is included in the error below.
    }
    const message = json?.choices?.[0]?.message ?? {};
    return {
      status: response.status,
      ms: Date.now() - started,
      content: typeof message.content === 'string' ? message.content : '',
      reasoningChars: typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0,
      finish: json?.choices?.[0]?.finish_reason ?? '',
      usage: json?.usage ?? null,
      error: !response.ok ? redact(json?.error?.message ?? text) : '',
    };
  } catch (error) {
    return {
      status: 0,
      ms: Date.now() - started,
      content: '',
      reasoningChars: 0,
      finish: '',
      usage: null,
      error: error?.name === 'AbortError' ? 'timeout' : redact(error?.message),
    };
  } finally {
    clearTimeout(timer);
  }
}

const FATAL_STATUS = new Set([400, 401, 403, 404, 422]);

export async function callWithRetry(options, maxAttempts = 4, log = () => {}, waits = [5000, 20000, 45000]) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await callModel(options);
    const hardFail = last.status === 0 || last.status === 429 || last.status >= 500;
    if (!hardFail && last.content.trim()) return { ...last, attempts: attempt };
    if (FATAL_STATUS.has(last.status)) return { ...last, attempts: attempt };
    if (attempt === maxAttempts) break;
    const wait = waits[Math.min(attempt - 1, waits.length - 1)];
    log(`  retry in ${Math.round(wait / 1000)}s (status ${last.status}${last.error ? ` ${last.error.slice(0, 80)}` : ''})`);
    await sleep(wait);
  }
  return { ...last, attempts: maxAttempts };
}

export function extractJson(text) {
  if (!text) return null;
  let value = String(text).trim();
  const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) value = fence[1].trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) value = value.slice(start, end + 1);
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export const normalizeDigits = (value) =>
  String(value)
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));

export const numbersIn = (value) =>
  [...normalizeDigits(value).matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => match[0].replace(/,/g, ''));

const NUMBER_WORDS = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
  fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
  thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', thousand: '1000', million: '1000000', billion: '1000000000',
};

export const spelledNumbersIn = (value) => {
  const text = String(value ?? '').toLowerCase();
  return Object.entries(NUMBER_WORDS)
    .filter(([word]) => new RegExp(`\\b${word}\\b`).test(text))
    .map(([, digit]) => digit);
};

export function visibleLength(value) {
  return String(value ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\u200F/g, '')
    .length;
}

const TERM_FIXES = [
  [/عامل[\u200c\s]*های/gu, 'ایجنت‌های'],
  [/عامل[\u200c\s]*ها/gu, 'ایجنت‌ها'],
  [/عامل[ \u200c]+هوشمند/gu, 'ایجنت هوشمند'],
  [/متن[\u200c\s]*باز/gu, 'اوپن سورس'],
];

export function fixTerminology(value) {
  const text = String(value ?? '');
  return TERM_FIXES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

export function applyLeadPolicy(parsed, lead = {}) {
  if (!parsed || parsed.decision !== 'publish' || !lead.officialCourse) return parsed;
  if (parsed.category === 'tools') return parsed;
  return { ...parsed, category: 'tools' };
}

export function normalizePostFields(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const body = fixTerminology(String(parsed.body ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(
      /^[ \t]*(?:\*\*)?[ \t]*چرا[\s\u200c]+مهم(?:[\s\u200c]+است|[\s\u200c]*ه)?[ \t]*[:：][ \t]*(?:\*\*)?[ \t]*/gmu,
      'اهمیتش اینه که '
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const quote = fixTerminology(String(parsed.quote ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { ...parsed, title: fixTerminology(String(parsed.title ?? '')).trim(), body, quote };
}

export function ensureSourceLine(parsed, { sourceName = '', sourceUrl = '' } = {}) {
  if (!parsed || parsed.decision !== 'publish') return parsed;
  const body = String(parsed.body ?? '').trimEnd();
  if (!body || !sourceUrl) return parsed;
  const lines = body.split('\n');
  const last = [...lines].reverse().find((line) => line.trim())?.trim() ?? '';
  if (/^منبع\s*[:：]/u.test(last) && last.includes(sourceUrl)) return parsed;
  const safeName = String(sourceName || 'منبع')
    .replace(/[\[\]\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'منبع';
  const withoutBrokenSource = /^منبع\s*[:：]/u.test(last)
    ? lines.slice(0, -1).join('\n').trimEnd()
    : body;
  return { ...parsed, body: `${withoutBrokenSource}\n\nمنبع: [${safeName}](${sourceUrl})` };
}

export function fitCaption(parsed, newsDate = '', limit = CAPTION_SAFE_LIMIT) {
  if (!parsed || parsed.decision !== 'publish' || !parsed.image_url) return parsed;
  const captionLengthOf = (value) =>
    visibleLength([value.title, newsDate, value.body, value.quote].filter(Boolean).join('\n\n'));
  if (captionLengthOf(parsed) <= limit) return parsed;
  if (parsed.quote) {
    const withoutQuote = { ...parsed, quote: '' };
    if (captionLengthOf(withoutQuote) <= limit) return withoutQuote;
  }
  return { ...parsed, image_url: '' };
}

export function countTitleWords(value) {
  const title = String(value ?? '').trim();
  if (!title) return 0;
  return title.replace(/\u200c/g, ' ').split(/\s+/).filter(Boolean).length;
}

const TITLE_STOPWORDS = new Set(['و', 'یا', 'با', 'از', 'به', 'در', 'برای', 'که', 'تا', 'بر', 'این', 'آن', 'اما', 'ولی', 'هم']);

export function trimTitle(value, max = TITLE_MAX_WORDS) {
  const title = String(value ?? '').replace(/\*\*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) return title;
  const words = title.split(/\s+/).filter(Boolean);
  const kept = [];
  let count = 0;
  for (const word of words) {
    const weight = word.replace(/\u200c/g, ' ').split(/\s+/).filter(Boolean).length;
    if (count + weight > max) break;
    kept.push(word);
    count += weight;
  }
  if (!kept.length) kept.push(words[0]);
  while (kept.length > 1 && TITLE_STOPWORDS.has(kept[kept.length - 1].replace(/[.,،؛:!؟?]+$/u, ''))) kept.pop();
  return kept.join(' ').replace(/[.,،؛:!؟?]+$/u, '').trim();
}

function normalizeBullets(value) {
  const body = String(value ?? '');
  const lines = body.split('\n');
  const count = lines.filter((line) => /^\s*[-•–]\s+/.test(line)).length;
  if (count === 0 || (count >= 2 && count <= 5)) return body;
  return lines.map((line) => line.replace(/^(\s*)[-•–]\s+/, '$1')).join('\n');
}

function shortenText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const slice = text.slice(0, Math.max(0, max));
  const sentence = Math.max(
    slice.lastIndexOf('.'),
    slice.lastIndexOf('!'),
    slice.lastIndexOf('?'),
    slice.lastIndexOf('؟'),
    slice.lastIndexOf('…'),
    slice.lastIndexOf('\n')
  );
  if (sentence >= Math.min(80, Math.floor(max * 0.5))) return slice.slice(0, sentence + 1).trim();
  const space = slice.lastIndexOf(' ');
  return (space > 0 ? slice.slice(0, space) : slice).trim();
}

function splitSourceLine(value) {
  const lines = String(value ?? '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*منبع\s*[:：]/u.test(lines[index])) {
      return {
        content: lines.slice(0, index).join('\n').trim(),
        source: lines.slice(index).join('\n').trim(),
      };
    }
  }
  return { content: String(value ?? '').trim(), source: '' };
}

export function trimBody(value, max = 990) {
  const { content, source } = splitSourceLine(value);
  if (!content) return String(value ?? '');
  const budget = max - (source ? source.length + 2 : 0);
  if (content.length <= budget) return String(value ?? '');
  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  while (paragraphs.join('\n\n').length > budget && paragraphs.length > 2) {
    let index = 1;
    for (let current = 1; current < paragraphs.length - 1; current += 1) {
      if (paragraphs[current].length < paragraphs[index].length) index = current;
    }
    paragraphs.splice(index, 1);
  }
  let joined = paragraphs.join('\n\n');
  let guard = 0;
  while (joined.length > budget && paragraphs.length >= 2 && guard < 20) {
    let index = 0;
    for (let current = 0; current < paragraphs.length - 1; current += 1) {
      if (paragraphs[current].length > paragraphs[index].length) index = current;
    }
    if (paragraphs[index].length <= 60) break;
    const target = Math.max(60, paragraphs[index].length - (joined.length - budget) - 8);
    const shorter = shortenText(paragraphs[index], target);
    paragraphs[index] = shorter || paragraphs[index].slice(0, 60).trim();
    joined = paragraphs.join('\n\n');
    guard += 1;
  }
  if (joined.length > budget) joined = shortenText(joined, Math.max(0, budget));
  const trimmed = `${joined}${source ? `\n\n${source}` : ''}`.trim();
  return trimmed.length <= max ? trimmed : `${shortenText(joined, Math.max(0, budget))}${source ? `\n\n${source}` : ''}`.trim();
}

export function trimQuote(value, max = QUOTE_MAX_CHARS) {
  const quote = String(value ?? '').trim();
  if (quote.length <= max) return quote;
  return shortenText(quote, max);
}

export function ensureDedupeKey(parsed, { sourceUrl = '', title = '' } = {}) {
  if (!parsed || parsed.decision !== 'publish') return parsed;
  const current = String(parsed.dedupe_key ?? '').trim();
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(current)) return parsed;
  const seed = `${sourceUrl}\n${title || parsed.title || ''}`;
  return { ...parsed, dedupe_key: `post-${contentHash(seed)}` };
}

export function applyMechanicalFixes(parsed, { newsDate = '', sourceName = '', sourceUrl = '', captionLimit = CAPTION_SAFE_LIMIT } = {}) {
  if (!parsed || parsed.decision !== 'publish') return parsed;
  let next = normalizePostFields(parsed);
  next = ensureSourceLine(next, { sourceName, sourceUrl });
  next = ensureDedupeKey(next, { sourceUrl, title: next.title });
  const bounds = lengthBounds(next.post_type) ?? lengthBounds('standard');
  return fitCaption(
    {
      ...next,
      title: trimTitle(next.title),
      body: trimBody(normalizeBullets(next.body), bounds.max),
      quote: trimQuote(next.quote),
    },
    newsDate,
    captionLimit
  );
}

function lengthBounds(type) {
  const range = RANGES[type];
  if (!range) return null;
  return {
    min: Math.ceil(range[0] * 0.9),
    max: Math.floor(range[1] * 1.1),
  };
}

export function lengthOk(type, length) {
  const bounds = lengthBounds(type);
  if (!bounds) return false;
  return length >= bounds.min && length <= bounds.max;
}

const QA_FIX_HINTS = {
  schema: 'همه فیلدهای اسکیمای JSON را کامل و با نوع درست بده؛ key_facts حداقل دو مورد و entities.companies و entities.models آرایه باشند.',
  decision: 'decision فقط publish یا skip باشد.',
  title_words: 'تیتر را به حداکثر ۱۲ کلمه کوتاه کن و فعل و بخش اصلی خبر را نگه دار.',
  body_paragraphs: 'body را به ۲ تا ۳ پاراگراف با یک خط خالی بین آن‌ها تقسیم کن؛ جمله اهمیت باید پاراگراف آخر و مستقل باشد.',
  title_clean: 'تیتر بدون نقطه یا علامت سؤال انتهایی، بدون Markdown و بدون عبارت کلیشه‌ای باشد.',
  bullets: 'بولت یا صفر باشد یا بین ۲ تا ۵.',
  why: 'جمله اهمیت باید آخرین پاراگراف body و قبل از خط منبع باشد؛ برای ابزار، همان جمله کاربرد یا مزیت کافی است.',
  why_label: 'برچسب «چرا مهمه:» نگذار؛ اهمیت را داخل جمله طبیعی بیاور.',
  why_repeat: 'جمله اهمیت را با شروع تازه بازنویسی کن؛ همان شروع پست قبلی را تکرار نکن.',
  quote_length: 'quote حداکثر ۱۲۰۰ کاراکتر باشد.',
  quote_clean: 'quote عبارت ممنوع یا placeholder نداشته باشد.',
  source: 'خط منبع اجباری است و باید آخرین خط body باشد.',
  no_signature: 'امضا یا ایموجی ✉️ نگذار.',
  hashtags: 'هشتگ نگذار.',
  length: 'طول body با post_type بخواند؛ برای standard هدف ۴۰۰ تا ۸۵۰ کاراکتر و سقف مطلق ۹۹۰ کاراکتر است.',
  no_banned: 'عبارت ممنوع را حذف کن.',
  formal_verbs: 'فعل‌های رسمی را محاوره‌ای کن: «گزارش کرده است» → «گزارش کرده»، «رسیده است» → «رسیده»، «می‌شود» → «می‌شه»، «می‌کند» → «می‌کنه».',
  no_placeholder: 'هیچ placeholder مثل [نام] باقی نگذار.',
  script_clean: 'حرف یا واژهٔ چینی، ژاپنی یا کره‌ای در متن نگذار؛ معادل فارسی همان عبارت را بنویس.',
  dedupe_key: 'dedupe_key فقط حروف کوچک لاتین و خط تیره باشد.',
  source_url: 'source_url باید دقیقاً همان URL ورودی باشد.',
  image_exact: 'image_url یا خالی باشد یا دقیقاً همان تصویر مجاز ورودی.',
  caption: 'مجموع تیتر، تاریخ خبر، body و quote حداکثر ۹۰۰ کاراکتر باشد؛ جزئیات کم‌اهمیت را حذف کن، نه منبع و جمله اهمیت را.',
  deep_with_image: 'برای پست deep تصویر نگذار.',
  image_https: 'image_url باید https باشد.',
  category_fresh: 'این آیتم برای این دسته تازه نیست؛ skip بده.',
  category_main: 'دسته باید یکی از tools، models، security یا business باشد.',
  post_type: 'post_type باید breaking یا standard یا deep باشد.',
  importance: 'importance بین ۳ تا ۵ باشد.',
  verification_enum: 'verification باید یکی از official، reported، rumor یا unverified باشد.',
  verification_source: 'وضعیت تأیید باید با نوع منبع بخواند.',
  grounding_superlatives: 'بزرگ‌نمایی یا صفت قطعی که در منبع نیست را حذف کن؛ اگر منبع «بزرگ‌ترین» یا «تاریخی» نگفته، تو هم نگو.',
  numbers_grounded: 'فقط اعدادی را بنویس که در منبع آمده‌اند.',
  image_used: 'تصویر مجاز را استفاده کن یا خالی بگذار.',
};

export function buildQaRepairMessage({ user, parsed, qa, imageUrl = '', previousWhy = '', newsDate = '' }) {
  const problemNames = qa?.problems ?? [];
  const schemaBroken = problemNames.some((name) =>
    ['schema', 'verification_enum', 'verification_source', 'source_url', 'image_exact', 'dedupe_key'].includes(name)
  );
  const notes = problemNames.map((name) => {
    if (name === 'title_words') {
      const currentTitle = String(parsed?.title ?? '').trim();
      const count = countTitleWords(currentTitle);
      return `- title_words: تیتر فعلی «${currentTitle}» ${count} کلمه است؛ آن را به حداکثر ${TITLE_MAX_WORDS} کلمه کوتاه کن و فعل و بخش اصلی خبر را نگه دار.`;
    }
    return `- ${name}: ${QA_FIX_HINTS[name] || 'این مورد را اصلاح کن.'}`;
  });
  const warningNotes = (qa?.warnings ?? [])
    .filter((name) => ['grounding_cues', 'formal_verbs', 'why_repeat', 'why'].includes(name))
    .map((name) => {
      if (name === 'formal_verbs') {
        return '- formal_verbs: فعل رسمی را محاوره‌ای کن؛ «گزارش کرده است» → «گزارش کرده»، «رسیده است» → «رسیده»، «می‌شود» → «می‌شه».';
      }
      if (name === 'why_repeat') {
        return `- why_repeat: جمله اهمیت را با شروع تازه بنویس؛ پست قبلی با این عبارت شروع شده بود: «${String(previousWhy).trim().slice(0, 80)}».`;
      }
      if (name === 'why') {
        return '- why: آخرین پاراگراف body باید اهمیت یا کاربرد روشن را بگوید؛ برای ابزار، همان کاربرد مشخص کافی است و لازم نیست با «اهمیتش اینه که» شروع شود.';
      }
      return '- grounding_cues: عبارت‌های بزرگ‌نمایی یا قطعیتی که در منبع نیست را حذف کن.';
    });
  const title = String(parsed?.title ?? '');
  const body = String(parsed?.body ?? '');
  const quote = String(parsed?.quote ?? '');
  const titleWords = countTitleWords(title);
  const captionChars = visibleLength([title, newsDate, body, quote].filter(Boolean).join('\n\n'));
  const target = CAPTION_SAFE_LIMIT - 50;
  const cut = Math.max(0, captionChars - target);
  const bodyRange = lengthBounds(parsed?.post_type) ?? lengthBounds('standard');
  const minBody = bodyRange.min;
  const maxBody = bodyRange.max;
  const bodyChars = body.length;
  const lengthProblem = problemNames.includes('length');
  const tooShort = lengthProblem && bodyChars < minBody;
  const tooLong = lengthProblem && bodyChars > maxBody;
  const targetBody = parsed?.post_type === 'standard'
    ? 850
    : Math.min(maxBody, RANGES[parsed?.post_type]?.[1] ?? maxBody);
  const bodyLengthLimit = tooShort
    ? `طول body الان ${bodyChars} کاراکتر است؛ برای ${parsed?.post_type} حداقل ${minBody} کاراکتر لازم است. آن را با جزئیات مستند منبع به حدود ${minBody + 80} کاراکتر برسان.`
    : tooLong
      ? `طول body الان ${bodyChars} کاراکتر است؛ برای ${parsed?.post_type} حداکثر ${maxBody} کاراکتر مجاز است (هدف ${targetBody}). آن را به حدود ${targetBody} کاراکتر برسان.`
      : 'طول body با post_type بخواند.';
  const limits = [
    imageUrl
      ? captionChars > target
        ? `طول فعلی تیتر، تاریخ خبر و body ${captionChars} کاراکتر است؛ باید حداکثر ${target} کاراکتر شود، یعنی حدود ${cut} کاراکتر کوتاه‌تر. خط منبع هم داخل همین حساب است.`
        : `طول فعلی تیتر، تاریخ خبر و body ${captionChars} کاراکتر است و در سقف مجاز است؛ لحن را اصلاح کن و از ${target} کاراکتر بیشتر نکن.`
      : bodyLengthLimit,
    `تیتر الان ${titleWords} کلمه است؛ حداکثر ${TITLE_MAX_WORDS} کلمه باشد.`,
    `خروجی باید دقیقاً این بلوک‌ها را داشته باشد و هیچ بلوکی حذف نشود: تیتر؛ پاراگراف ۱ خبر اصلی با حداکثر ۲۲۰ کاراکتر؛ پاراگراف ۲ یک دلیل یا زمینه با حداکثر ۱۸۰ کاراکتر؛ پاراگراف اهمیت با حداکثر ۲۰۰ کاراکتر؛ خط منبع به‌عنوان آخرین خط.${quote ? ' quote را هم بالای خط منبع و داخل همان پیام نگه دار.' : ''}`,
    'پاراگراف اهمیت باید «چرا مهم است» را با جمله‌ای تازه بگوید و شروع پست قبلی را تکرار نکند؛ خط منبع با «منبع:» و لینک همان URL ورودی.',
    'اگر جا کم آمد، فقط پاراگراف ۲ را کوتاه کن؛ اهمیت و منبع را هرگز حذف نکن.',
    ...(imageUrl && quote
      ? ['quote داخل همین پیام می‌ماند و به پیام جدا منتقل نمی‌شود؛ اگر با کوتاه‌کردن body جا نشد، آن را تا حدود ۲۰۰ کاراکتر کوتاه کن.']
      : []),
    schemaBroken
      ? 'خروجی قبلی از نظر فیلدها ناقص است. همه فیلدهای لازم را دوباره پر کن: decision, reason_code, reason, category, post_type, importance, title, body, quote, key_facts (حداقل ۲ مورد), numbers, entities.companies, entities.models, entities.people, verification, source_url, image_url, dedupe_key. برای منبع خبری verification را reported بگذار؛ source_url همان URL ورودی، image_url همان تصویر مجاز ورودی، و dedupe_key حروف کوچک لاتین با خط تیره باشد.'
      : tooShort
        ? 'فقط title و body را اصلاح کن؛ body را گسترش بده و بقیه فیلدها را دقیقاً از خروجی قبلی نگه دار و key_facts و entities را خالی نکن.'
        : 'فقط title و body را کوتاه کن؛ بقیه فیلدها را دقیقاً از خروجی قبلی نگه دار و key_facts و entities را خالی نکن.',
    tooShort
      ? 'این بازنویسی است نه ویرایش جزئی: برای رسیدن به حداقل طول، یک پاراگراف زمینه یا جزئیات مستند از منبع اضافه کن؛ از نتیجه، علت یا بزرگ‌نمایی تازه استفاده نکن.'
      : 'این بازنویسی است نه ویرایش جزئی: جمله‌های کم‌اهمیت را کامل حذف کن، نه اینکه کلمه‌ها را کوتاه کنی.',
    'فقط ۳ عدد مهم را نگه دار؛ بقیه عددها و جزئیات فرعی را حذف کن.',
    quote
      ? 'بولت را خالی بگذار و quote را بالای خط منبع و داخل همان پست نگه دار؛ فقط در صورت کمبود جا آن را کوتاه کن.'
      : 'بولت و quote را خالی بگذار.',
    'فقط از اطلاعات همین منبع بنویس؛ نتیجه، علت، شدت یا بزرگ‌نمایی اضافه نکن. اگر منبع «بزرگ‌ترین» یا «تاریخی» نگفته، تو هم نگو.',
  ];
  return `${user}

## بازبینی کیفیت رد شد
مشکلات خروجی قبلی:
${notes.join('\n')}${warningNotes.length ? `\n${warningNotes.join('\n')}` : ''}

قواعدی که باید رعایت شود:
${limits.map((line) => `- ${line}`).join('\n')}

خروجی قبلی:
${JSON.stringify(parsed)}

${tooShort ? 'همان خبر را با همان فکت‌های منبع گسترده‌تر بازنویسی کن و فقط یک آبجکت JSON معتبر بده.' : 'همان خبر را دوباره و کوتاه‌تر بنویس و فقط یک آبجکت JSON معتبر بده.'}`;
}

export function qaPost(parsed, context) {
  const checks = [];
  const add = (name, ok, detail = '', hard = true) => {
    checks.push({ name, ok: Boolean(ok), detail, hard });
  };
  if (!parsed) {
    add('json', false);
    return { pass: false, checks, problems: ['json'], warnings: [], score: 0, possible: 1, categoryAge: null };
  }

  add('json', true);
  add('decision', parsed.decision === 'publish' || parsed.decision === 'skip');
  if (parsed.decision === 'skip') {
    add('skip_reason', typeof parsed.reason === 'string' && parsed.reason.trim().length > 0);
    add('skip_code', typeof parsed.reason_code === 'string' && parsed.reason_code.trim().length > 0);
    return {
      pass: checks.every((check) => !check.hard || check.ok),
      checks,
      problems: checks.filter((check) => check.hard && !check.ok).map((check) => check.name),
      warnings: [],
      score: checks.filter((check) => check.ok).length,
      possible: checks.length,
      categoryAge: null,
    };
  }

  const normalized = normalizePostFields(parsed);
  const title = normalized.title;
  const body = normalized.body;
  const quote = normalized.quote;
  const words = title ? title.replace(/\u200c/g, ' ').split(/\s+/).filter(Boolean).length : 0;
  const bullets = (body.match(/^\s*[-•–]\s+/gm) || []).length;
  const tags = ((`${body}\n${quote}`).match(/#[\p{L}\p{N}_]+/gu) || []).length;
  const type = parsed.post_type;
  const newsDate = newsDateLine(context.publishedAt);
  const caption = [title, newsDate, body, quote].filter(Boolean).join('\n\n');

  add('schema', POST_TYPES.includes(type) &&
    Number.isInteger(parsed.importance) && parsed.importance >= 1 && parsed.importance <= 5 &&
    VERIFICATIONS.includes(parsed.verification) &&
    MAIN_CATEGORIES.includes(parsed.category) &&
    typeof parsed.source_url === 'string' && parsed.source_url.length > 0 &&
    typeof parsed.image_url === 'string' &&
    (typeof parsed.quote === 'undefined' || typeof parsed.quote === 'string') &&
    Array.isArray(parsed.key_facts) && parsed.key_facts.filter((fact) => typeof fact === 'string' && fact.trim()).length >= 2 &&
    parsed.entities && Array.isArray(parsed.entities.companies) && Array.isArray(parsed.entities.models));
  add('category_main', MAIN_CATEGORIES.includes(parsed.category));
  add('ai_relevance', hasAiMention(`${title}\n${body}\n${quote}`));
  add('post_type', POST_TYPES.includes(type));
  add('importance', Number.isInteger(parsed.importance) && parsed.importance >= 3 && parsed.importance <= 5);
  add('verification_enum', VERIFICATIONS.includes(parsed.verification));

  const verificationSourceOk =
    context.sourceType === 'news'
      ? ['reported', 'rumor', 'unverified'].includes(parsed.verification)
      : context.sourceType === 'official_blog'
        ? parsed.verification === 'official'
        : VERIFICATIONS.includes(parsed.verification);
  add('verification_source', verificationSourceOk, `${context.sourceType}:${parsed.verification}`);

  add('title_words', words > 0 && words <= TITLE_MAX_WORDS);
  add('title_clean', title.length > 0 && !/[.?!؟]\s*$/.test(title) && !/\*\*/.test(title) && !BANNED.some((phrase) => title.includes(phrase)));
  add('bullets', type === 'breaking' ? true : bullets === 0 || (bullets >= 2 && bullets <= 5));
  const whyCue = /(مهمه|مهمه که|مهم اینه|اهمیت|اهمیتش|از اونجایی که|از اونجا که|نکته مهم|نکته اینجاست|از این جهت|به همین دلیل|به همین خاطر|به این ترتیب|از این رو|با این کار|این یعنی|در نتیجه|اثرش|اثر واقعی|اثر این|تأثیر|تاثیر|پیامد|نتیجه‌اش|نتیجه اینه|برای مخاطب|در عمل|در واقع|یعنی)/u;
  const whyUseCase = /(کاربرد|کاربردی|استفاده|برای\s+(?:اجرا|ساخت|راه\s*اندازی|کار|تیم|کسانی|همه)|می‌تونید|می‌تونن|می‌تونی|کمک\s*می‌کنه|اجازه\s*می‌ده|مناسب|به\s*دست|نیاز\s*دارید|کافیه|امکان\s*می\s*ده|می‌سازه|قابل\s*استفاده|جایگزین|به\s*جای)/u;
  const sourceLine = body.match(/^[ \t]*منبع\s*[:：]/m);
  const beforeSource = sourceLine ? body.slice(0, sourceLine.index) : body;
  const paragraphs = beforeSource.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const lastParagraph = paragraphs[paragraphs.length - 1] || '';
  const whyOk =
    type === 'breaking' ||
    whyCue.test(lastParagraph) ||
    (parsed.category === 'tools' && whyUseCase.test(lastParagraph));
  add('why', whyOk, '', false);
  add('body_paragraphs', type === 'breaking' || paragraphs.length >= 2);
  add('why_label', !/چرا[\s\u200c]+مهم(?:[\s\u200c]+است|[\s\u200c]*ه)?[ \t]*[:：]/u.test(body));
  const whyOpener = (text) =>
    String(text).replace(/[«»"'’]/g, '').trim().split(/\s+/).slice(0, 5).join(' ');
  const previousWhy = String(context.previousWhy ?? '').trim();
  const whyRepeat =
    Boolean(previousWhy) && Boolean(lastParagraph) && whyOpener(lastParagraph) === whyOpener(previousWhy);
  add('why_repeat', !whyRepeat, whyRepeat ? 'true' : '', false);
  add('quote_length', !quote || quote.length <= QUOTE_MAX_CHARS, quote ? `${quote.length}` : '');
  add('quote_clean', !quote || (
    !BANNED.some((phrase) => quote.includes(phrase)) &&
    !/\[(نام|تاریخ|لینک|عدد|شرکت|منبع)\]/u.test(quote) &&
    !quote.includes('✉️')
  ));
  const lastBodyLine = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() ?? '';
  const sourceLineUrl = lastBodyLine.match(/https?:\/\/[^\s)]+/)?.[0] ?? '';
  add('source', /^منبع\s*[:：]/u.test(lastBodyLine) && (() => {
    try {
      return canonicalEqual(sourceLineUrl, context.url);
    } catch {
      return false;
    }
  })());
  add('no_signature', !body.includes('✉️') && !quote.includes('✉️'));
  add('hashtags', tags === 0);
  add('length', lengthOk(type, body.length), `${body.length}`);
  add('no_banned', !BANNED.some((phrase) => body.includes(phrase)) && !BANNED.some((phrase) => quote.includes(phrase)));
  const proseForStyle = `${body}\n${quote}`
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ');
  const formalPatterns = [
    /(?:کرده|شده|بوده|رسیده|بسته|گفته|داده|رفته|آمده|ساخته|اعلام|ثبت|شکسته|نشسته)\s+است(?=\s|[.,،؛!؟]|$)/u,
    /ن?می\s*باشد(?=\s|[.,،؛!؟]|$)/u,
    /ن?می\s*شود(?=\s|[.,،؛!؟]|$)/u,
    /ن?می\s*کند(?=\s|[.,،؛!؟]|$)/u,
    /ن?می\s*کنند(?=\s|[.,،؛!؟]|$)/u,
    /ن?می\s*دهد(?=\s|[.,،؛!؟]|$)/u,
    /ن?می\s*دهند(?=\s|[.,،؛!؟]|$)/u,
  ];
  const formalCount = formalPatterns.filter((pattern) => pattern.test(proseForStyle)).length;
  add('formal_verbs', formalCount === 0, formalCount ? `${formalCount}` : '', false);
  add('no_placeholder', !/\[(نام|تاریخ|لینک|عدد|شرکت|منبع)\]/u.test(`${body}\n${quote}`));
  add('script_clean', !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u.test(`${title}\n${body}\n${quote}`));
  add('dedupe_key', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(parsed.dedupe_key ?? '')));
  add('source_url', (() => {
    try {
      return canonicalEqual(parsed.source_url, context.url);
    } catch {
      return false;
    }
  })());
  add('image_exact', parsed.image_url === '' || parsed.image_url === context.imageUrl);
  add('caption', !parsed.image_url || visibleLength(caption) <= CAPTION_SAFE_LIMIT, visibleLength(caption) ? `${visibleLength(caption)}` : '');
  add('news_date', Boolean(newsDate), newsDate, false);
  add('deep_with_image', !(parsed.image_url && type === 'deep'));
  add('image_https', !parsed.image_url || /^https:\/\//.test(parsed.image_url));

  const categoryFresh = freshness(context.publishedAt, context.now, { maxAgeHours: windowFor(parsed.category) });
  add('category_fresh', categoryFresh.ok, `${categoryFresh.ageHours}h/${categoryFresh.maxAgeHours}h`);

  if (context.offer?.detected) {
    add('offer_category', parsed.category === 'tools');
    add('offer_source', context.sourceType === 'official_blog');
    add('offer_expiry', Boolean(context.offer.expiry?.date) && dateMentioned(body, context.offer.expiry));
    add('offer_remaining', Number(context.offer.remainingHours) >= Number(context.offer.minRemainingHours ?? 24));
    add('offer_referral', !hasReferral(`${body}\n${parsed.source_url ?? ''}`));
  }

  if (context.imageUrl && !parsed.image_url) {
    add('image_used', false, 'model dropped the allowed image', false);
  }

  const sourceNumbers = new Set([
    ...numbersIn([context.title, context.description, context.content].join(' ')),
    ...spelledNumbersIn([context.title, context.description, context.content].join(' ')),
  ]);
  const bodyForNumbers = `${body}\n${quote}`
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ');
  const bodyNumbers = [...new Set(numbersIn(bodyForNumbers))].filter((number) => number.length > 1);
  const unmatched = bodyNumbers.filter((number) => !sourceNumbers.has(number));
  add('numbers_grounded', unmatched.length === 0, unmatched.slice(0, 8).join(','), false);

  const sourceText = [context.title, context.description, context.content].filter(Boolean).join(' ').toLowerCase();
  const hasSourceWord = (word) => new RegExp(`\\b${word.replace(/\s+/g, '\\s+')}\\b`, 'i').test(sourceText);
  const cueRules = [
    { label: 'جلوگیری', fa: /جلوگیری|پیشگیری/u, en: ['prevent', 'prevents', 'prevented', 'avoid', 'avoids', 'avert', 'stop', 'stops'] },
    {
      label: 'باعث/منجر',
      fa: /(?:باعث|منجر|موجب)/u,
      en: ['cause', 'causes', 'caused', 'lead to', 'leads to', 'led to', 'result in', 'results in', 'trigger', 'triggers', 'allow', 'allows', 'allowed', 'let', 'lets', 'enable', 'enables', 'enabled'],
    },
    { label: 'دقیقاً', fa: /دقیقاً/u, en: ['exactly', 'precisely'] },
    { label: 'همیشه', fa: /همیشه/u, en: ['always'] },
    { label: 'اولین', fa: /اولین/u, en: ['first'] },
    { label: 'بزرگ‌ترین', fa: /بزرگ[\s\u200c]*ترین/u, en: ['largest', 'biggest', 'greatest'] },
    { label: 'بیشترین', fa: /بیش[\s\u200c]*ترین/u, en: ['most', 'highest'] },
    { label: 'تاریخی', fa: /تاریخی/u, en: ['historic', 'historical', 'record'] },
  ];
  const flaggedCues = cueRules
    .filter((rule) => rule.fa.test(`${title}\n${body}\n${quote}`) && !rule.en.some(hasSourceWord))
    .map((rule) => rule.label);
  add('grounding_cues', flaggedCues.length === 0, flaggedCues.join(','), false);
  const hardCues = flaggedCues.filter((label) => ['بزرگ‌ترین', 'بیشترین', 'تاریخی'].includes(label));
  add('grounding_superlatives', hardCues.length === 0, hardCues.join(','), true);

  const problems = checks.filter((check) => check.hard && !check.ok).map((check) => check.name);
  return {
    pass: problems.length === 0,
    checks,
    problems,
    warnings: checks.filter((check) => !check.hard && !check.ok).map((check) => check.name),
    score: checks.filter((check) => check.ok).length,
    possible: checks.length,
    categoryAge: categoryFresh,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPreviewBody(value) {
  return escapeHtml(String(value ?? ''))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^[ \t]*[-–•][ \t]+/gm, '• ')
    .replace(/\n/g, '<br>');
}

function splitPreviewSource(body) {
  const text = String(body ?? '').trimEnd();
  if (!text) return { body: '', source: '' };
  const lines = text.split('\n');
  const lastIndex = lines.findLastIndex((line) => line.trim());
  if (lastIndex < 0 || !/^منبع\s*[:：]/u.test(lines[lastIndex].trim())) {
    return { body: text, source: '' };
  }
  return { body: lines.slice(0, lastIndex).join('\n').trimEnd(), source: lines[lastIndex].trim() };
}

export function renderPreview({ post, qa, imageUsed, imagePath, imageVerdict, sourceUrl, inspectOnly, banner }) {
  const checks = qa?.checks ?? [];
  const rows = checks
    .map(
      (check) =>
        `<tr class="${check.ok ? 'ok' : 'bad'}"><td>${escapeHtml(check.name)}</td><td>${check.ok ? 'قبول' : 'رد'}</td><td>${escapeHtml(check.detail || '')}</td></tr>`
    )
    .join('\n');
  const title = post?.title || 'بدون عنوان';
  const body = post?.body || '';
  const { body: bodyMain, source: bodySource } = splitPreviewSource(body);
  const imageBlock = imageUsed
    ? `<img src="${escapeHtml(imagePath)}" alt="">`
    : imagePath
      ? `<div class="candidate"><div class="note">تصویر نامزد استفاده نشد${imageVerdict ? ` — ${escapeHtml(imageVerdict)}` : ''}</div><img src="${escapeHtml(imagePath)}" alt=""></div>`
      : '<div class="noimg">بدون تصویر</div>';
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>پیش‌نمایش محلی پست</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 32px 16px; background: #eef2f7; font-family: Vazirmatn, Tahoma, sans-serif; color: #13202e; }
  .wrap { max-width: 760px; margin: 0 auto; }
  .banner { background: #fff4d6; border: 1px solid #e6c56a; border-radius: 12px; padding: 10px 14px; margin-bottom: 16px; font-size: 14px; }
  .card { background: #fff; border-radius: 18px; overflow: hidden; box-shadow: 0 12px 40px rgba(15, 35, 60, .12); }
  .card img { display: block; width: 100%; height: auto; }
  .content { padding: 20px 22px 24px; }
  h1 { font-size: 24px; line-height: 1.5; margin: 0 0 14px; }
  .caption { white-space: normal; line-height: 2; font-size: 17px; }
  .date { margin: 0 0 14px; color: #5b6b7d; font-size: 14px; }
  .caption a { color: #0b63c5; }
  .quote { margin-top: 16px; padding: 12px 16px; border-right: 4px solid #9fb4cc; background: #f4f7fb; border-radius: 8px; line-height: 2; font-size: 16px; }
  .source { margin-top: 18px; font-size: 13px; color: #5b6b7d; word-break: break-all; }
  .candidate { border-top: 1px solid #e5eaf0; }
  .candidate .note { padding: 10px 16px; background: #fff8e8; color: #7a5a11; font-size: 13px; }
  .noimg { padding: 40px; text-align: center; color: #728196; background: #f6f8fb; }
  details { margin-top: 18px; background: #fff; border-radius: 12px; padding: 14px 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 6px 8px; border-bottom: 1px solid #edf1f6; text-align: right; }
  tr.bad td:nth-child(2) { color: #b42318; font-weight: 700; }
  tr.ok td:nth-child(2) { color: #137a3f; }
  .muted { color: #5b6b7d; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="banner">${escapeHtml(banner || 'پیش‌نمایش محلی — هیچ چیزی در تلگرام منتشر نشده است')}${inspectOnly ? ' — فقط بررسی ورودی' : ''}</div>
  <div class="card">
    ${imageBlock}
    <div class="content">
      <h1>${escapeHtml(title)}</h1>
      ${post?.news_date ? `<div class="date">${escapeHtml(post.news_date)}</div>` : ''}
      <div class="caption">${formatPreviewBody(bodyMain)}</div>
      ${post?.quote ? `<blockquote class="quote">${formatPreviewBody(post.quote)}</blockquote>` : ''}
      ${bodySource ? `<div class="source">${formatPreviewBody(bodySource)}</div>` : ''}
    </div>
  </div>
  <details>
    <summary>نتیجه بازبینی کیفیت</summary>
    <p class="muted">وضعیت کلی: ${qa?.pass ? 'قبول' : 'نیازمند اصلاح'} — امتیاز ${qa?.score ?? 0} از ${qa?.possible ?? 0}</p>
    <p class="muted">آدرس ورودی: ${escapeHtml(sourceUrl)}</p>
    <table>${rows}</table>
  </details>
</div>
</body>
</html>`;
}

function canonicalEqual(left, right) {
  return canonicalUrl(left) === canonicalUrl(right);
}
