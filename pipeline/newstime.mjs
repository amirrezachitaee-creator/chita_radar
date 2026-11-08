const TEHRAN_PERSIAN = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'Asia/Tehran',
});

export function newsDate(value) {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return '';
  const parts = Object.fromEntries(
    TEHRAN_PERSIAN.formatToParts(new Date(ms)).map((part) => [part.type, part.value])
  );
  if (!parts.weekday || !parts.day || !parts.month || !parts.year) return '';
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`;
}

export function newsDateLine(value) {
  const date = newsDate(value);
  return date ? `📅 تاریخ خبر: ${date}` : '';
}

const TEHRAN_PERSIAN_DATE = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'Asia/Tehran',
});

export function effectiveDateParts(value) {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(
    TEHRAN_PERSIAN_DATE.formatToParts(new Date(ms)).map((part) => [part.type, part.value])
  );
  if (!parts.day || !parts.month || !parts.year) return null;
  return { day: parts.day, month: parts.month, year: parts.year, text: `${parts.day} ${parts.month} ${parts.year}` };
}

export function effectiveDate(value) {
  return effectiveDateParts(value)?.text ?? '';
}

export function effectiveDateLine(value) {
  const date = effectiveDate(value);
  return date ? `📅 تاریخ اجرا: ${date}` : '';
}

const normalizeDigits = (value) =>
  String(value ?? '')
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));

export function mentionsEffectiveDate(body, value) {
  const parts = effectiveDateParts(value);
  if (!parts) return false;
  const text = normalizeDigits(body).replace(/\u200c/g, ' ').replace(/\s+/g, ' ');
  const day = normalizeDigits(parts.day);
  const month = parts.month.replace(/\u200c/g, ' ');
  const year = normalizeDigits(parts.year);
  return (
    text.includes(`${day} ${month}`) ||
    text.includes(`${month} ${day}`) ||
    text.includes(`${day} ${month} ${year}`) ||
    text.includes(String(value))
  );
}
