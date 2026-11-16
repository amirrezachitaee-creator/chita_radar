import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const TIME_KEYS = [
  'at',
  'updatedAt',
  'updated_at',
  'doneAt',
  'checked_at',
  'last_at',
  'createdAt',
  'sentAt',
  'requestedAt',
];

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function timeOf(value) {
  if (!isObject(value)) return NaN;
  for (const key of TIME_KEYS) {
    const at = Date.parse(String(value[key] ?? ''));
    if (Number.isFinite(at)) return at;
  }
  return NaN;
}

function preferLater(local, origin) {
  const localAt = timeOf(local);
  const originAt = timeOf(origin);
  if (Number.isFinite(localAt) && Number.isFinite(originAt) && localAt !== originAt) {
    return localAt > originAt ? local : origin;
  }
  return null;
}

export function mergeValue(local, origin) {
  if (Array.isArray(local) || Array.isArray(origin)) {
    return mergeArray(local, origin, (entry) => {
      if (isObject(entry)) {
        return String(entry.id ?? entry.post_key ?? entry.url ?? entry.title ?? JSON.stringify(entry));
      }
      return JSON.stringify(entry);
    });
  }
  if (isObject(local) && isObject(origin)) {
    return preferLater(local, origin) ?? mergeObject(local, origin);
  }
  if (typeof local === 'number' && typeof origin === 'number') return Math.max(local, origin);
  if (local === undefined || local === null || local === '') return origin;
  return local;
}

function mergeObject(local, origin) {
  const out = { ...(isObject(origin) ? origin : {}) };
  for (const [key, value] of Object.entries(isObject(local) ? local : {})) {
    out[key] = key in out ? mergeValue(value, out[key]) : value;
  }
  return out;
}

export function mergeArray(local, origin, keyOf) {
  const out = new Map();
  for (const entry of [...(Array.isArray(local) ? local : []), ...(Array.isArray(origin) ? origin : [])]) {
    const key = keyOf(entry);
    if (!out.has(key)) {
      out.set(key, entry);
      continue;
    }
    const current = out.get(key);
    const later = preferLater(current, entry);
    out.set(key, later ?? current);
  }
  return [...out.values()];
}

export function mergeJson(local, origin) {
  return mergeObject(local, origin);
}

function laterIso(a, b) {
  return [a, b].filter(Boolean).sort().at(-1) ?? '';
}

export function mergeTelegram(local, origin) {
  const out = mergeObject(local, origin);
  for (const key of new Set([...Object.keys(local ?? {}), ...Object.keys(origin ?? {})])) {
    const mine = local?.[key];
    const theirs = origin?.[key];
    if (!isObject(mine) || !isObject(theirs)) continue;
    out[key] = {
      ...theirs,
      ...mine,
      last_id: Math.max(Number(mine.last_id) || 0, Number(theirs.last_id) || 0),
      last_at: laterIso(mine.last_at, theirs.last_at),
      checked_at: laterIso(mine.checked_at, theirs.checked_at),
    };
  }
  return out;
}

export function mergeFeedback(local, origin) {
  const items = { ...(isObject(origin?.items) ? origin.items : {}) };
  for (const [id, item] of Object.entries(isObject(local?.items) ? local.items : {})) {
    const previous = items[id];
    if (!previous) {
      items[id] = item;
      continue;
    }
    const later = preferLater(item, previous);
    items[id] = later ?? item;
  }
  return {
    ...(isObject(origin) ? origin : {}),
    ...(isObject(local) ? local : {}),
    version: Math.max(Number(local?.version) || 0, Number(origin?.version) || 0, 1),
    offset: Math.max(Number(local?.offset) || 0, Number(origin?.offset) || 0),
    items,
    actions: mergeArray(local?.actions, origin?.actions, (entry) =>
      `${String(entry?.at ?? '')}|${String(entry?.action ?? '')}|${String(entry?.id ?? '')}`
    ),
    sources: mergeObject(local?.sources, origin?.sources),
    callbackRetries: mergeObject(local?.callbackRetries, origin?.callbackRetries),
  };
}

export function mergeState(local, origin) {
  const publishedKey = (entry) =>
    String(
      entry?.post_key ??
        `${String(entry?.slot ?? '')}|${String(entry?.dedupe_key ?? '')}|${String(entry?.title ?? '')}`
    );
  const reviewKey = (entry) =>
    String(
      entry?.id ??
        `${String(entry?.slot ?? '')}|${String(entry?.source ?? '')}|${String(entry?.url ?? '')}|${String(
          entry?.title ?? ''
        )}`
    );
  return {
    ...(isObject(origin) ? origin : {}),
    ...(isObject(local) ? local : {}),
    version: Math.max(Number(local?.version) || 0, Number(origin?.version) || 0, 1),
    updatedAt: [local?.updatedAt, origin?.updatedAt].filter(Boolean).sort().at(-1) ?? '',
    seen: mergeObject(local?.seen, origin?.seen),
    deferred: mergeObject(local?.deferred, origin?.deferred),
    slots: mergeObject(local?.slots, origin?.slots),
    published: mergeArray(local?.published, origin?.published, publishedKey),
    telegram: mergeTelegram(local?.telegram, origin?.telegram),
    offerReviews: mergeArray(local?.offerReviews, origin?.offerReviews, reviewKey),
    educationReviews: mergeArray(local?.educationReviews, origin?.educationReviews, reviewKey),
    reviewPending: mergeObject(local?.reviewPending, origin?.reviewPending),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const originIndex = args.indexOf('--origin');
  const origin = originIndex >= 0 && args[originIndex + 1] ? args[originIndex + 1] : 'origin/main';
  const files = args.filter(
    (arg, index) => index !== originIndex && index !== originIndex + 1 && !arg.startsWith('--')
  );
  for (const file of files) {
    const absolute = resolve(ROOT, file);
    const rel = relative(ROOT, absolute).replace(/\\/g, '/');
    let local;
    try {
      local = JSON.parse(await readFile(absolute, 'utf8'));
    } catch {
      continue;
    }
    let fromOrigin;
    try {
      fromOrigin = JSON.parse(
        execFileSync('git', ['show', `${origin}:${rel}`], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      );
    } catch {
      continue;
    }
    const name = basename(rel);
    const merged =
      name === 'review-feedback.json'
        ? mergeFeedback(local, fromOrigin)
        : name === 'state.json' || name === 'state.review.json'
          ? mergeState(local, fromOrigin)
          : mergeJson(local, fromOrigin);
    await writeFile(absolute, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(`MERGED ${rel}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
