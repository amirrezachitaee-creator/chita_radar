import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

const PRE_GATE_HOURS = config.freshness_hours.pre_gate;
const CATEGORY_WINDOW_HOURS = Object.fromEntries(
  Object.entries(config.freshness_hours).filter(([key]) => key !== 'pre_gate')
);
const EVERGREEN_HOURS = config.freshness_hours.education;
const MAX_FUTURE_HOURS = config.max_future_hours;

const TRACKING = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source', '_hsenc', '_hsmi',
]);

export function canonicalUrl(raw) {
  const u = new URL(String(raw));
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const query = u.searchParams.toString();
  return `${u.protocol}//${u.host}${path}${query ? `?${query}` : ''}`;
}

export function contentHash(text) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function windowFor(category, { allowEvergreen = false } = {}) {
  if (allowEvergreen) return EVERGREEN_HOURS;
  return CATEGORY_WINDOW_HOURS[category] ?? PRE_GATE_HOURS;
}

export function freshness(publishedAt, now, { maxAgeHours = PRE_GATE_HOURS } = {}) {
  const published = Date.parse(String(publishedAt ?? ''));
  if (!Number.isFinite(published)) return { ok: false, reason: 'no_date', ageHours: null, maxAgeHours };
  const nowMs = Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const ageHours = Math.round(((nowMs - published) / 36e5) * 10) / 10;
  if (ageHours < -MAX_FUTURE_HOURS) return { ok: false, reason: 'bad_date', ageHours, maxAgeHours };
  if (ageHours > maxAgeHours) return { ok: false, reason: 'stale', ageHours, maxAgeHours };
  return { ok: true, reason: 'ok', ageHours, maxAgeHours };
}

export function evaluateItem(item, { now, category, allowEvergreen = false }) {
  const maxAgeHours = windowFor(category, { allowEvergreen });
  const fresh = freshness(item.published_at, now, { maxAgeHours });
  let canonical;
  try {
    canonical = canonicalUrl(item.url);
  } catch {
    return { id: item.id, ok: false, reason: 'bad_url', ageHours: fresh.ageHours, maxAgeHours, canonical: '', key: '' };
  }
  return {
    id: item.id,
    ok: fresh.ok,
    reason: fresh.reason,
    ageHours: fresh.ageHours,
    maxAgeHours,
    canonical,
    key: `${contentHash(canonical)}:${contentHash(item.content)}`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node pipeline/normalize.mjs <items.json> [--now ISO]');
    process.exit(1);
  }
  const nowIndex = rest.indexOf('--now');
  const now = nowIndex >= 0 ? rest[nowIndex + 1] : new Date().toISOString();
  const items = JSON.parse(await readFile(file, 'utf8'));
  const known = new Set(Object.keys(CATEGORY_WINDOW_HOURS));
  console.log(`NOW ${now}`);
  console.log('ID            AGE_H     LIMIT_H   OK    REASON       KEY');
  for (const item of items) {
    const category = known.has(item.category) ? item.category : known.has(item.expected) ? item.expected : undefined;
    const r = evaluateItem(item, { now, category });
    console.log(
      r.id.padEnd(13) +
        String(r.ageHours).padEnd(10) +
        String(r.maxAgeHours).padEnd(10) +
        (r.ok ? 'yes' : 'no').padEnd(6) +
        r.reason.padEnd(13) +
        r.key
    );
  }
}
