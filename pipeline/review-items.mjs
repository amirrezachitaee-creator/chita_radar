import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dateKey } from './store.mjs';

export const REVIEW_STORE_VERSION = 1;
export const MAX_REVIEW_ACTIONS = 500;
export const REWRITE_ACTIONS = new Set(['reject', 'rewrite', 'publish']);
export const TERMINAL_STATUSES = new Set(['sent', 'rejected', 'expired']);

export const REJECT_REASONS = Object.freeze({
  irrelevant: 'نامرتبط با هوش مصنوعی',
  promo: 'تبلیغ یا لینک ارجاعی',
  duplicate: 'تکراری',
  quality: 'کیفیت پایین',
  other: 'دلیل دیگر',
});

const REJECT_LABELS = Object.freeze({
  irrelevant: 'نامرتبط',
  promo: 'تبلیغ/ارجاعی',
  duplicate: 'تکرار',
  quality: 'کیفیت پایین',
  other: 'دلیل دیگر',
});

const CALLBACK_PATTERN = /^rv1\|([mrxwps])\|([a-f0-9]{8,12})(?:\|([a-z]{1,12}))?$/;

export function emptyReviewStore() {
  return {
    version: REVIEW_STORE_VERSION,
    offset: 0,
    items: {},
    actions: [],
    sources: {},
  };
}

export function normalizeReviewStore(value) {
  const store = emptyReviewStore();
  if (!value || typeof value !== 'object') return store;
  store.offset = Math.max(0, Number(value.offset) || 0);
  if (Array.isArray(value.actions)) store.actions = value.actions.filter((entry) => entry && typeof entry === 'object');
  if (value.sources && typeof value.sources === 'object') store.sources = value.sources;
  if (value.items && typeof value.items === 'object') {
    for (const [id, item] of Object.entries(value.items)) {
      if (!/^[a-f0-9]{8,12}$/.test(id) || !item || typeof item !== 'object') continue;
      store.items[id] = {
        id,
        status: 'pending',
        rewrites: 0,
        createdAt: '',
        updatedAt: '',
        ...item,
      };
    }
  }
  return store;
}

export async function loadReviewStore(path) {
  try {
    return normalizeReviewStore(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyReviewStore();
    throw error;
  }
}

export async function saveReviewStore(path, store) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

export function newReviewItemId(items = {}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomBytes(5).toString('hex');
    if (!items[id]) return id;
  }
  throw new Error('REVIEW_ITEM_ID_COLLISION');
}

export function createReviewItem(store, fields = {}) {
  const now = String(fields.now ?? new Date().toISOString());
  const mainEligible = fields.mainEligible === true;
  const item = {
    id: newReviewItemId(store.items),
    messageId: fields.messageId === null || fields.messageId === undefined ? null : Number(fields.messageId),
    chatId: String(fields.chatId ?? ''),
    slot: String(fields.slot ?? ''),
    reason: String(fields.reason ?? ''),
    kind: String(fields.kind ?? 'post'),
    source: String(fields.source ?? ''),
    sourceName: String(fields.sourceName ?? ''),
    sourceType: String(fields.sourceType ?? ''),
    title: String(fields.title ?? ''),
    url: String(fields.url ?? ''),
    leadPostUrl: String(fields.leadPostUrl ?? ''),
    messageText: String(fields.messageText ?? '').slice(0, 4000),
    relatedLinks: Array.isArray(fields.relatedLinks) ? fields.relatedLinks.slice(0, 8) : [],
    images: Array.isArray(fields.images) ? fields.images.slice(0, 4) : [],
    imageUrl: String(fields.imageUrl ?? ''),
    publishedAt: String(fields.publishedAt ?? ''),
    keys: Array.isArray(fields.keys) ? fields.keys.slice(0, 8) : [],
    benchmark: fields.benchmark === true,
    toolHint: fields.toolHint === true,
    offerHint: fields.offerHint === true,
    rumorHint: fields.rumorHint === true,
    policy: fields.policy === true,
    mainEligible,
    qaPass: fields.qaPass === true || mainEligible,
    post: fields.post && typeof fields.post === 'object' ? fields.post : null,
    expiry: fields.expiry ?? null,
    status: 'pending',
    rewrites: 0,
    createdAt: now,
    updatedAt: now,
    lastActionAt: '',
    sentAt: '',
  };
  store.items[item.id] = item;
  return item;
}

export function reviewCallback(action, id, extra = '') {
  if (!/^[mrxwps]$/.test(String(action))) throw new Error('BAD_REVIEW_ACTION');
  if (!/^[a-f0-9]{8,12}$/.test(String(id))) throw new Error('BAD_REVIEW_ID');
  const suffix = extra ? `|${extra}` : '';
  const data = `rv1|${action}|${id}${suffix}`;
  if (data.length > 64) throw new Error('CALLBACK_TOO_LONG');
  return data;
}

export function parseReviewCallback(data) {
  const match = CALLBACK_PATTERN.exec(String(data ?? ''));
  if (!match) return null;
  const [, action, id, extra = ''] = match;
  if (action === 'x') {
    if (!Object.hasOwn(REJECT_REASONS, extra)) return null;
    return { action, id, extra };
  }
  if (extra) return null;
  return { action, id, extra: '' };
}

export function keyboardFor(item, { rewriteCap = 2 } = {}) {
  if (!item || !['pending', 'rewriting'].includes(item.status)) return null;
  const cap = Math.max(0, Number(rewriteCap) || 0);
  const rewrites = Math.max(0, Number(item.rewrites) || 0);
  const reject = { text: 'رد', callback_data: reviewCallback('r', item.id) };
  const rows = [];
  if (rewrites < cap) {
    rows.push([
      reject,
      {
        text: rewrites > 0 ? 'بازنویسی مجدد' : 'بازنویسی',
        callback_data: reviewCallback('w', item.id),
      },
    ]);
  } else {
    rows.push([reject]);
  }
  const canPublish = Boolean(item.post) && (item.mainEligible === true || rewrites > 0);
  if (canPublish) {
    rows.push([{ text: 'ارسال به کانال اصلی', callback_data: reviewCallback('p', item.id) }]);
  }
  return { inline_keyboard: rows };
}

export function rejectKeyboard(id) {
  const reason = (code) => ({ text: REJECT_LABELS[code], callback_data: reviewCallback('x', id, code) });
  return {
    inline_keyboard: [
      [reason('irrelevant'), reason('promo')],
      [reason('duplicate'), reason('quality')],
      [reason('other'), { text: 'بازگشت', callback_data: reviewCallback('m', id) }],
    ],
  };
}

export function removeKeyboard() {
  return { inline_keyboard: [] };
}

export function statusKeyboard(id, text) {
  return {
    inline_keyboard: [[{ text: String(text), callback_data: reviewCallback('s', id) }]],
  };
}

export function rewriteCountForDay(store, now) {
  const day = dateKey(now);
  return (store?.actions ?? []).filter(
    (entry) => entry.action === 'rewrite' && entry.at && dateKey(entry.at) === day
  ).length;
}

export function recordReviewAction(store, {
  item,
  action,
  actor = '',
  reason = '',
  detail = '',
  at = new Date().toISOString(),
} = {}) {
  if (!REWRITE_ACTIONS.has(action)) throw new Error('BAD_REVIEW_ACTION');
  const entry = {
    at,
    action,
    itemId: String(item?.id ?? ''),
    source: String(item?.source ?? ''),
    reason: String(reason ?? '').slice(0, 40),
    detail: String(detail ?? '').slice(0, 300),
    actor: String(actor ?? '').slice(0, 40),
  };
  store.actions.push(entry);
  if (store.actions.length > MAX_REVIEW_ACTIONS) {
    store.actions = store.actions.slice(-MAX_REVIEW_ACTIONS);
  }
  const sourceKey = entry.source || 'unknown';
  const stats = store.sources[sourceKey] ?? { rejects: 0, rewrites: 0, publishes: 0, lastAt: '' };
  if (action === 'reject') stats.rejects += 1;
  if (action === 'rewrite') stats.rewrites += 1;
  if (action === 'publish') stats.publishes += 1;
  stats.lastAt = at;
  store.sources[sourceKey] = stats;
  if (item) {
    item.lastAction = action;
    item.lastActionAt = at;
    item.updatedAt = at;
  }
  return entry;
}

export function pruneReviewStore(store, now, { days = 14, actionDays = 90, maxItems = 200 } = {}) {
  const nowMs = Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const itemCutoff = nowMs - Math.max(1, Number(days) || 14) * 86400000;
  let removed = 0;
  for (const [id, item] of Object.entries(store.items ?? {})) {
    const at = Date.parse(item?.updatedAt || item?.createdAt || '');
    if (!Number.isFinite(at) || at < itemCutoff) {
      delete store.items[id];
      removed += 1;
    }
  }
  const items = Object.entries(store.items ?? {});
  if (items.length > maxItems) {
    const keep = new Set(
      items
        .sort((left, right) => Date.parse(right[1].updatedAt || '') - Date.parse(left[1].updatedAt || ''))
        .slice(0, maxItems)
        .map(([id]) => id)
    );
    for (const [id] of items) {
      if (!keep.has(id)) {
        delete store.items[id];
        removed += 1;
      }
    }
  }
  const actionCutoff = nowMs - Math.max(1, Number(actionDays) || 90) * 86400000;
  store.actions = (store.actions ?? []).filter((entry) => {
    const at = Date.parse(entry?.at ?? '');
    return Number.isFinite(at) && at >= actionCutoff;
  });
  return removed;
}
