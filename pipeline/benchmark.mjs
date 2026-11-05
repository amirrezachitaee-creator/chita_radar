const MONTHS = new Map([
  ['january', 1],
  ['february', 2],
  ['march', 3],
  ['april', 4],
  ['may', 5],
  ['june', 6],
  ['july', 7],
  ['august', 8],
  ['september', 9],
  ['october', 10],
  ['november', 11],
  ['december', 12],
  ['jan', 1],
  ['feb', 2],
  ['mar', 3],
  ['apr', 4],
  ['jun', 6],
  ['jul', 7],
  ['aug', 8],
  ['sep', 9],
  ['sept', 9],
  ['oct', 10],
  ['nov', 11],
  ['dec', 12],
]);

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['#39', "'"],
  ['#x27', "'"],
]);

export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
    const key = code.toLowerCase();
    if (ENTITIES.has(key)) return ENTITIES.get(key);
    if (/^#x/.test(key)) {
      const point = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(point) ? String.fromCodePoint(point) : whole;
    }
    if (/^#/.test(key)) {
      const point = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : whole;
    }
    return whole;
  });
}

export function textOf(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseLongDate(value) {
  const match = String(value ?? '')
    .trim()
    .match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!match) return '';
  const month = MONTHS.get(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !day || day > 31) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseArticleIndex(html, baseUrl = 'https://artificialanalysis.ai') {
  const items = [];
  const seen = new Set();
  const re = /href="([^"]*\/articles\/[^"?#]+)"/g;
  let match;
  while ((match = re.exec(String(html ?? '')))) {
    const start = match.index;
    const end = html.indexOf('</a>', start);
    const block = html.slice(start, end > start ? end : start + 3000);
    const heading = block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    if (!heading) continue;
    const date = block.match(/<p\b[^>]*text-muted-foreground[^>]*>([^<]{4,40})<\/p>/i);
    if (!date) continue;
    const published = parseLongDate(textOf(date[1]));
    const title = textOf(heading[1]);
    if (!published || !title) continue;
    let link;
    try {
      link = new URL(match[1], baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(link)) continue;
    seen.add(link);
    items.push({ title, link, published, summary: '' });
  }
  return items;
}

export async function fetchArticleIndex(source, fetchImpl, redact) {
  const page = await fetchImpl(source.index_url, {
    accept: 'text/html,application/xhtml+xml',
    redact,
  });
  return parseArticleIndex(page.text, source.url || source.index_url);
}
