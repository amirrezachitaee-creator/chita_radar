import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalUrl, contentHash } from './normalize.mjs';

export const TEHRAN_OFFSET_MINUTES = 210;
export const MAIN_CATEGORIES = ['tools', 'models', 'security', 'business'];
export const MAX_DEFER_ATTEMPTS = 3;
export const DEFER_TTL_HOURS = 72;
export const MAX_DEFERRED = 50;
export const SEEN_RETENTION_DAYS = 30;
export const DELIVERED_DECISIONS = new Set(['publish', 'review', 'education_review']);

const pad = (value) => String(value).padStart(2, '0');
const isoDate = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

export function tehranParts(value) {
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error('invalid date');
  const shifted = new Date(ms + TEHRAN_OFFSET_MINUTES * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

export function dateKey(value) {
  const parts = tehranParts(value);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function slotStart(date, slot) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(slot));
  if (!match) throw new Error(`invalid slot ${slot}`);
  const [year, month, day] = String(date).split('-').map(Number);
  if (!year || !month || !day) throw new Error(`invalid date ${date}`);
  const utc = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2]));
  return new Date(utc - TEHRAN_OFFSET_MINUTES * 60000);
}

export function slotKey(date, slot) {
  return `${date}T${slot}+03:30`;
}

export function slotDateKey(key) {
  return String(key).slice(0, 10);
}

export function addDays(key, days) {
  const [year, month, day] = String(key).split('-').map(Number);
  if (!year || !month || !day) throw new Error(`invalid date ${key}`);
  return isoDate(new Date(Date.UTC(year, month - 1, day) + days * 86400000));
}

export function resolveSlot(now, { slots, earlyMinutes = 15, lateMinutes = 90 }) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const today = dateKey(nowMs);
  let matched = null;

  for (const slot of slots) {
    const start = slotStart(today, slot);
    const startMs = start.getTime();
    if (nowMs >= startMs - earlyMinutes * 60000 && nowMs <= startMs + lateMinutes * 60000) {
      if (!matched || startMs > matched.startMs) matched = { slot, start, startMs };
    }
  }

  if (matched) {
    return {
      ready: true,
      date: today,
      slot: matched.slot,
      key: slotKey(today, matched.slot),
      startsAt: matched.start.toISOString(),
    };
  }

  let next = null;
  for (const slot of slots) {
    const start = slotStart(today, slot);
    if (start.getTime() > nowMs) {
      next = { date: today, slot, start };
      break;
    }
  }
  if (!next) {
    const nextDate = addDays(today, 1);
    next = { date: nextDate, slot: slots[0], start: slotStart(nextDate, slots[0]) };
  }
  return {
    ready: false,
    next: {
      date: next.date,
      slot: next.slot,
      key: slotKey(next.date, next.slot),
      startsAt: next.start.toISOString(),
    },
  };
}

export function weekKey(value) {
  const key = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : dateKey(value);
  const [year, month, day] = key.split('-').map(Number);
  const noon = new Date(Date.UTC(year, month - 1, day, 12));
  const sinceSaturday = (noon.getUTCDay() + 1) % 7;
  return isoDate(new Date(noon.getTime() - sinceSaturday * 86400000));
}

export function emptyState() {
  return { version: 1, updatedAt: '', seen: {}, deferred: {}, slots: {}, published: [], telegram: {} };
}

export async function loadState(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...emptyState(),
      ...parsed,
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
      deferred: parsed.deferred && typeof parsed.deferred === 'object' ? parsed.deferred : {},
      slots: parsed.slots && typeof parsed.slots === 'object' ? parsed.slots : {},
      published: Array.isArray(parsed.published) ? parsed.published : [],
      telegram: parsed.telegram && typeof parsed.telegram === 'object' ? parsed.telegram : {},
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  state.updatedAt = new Date().toISOString();
  await writeFile(path, JSON.stringify(state, null, 2));
}

export function dedupeKeys({ url, title }) {
  const keys = [];
  try {
    keys.push(`url:${contentHash(canonicalUrl(url))}`);
  } catch {
    // The URL gate rejects invalid links before the model call.
  }
  if (title) {
    const normalized = String(title).toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalized) keys.push(`title:${contentHash(normalized)}`);
  }
  return keys;
}

export function findSeen(state, keys) {
  for (const key of keys) {
    if (state.seen[key]) return { key, record: state.seen[key] };
  }
  return null;
}

export function findSeenInStates(states, keys, now, { days = SEEN_RETENTION_DAYS } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const cutoff = nowMs - days * 86400000;
  for (const state of states ?? []) {
    for (const key of keys ?? []) {
      const record = state?.seen?.[key];
      if (!record) continue;
      const at = Date.parse(record?.at ?? '');
      if (Number.isFinite(at) && at < cutoff) continue;
      return { key, record };
    }
  }
  return null;
}

export function deliveredEntries(states, now, { days = SEEN_RETENTION_DAYS } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const cutoff = nowMs - days * 86400000;
  const entries = new Map();

  const add = (lane, record, title) => {
    if (!title) return;
    const at = Date.parse(record?.at ?? '');
    if (Number.isFinite(at) && at < cutoff) return;
    const key = `${lane}|${title}`;
    const next = {
      lane,
      at: Number.isFinite(at) ? at : 0,
      slot: String(record?.slot ?? ''),
      title: String(title),
      category: String(record?.category ?? ''),
      decision: String(record?.decision ?? 'publish'),
    };
    const previous = entries.get(key);
    if (!previous || next.at > previous.at) entries.set(key, next);
  };

  for (const { lane, state } of states ?? []) {
    for (const entry of state?.published ?? []) add(lane, entry, entry?.title);
    for (const record of Object.values(state?.seen ?? {})) {
      if (!DELIVERED_DECISIONS.has(record?.decision)) continue;
      add(lane, record, record?.title);
    }
  }

  return [...entries.values()].sort((left, right) => right.at - left.at);
}

export function markSeen(state, keys, record) {
  const value = { at: new Date().toISOString(), ...record };
  for (const key of keys) state.seen[key] = value;
  clearDeferred(state, { keys });
}

function safeDeferredPart(value) {
  try {
    return contentHash(canonicalUrl(value));
  } catch {
    return '';
  }
}

export function deferredId({ url, canonical, link, title }) {
  for (const value of [canonical, url, link]) {
    const part = safeDeferredPart(value);
    if (part) return `defer:url:${part}`;
  }
  const normalized = String(title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return normalized ? `defer:title:${contentHash(normalized)}` : '';
}

export function deferCandidate(state, candidate, record = {}) {
  if (!state.deferred || typeof state.deferred !== 'object') state.deferred = {};
  const id = deferredId(candidate);
  if (!id) return null;
  const previous = state.deferred[id];
  const at = new Date().toISOString();
  const reason = String(record.reason ?? '');
  const entry = {
    ...previous,
    id,
    at,
    firstAt: previous?.firstAt ?? at,
    attempts: Number(previous?.attempts ?? 0) + 1,
    reason,
    reasons: [...new Set([...(previous?.reasons ?? []), reason].filter(Boolean))].slice(-6),
    keys: [...new Set([...(candidate.keys ?? []), ...(previous?.keys ?? [])])],
    canonical: candidate.canonical ?? candidate.link ?? previous?.canonical ?? '',
    title: candidate.title ?? previous?.title ?? '',
    candidate: { ...(previous?.candidate ?? {}), ...candidate },
  };
  if (record.detail) entry.detail = String(record.detail).slice(0, 400);
  state.deferred[id] = entry;
  return entry;
}

export function clearDeferred(state, { keys = [], id = '' } = {}) {
  if (!state.deferred || typeof state.deferred !== 'object') return 0;
  if (id && state.deferred[id]) {
    delete state.deferred[id];
    return 1;
  }
  const wanted = new Set(keys);
  let removed = 0;
  for (const [entryId, entry] of Object.entries(state.deferred)) {
    if ((entry?.keys ?? []).some((key) => wanted.has(key))) {
      delete state.deferred[entryId];
      removed += 1;
    }
  }
  return removed;
}

export function listDeferred(state, now, { ttlHours = DEFER_TTL_HOURS, maxAttempts = MAX_DEFER_ATTEMPTS, limit = 0 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const entries = Object.values(state.deferred ?? {})
    .filter((entry) => entry && Number(entry.attempts ?? 0) < maxAttempts)
    .filter((entry) => {
      const published = Date.parse(entry?.candidate?.published ?? '');
      if (Number.isFinite(published)) return nowMs - published <= ttlHours * 3600000;
      const at = Date.parse(entry?.at ?? '');
      return Number.isFinite(at) && nowMs - at <= ttlHours * 3600000;
    })
    .sort((left, right) => {
      const leftAt = Date.parse(left?.candidate?.published ?? left?.at ?? '') || 0;
      const rightAt = Date.parse(right?.candidate?.published ?? right?.at ?? '') || 0;
      return rightAt - leftAt;
    });
  return limit > 0 ? entries.slice(0, limit) : entries;
}

export function markSlot(state, key, record) {
  state.slots[key] = { at: new Date().toISOString(), ...record };
}

export function isSlotSettled(state, key) {
  const status = state.slots[key]?.status;
  return status === 'ready' || status === 'sent' || status === 'skipped';
}

export function quotaSnapshot(config, state, week) {
  const snapshot = {};
  for (const category of MAIN_CATEGORIES) {
    const quota = Number(config.categories?.[category]?.weekly_quota ?? 0);
    const used = state.published.filter((entry) => entry.week === week && entry.category === category).length;
    snapshot[category] = { quota, used, remaining: Math.max(0, quota - used) };
  }
  return snapshot;
}

export function recordPublished(state, { slot, category, title, dedupeKey = '', postKey = '', kind = 'news', why = '' }) {
  const entry = {
    week: weekKey(slotDateKey(slot)),
    slot,
    category,
    kind,
    title,
    why,
    dedupe_key: dedupeKey,
    post_key: postKey,
    at: new Date().toISOString(),
  };
  state.published.push(entry);
  return entry;
}

export function pruneState(
  state,
  now,
  { seenDays = SEEN_RETENTION_DAYS, publishedDays = 90, slotDays = 90, deferredDays = 14, deferredCap = MAX_DEFERRED } = {}
) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const cutoff = (days) => nowMs - days * 86400000;

  for (const [key, record] of Object.entries(state.seen)) {
    const at = Date.parse(record?.at ?? '');
    if (!Number.isFinite(at) || at < cutoff(seenDays)) delete state.seen[key];
  }

  state.published = state.published.filter((entry) => {
    const at = Date.parse(entry?.at ?? entry?.slot?.slice(0, 10) ?? '');
    return Number.isFinite(at) && at >= cutoff(publishedDays);
  });

  for (const key of Object.keys(state.slots)) {
    const at = Date.parse(state.slots[key]?.at ?? '');
    if (!Number.isFinite(at) || at < cutoff(slotDays)) delete state.slots[key];
  }

  if (!state.deferred || typeof state.deferred !== 'object') state.deferred = {};
  for (const [id, entry] of Object.entries(state.deferred)) {
    const at = Date.parse(entry?.at ?? '');
    const published = Date.parse(entry?.candidate?.published ?? '');
    const staleByAge = !Number.isFinite(at) || at < cutoff(deferredDays);
    const staleByPublication = Number.isFinite(published) && published < nowMs - DEFER_TTL_HOURS * 3600000;
    if (staleByAge || staleByPublication) delete state.deferred[id];
  }
  const overflow = Object.entries(state.deferred)
    .sort(([, left], [, right]) => Date.parse(right?.at ?? '') - Date.parse(left?.at ?? ''))
    .slice(deferredCap);
  for (const [id] of overflow) delete state.deferred[id];

  return state;
}
