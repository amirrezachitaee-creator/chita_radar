import { canonicalUrl, contentHash } from './normalize.mjs';
import { fetchText, extractArticle } from './engine.mjs';
import { effectiveDate, effectiveDateParts } from './newstime.mjs';
import { dateKey, dedupeKeys } from './store.mjs';

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const EFFECTIVE_PATTERNS = [
  /\btakes?\s+effect\s+(?:on\s+)?([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?/i,
  /\beffective\s+(?:as\s+of\s+|on\s+)?([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?/i,
  /\b(?:effective\s+date|goes\s+into\s+effect)[:\s]+([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?/i,
];

const pad = (value) => String(value).padStart(2, '0');

const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const decode = (value) =>
  String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

export function parseEffectiveDate(text, { after = '', now = '' } = {}) {
  const source = normalize(text);
  const match = EFFECTIVE_PATTERNS.map((pattern) => source.match(pattern)).find(Boolean);
  if (!match) return null;
  const month = MONTHS[String(match[1]).toLowerCase()];
  const day = Number(match[2]);
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) return null;

  const baseMs = Date.parse(after) || Date.parse(now) || Date.now();
  let year = match[3] ? Number(match[3]) : new Date(baseMs).getUTCFullYear();
  let stamp = Date.UTC(year, month - 1, day);
  const check = new Date(stamp);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (!match[3] && stamp < baseMs - 45 * 86400000) {
    year += 1;
    stamp = Date.UTC(year, month - 1, day);
  }
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return {
    iso,
    isoDateTime: `${iso}T12:00:00Z`,
    label: effectiveDate(`${iso}T12:00:00Z`),
    parts: effectiveDateParts(`${iso}T12:00:00Z`),
  };
}

export function extractCountryList(html) {
  const source = String(html ?? '');
  const marker = source.search(/Countries and regions where we currently offer/i);
  const slice = marker >= 0 ? source.slice(marker) : source;
  const close = slice.indexOf('</ul>');
  const block = close >= 0 ? slice.slice(0, close) : slice.slice(0, 80000);
  const names = [...block.matchAll(/<li>([^<]{2,80})<\/li>/g)]
    .map((match) => decode(match[1]).trim())
    .filter((name) => /^[A-Za-z]/.test(name));
  return [...new Set(names)];
}

export function diffLines(before, after, limit = 8) {
  const toSet = (value) =>
    new Set(
      String(value ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    );
  const left = toSet(before);
  const right = toSet(after);
  return {
    added: [...right].filter((line) => !left.has(line)).slice(0, limit),
    removed: [...left].filter((line) => !right.has(line)).slice(0, limit),
  };
}

function ensureTarget(policyState, sourceId) {
  if (!policyState.targets || typeof policyState.targets !== 'object') policyState.targets = {};
  if (!policyState.targets[sourceId]) {
    policyState.targets[sourceId] = {
      pages: {},
      effective_date: '',
      last_reminder_date: '',
      baseline_at: '',
      last_change_at: '',
      countries: null,
    };
  }
  const target = policyState.targets[sourceId];
  if (!target.pages || typeof target.pages !== 'object') target.pages = {};
  return target;
}

export function clearReminderDay(policyState, sourceId, date = '') {
  const target = policyState?.targets?.[sourceId];
  if (!target?.last_reminder_date) return false;
  if (date && target.last_reminder_date !== date) return false;
  target.last_reminder_date = '';
  return true;
}

function officialSentence(text, pattern) {
  const source = normalize(text);
  const index = source.search(pattern);
  if (index < 0) return '';
  const before = Math.max(
    source.lastIndexOf('. ', index),
    source.lastIndexOf('? ', index),
    source.lastIndexOf('! ', index)
  );
  const begin = before >= 0 ? before + 2 : 0;
  const end = source.indexOf('.', index);
  return (end >= 0 ? source.slice(begin, end + 1) : source.slice(begin)).trim();
}

function reminderFacts({ source, effective, countries, policyText }) {
  const effectiveQuote = officialSentence(policyText, /takes?\s+effect/i);
  const prohibitionQuote = officialSentence(policyText, /prohibits the use of Claude/i);
  const lines = [
    `به‌روزرسانی رسمی سیاست استفادهٔ آنتروپیک؛ تاریخ اجرا: ${effective.label} (${effective.iso}).`,
  ];
  if (effectiveQuote) lines.push(`نقل رسمی: «${effectiveQuote}»`);
  lines.push(
    'این به‌روزرسانی روشن می‌کند استفاده از کلاد برای سه گروه ممنوع است: افرادی که در منطقه‌های پشتیبانی‌نشده حضور فیزیکی دارند؛ شرکت‌هایی که در آن منطقه‌ها ثبت یا مستقر شده‌اند؛ و شرکت‌هایی که عمده مالکیت یا کنترلشان در اختیار افراد یا نهادهای همان منطقه‌هاست.'
  );
  if (prohibitionQuote) lines.push(`نقل رسمی: «${prohibitionQuote}»`);
  if (countries?.verified) {
    lines.push(
      'فهرست رسمی کشورهای پشتیبانی‌شده ایران را شامل نمی‌شود و صفحهٔ رسمی می‌گوید هر کشور یا منطقهٔ فهرست‌نشده پشتیبانی نمی‌شود.'
    );
  }
  lines.push('صفحهٔ رسمی هیچ زمان‌بندی یا برنامهٔ مسدودسازی حساب اعلام نکرده است.');
  lines.push(`صفحهٔ رسمی: ${source.url}`);
  return lines.join('\n');
}

function changeFacts({ source, page, diff, effective }) {
  const lines = [`صفحهٔ رسمی «${page.name}» آنتروپیک تغییر کرد: ${page.url}`];
  if (diff.added.length) lines.push(`خطوط تازه:\n${diff.added.map((line) => `+ ${line}`).join('\n')}`);
  if (diff.removed.length) lines.push(`خطوط حذف‌شده:\n${diff.removed.map((line) => `- ${line}`).join('\n')}`);
  lines.push(`متن فعلی صفحه:\n${page.text.slice(0, 2600)}`);
  if (effective) lines.push(`تاریخ اجرای اعلام‌شده: ${effective.label} (${effective.iso}).`);
  lines.push(`صفحهٔ رسمی سیاست: ${source.url}`);
  return lines.join('\n');
}

export async function watchPolicySource({
  source,
  policyState,
  now,
  fetchImpl = fetchText,
  redact,
  reminderDays = 7,
  slotDate = '',
  sampleChars = 4000,
}) {
  const target = ensureTarget(policyState, source.id);
  const today = slotDate || dateKey(now);
  const pages = Array.isArray(source.watch_urls) ? source.watch_urls : [];
  const errors = [];
  const results = [];
  let policyText = '';
  let policyPublished = '';

  for (const entry of pages) {
    const url = typeof entry === 'string' ? entry : entry.url;
    const parser = typeof entry === 'string' ? 'article' : entry.parser || 'article';
    const name = typeof entry === 'string' ? url : entry.label_fa || entry.name || url;
    let page;
    try {
      page = await fetchImpl(url, {
        accept: 'text/html,application/xhtml+xml,text/plain,*/*',
        redact,
      });
    } catch (error) {
      errors.push({ url, error: String(error?.message ?? error) });
      continue;
    }
    const finalUrl = page.url || url;
    let text = '';
    let published = '';
    let countries = null;
    if (parser === 'countries') {
      countries = extractCountryList(page.text);
      text = countries.join('\n');
    } else {
      const article = extractArticle(page.text, '', finalUrl);
      text = article.content;
      published = article.published;
      if (parser === 'policy' || url === source.url) {
        policyText = text;
        policyPublished = published;
      }
    }
    if (!text) {
      errors.push({ url, error: 'empty_content' });
      continue;
    }
    const hash = contentHash(text);
    const previous = target.pages[url] ?? null;
    results.push({
      url: finalUrl,
      requestedUrl: url,
      name,
      parser,
      published,
      text,
      hash,
      previous,
      changed: Boolean(previous && previous.hash !== hash),
      countries,
    });
    target.pages[url] = {
      hash,
      chars: text.length,
      name,
      checked_at: now,
      sample: text.slice(0, sampleChars),
    };
  }

  const firstBaseline = !target.baseline_at;
  if (firstBaseline) target.baseline_at = now;

  const effective = policyText ? parseEffectiveDate(policyText, { after: policyPublished, now }) : null;
  if (effective) target.effective_date = effective.iso;

  const countriesPage = results.find((result) => result.parser === 'countries' && result.countries);
  const countryInfo = countriesPage
    ? {
        verified: countriesPage.countries.length > 20,
        count: countriesPage.countries.length,
        hasIran: countriesPage.countries.some((name) => /^iran$/i.test(name)),
        checked_at: now,
      }
    : null;
  if (countryInfo) target.countries = countryInfo;

  const changedPages = results.filter((result) => result.changed);
  if (changedPages.length) target.last_change_at = now;

  const items = [];
  for (const page of changedPages.slice(0, 2)) {
    const diff = diffLines(page.previous?.sample ?? '', page.text.slice(0, sampleChars));
    items.push({
      policyKind: 'change',
      title: `به‌روزرسانی ${page.name} آنتروپیک`,
      link: source.url,
      canonical: `${page.url}#policy-${page.hash.slice(0, 10)}`,
      published: now,
      summary: `صفحهٔ رسمی ${page.name} آنتروپیک تغییر کرد.`,
      messageText: changeFacts({ source, page, diff, effective }),
      effectiveDate: effective?.iso ?? target.effective_date ?? '',
      pageUrl: page.url,
      pageLabel: page.name,
      pageHash: page.hash,
      keys: [`url:${contentHash(`policy:${source.id}:${page.url}:${page.hash}`)}`],
    });
  }

  let reminder = null;
  if (effective && !changedPages.length) {
    const effectiveMs = Date.parse(`${effective.iso}T00:00:00+03:30`);
    const nowMs = Date.parse(now);
    const windowStart = effectiveMs - Math.max(0, Number(reminderDays) || 0) * 86400000;
    const windowEnd = effectiveMs + 86400000;
    const countriesReady = Boolean(countryInfo?.verified);
    if (Number.isFinite(nowMs) && nowMs >= windowStart && nowMs < windowEnd && countriesReady) {
      if (target.last_reminder_date !== today) {
        const title = `سیاست استفادهٔ آنتروپیک از ${effective.parts.day} ${effective.parts.month} اجرا می‌شود`;
        reminder = {
          policyKind: 'effective_reminder',
          title,
          link: source.url,
          canonical: canonicalUrl(source.url),
          published: now,
          summary: `یادآوری تاریخ اجرای سیاست استفادهٔ آنتروپیک: ${effective.label}.`,
          messageText: reminderFacts({ source, effective, countries: countryInfo, policyText }),
          effectiveDate: effective.iso,
          pageUrl: source.url,
          pageLabel: 'خبر سیاست استفاده',
          pageHash: '',
          keys: dedupeKeys({ url: source.url, title }),
        };
        items.push(reminder);
      }
    }
  }

  return {
    items,
    changes: changedPages.map((page) => ({ url: page.url, name: page.name, hash: page.hash })),
    changedPages,
    reminder,
    effective,
    countries: countryInfo,
    errors,
    baseline: firstBaseline,
  };
}
