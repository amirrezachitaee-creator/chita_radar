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
  return date ? `تاریخ خبر: ${date}` : '';
}
