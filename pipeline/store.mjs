import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalUrl, contentHash } from './normalize.mjs';

export const TEHRAN_OFFSET_MINUTES = 210;
export const MAIN_CATEGORIES = ['tools', 'models', 'security', 'business'];

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
  return { version: 1, updatedAt: '', seen: {}, slots: {}, published: [], telegram: {} };
}

export async function loadState(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...emptyState(),
      ...parsed,
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
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

export function markSeen(state, keys, record) {
  const value = { at: new Date().toISOString(), ...record };
  for (const key of keys) state.seen[key] = value;
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

export function pruneState(state, now, { seenDays = 30, publishedDays = 90, slotDays = 90 } = {}) {
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

  return state;
}
