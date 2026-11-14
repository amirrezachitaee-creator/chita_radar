import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createReviewItem,
  emptyReviewStore,
  keyboardFor,
  loadReviewStore,
  normalizeReviewStore,
  parseReviewCallback,
  pruneReviewStore,
  recordReviewAction,
  rejectKeyboard,
  removeKeyboard,
  reviewCallback,
  rewriteCountForDay,
  saveReviewStore,
} from './review-items.mjs';

const NOW = '2026-11-14T15:00:00Z';

function item(store, fields = {}) {
  return createReviewItem(store, {
    now: NOW,
    messageId: 10,
    chatId: '-1001',
    slot: '2026-11-14T17:00',
    reason: 'referral_link',
    kind: 'post',
    source: 'tg-a',
    sourceName: 'کانال الف',
    title: 'خبر تازه',
    url: 'https://example.com/a',
    messageText: 'متن منبع '.repeat(40),
    keys: ['url:abc'],
    ...fields,
  });
}

test('a review item gets a short callback id and stays outside the terminal states', () => {
  const store = emptyReviewStore();
  const first = item(store, { mainEligible: true });
  const second = item(store, {});
  assert.match(first.id, /^[a-f0-9]{10}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(store.items[first.id].status, 'pending');
  assert.equal(store.items[first.id].rewrites, 0);
  assert.deepEqual(store.items[first.id].keys, ['url:abc']);
  assert.equal(store.items[first.id].qaPass, true);
  assert.equal(store.items[second.id].qaPass, false);
});

test('callback data round-trips and rejects anything outside the tiny menu', () => {
  const id = 'a1b2c3d4e5';
  assert.equal(parseReviewCallback(reviewCallback('m', id)).action, 'm');
  assert.deepEqual(parseReviewCallback(reviewCallback('x', id, 'quality')), {
    action: 'x',
    id,
    extra: 'quality',
  });
  assert.equal(parseReviewCallback(reviewCallback('w', id, 'quality')), null);
  assert.equal(parseReviewCallback(`rv1|x|${id}|bogus`), null);
  assert.equal(parseReviewCallback(`rv1|p|${id}|injected`), null);
  assert.equal(parseReviewCallback('rv1|p|../../etc'), null);
  assert.throws(() => reviewCallback('z', id), /BAD_REVIEW_ACTION/);
  assert.throws(() => reviewCallback('p', 'bad'), /BAD_REVIEW_ID/);
});

test('the first keyboard offers reject, rewrite, and publish only for a ready post', () => {
  const store = emptyReviewStore();
  const ready = item(store, {
    mainEligible: true,
    post: { title: 'نسخه اول', body: 'متن', source_url: 'https://example.com/a' },
  });
  const notReady = item(store, {});
  const readyRows = keyboardFor(ready).inline_keyboard;
  const notReadyRows = keyboardFor(notReady).inline_keyboard;
  assert.equal(readyRows.length, 2);
  assert.deepEqual(readyRows[0].map((button) => button.text), ['رد', 'بازنویسی']);
  assert.equal(readyRows[1][0].text, 'ارسال به کانال اصلی');
  assert.equal(notReadyRows.length, 1);
  assert.deepEqual(notReadyRows[0].map((button) => button.text), ['رد', 'بازنویسی']);
  assert.equal(parseReviewCallback(readyRows[1][0].callback_data).action, 'p');
});

test('after the first rewrite the same item offers rewrite again and publish', () => {
  const store = emptyReviewStore();
  const entry = item(store, { mainEligible: false });
  entry.rewrites = 1;
  entry.post = { title: 'نسخه دوم', body: 'متن', source_url: 'https://example.com/a' };
  const rows = keyboardFor(entry).inline_keyboard;
  assert.deepEqual(rows[0].map((button) => button.text), ['رد', 'بازنویسی مجدد']);
  assert.equal(rows[1][0].text, 'ارسال به کانال اصلی');
  assert.equal(parseReviewCallback(rows[0][1].callback_data).action, 'w');
});

test('after the second rewrite only reject and publish remain', () => {
  const store = emptyReviewStore();
  const entry = item(store, { mainEligible: false });
  entry.rewrites = 2;
  entry.post = { title: 'نسخه سوم', body: 'متن', source_url: 'https://example.com/a' };
  const rows = keyboardFor(entry).inline_keyboard;
  assert.deepEqual(rows[0].map((button) => button.text), ['رد']);
  assert.deepEqual(rows[1].map((button) => button.text), ['ارسال به کانال اصلی']);
  assert.equal(keyboardFor(entry, { rewriteCap: 3 }).inline_keyboard[0][1].text, 'بازنویسی مجدد');
});

test('a sent or rejected item has no buttons and a rewrite in flight keeps them', () => {
  const store = emptyReviewStore();
  const rejected = item(store, {});
  rejected.status = 'rejected';
  assert.equal(keyboardFor(rejected), null);
  const sent = item(store, {});
  sent.status = 'sent';
  assert.equal(keyboardFor(sent), null);
  const rewriting = item(store, {});
  rewriting.status = 'rewriting';
  assert.ok(keyboardFor(rewriting).inline_keyboard.length >= 1);
});

test('the reject menu carries every reason plus a way back', () => {
  const rows = rejectKeyboard('a1b2c3d4e5').inline_keyboard;
  const labels = rows.flat().map((button) => button.text);
  assert.deepEqual(labels, ['نامرتبط', 'تبلیغ/ارجاعی', 'تکرار', 'کیفیت پایین', 'دلیل دیگر', 'بازگشت']);
  const reasons = rows.flat().filter((button) => button.text !== 'بازگشت').map((button) => parseReviewCallback(button.callback_data).extra);
  assert.deepEqual(reasons, ['irrelevant', 'promo', 'duplicate', 'quality', 'other']);
  assert.deepEqual(removeKeyboard(), { inline_keyboard: [] });
});

test('feedback records the action, the source tally, and the Tehran-day rewrite count', () => {
  const store = emptyReviewStore();
  const entry = item(store, {});
  recordReviewAction(store, { item: entry, action: 'rewrite', reason: 'style', at: '2026-11-14T06:00:00Z' });
  recordReviewAction(store, { item: entry, action: 'reject', reason: 'duplicate', at: '2026-11-14T06:10:00Z' });
  recordReviewAction(store, { item: entry, action: 'publish', at: '2026-11-14T06:20:00Z' });
  recordReviewAction(store, { item: entry, action: 'rewrite', at: '2026-11-15T06:00:00Z' });
  assert.equal(store.actions.length, 4);
  assert.deepEqual(store.sources['tg-a'], {
    rejects: 1,
    rewrites: 2,
    publishes: 1,
    lastAt: '2026-11-15T06:00:00Z',
  });
  assert.equal(rewriteCountForDay(store, '2026-11-14T18:00:00Z'), 1);
  assert.equal(rewriteCountForDay(store, '2026-11-15T18:00:00Z'), 1);
  assert.equal(entry.lastAction, 'rewrite');
});

test('the action log is capped without losing the latest decisions', () => {
  const store = emptyReviewStore();
  const entry = item(store, {});
  for (let index = 0; index < 510; index += 1) {
    recordReviewAction(store, { item: entry, action: 'reject', at: `2026-11-14T06:00:${String(index % 60).padStart(2, '0')}Z` });
  }
  assert.equal(store.actions.length, 500);
  assert.equal(store.actions.at(-1).action, 'reject');
});

test('the store survives an atomic save and reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-items-'));
  const path = join(dir, 'feedback.json');
  const store = emptyReviewStore();
  const entry = item(store, { mainEligible: true });
  store.offset = 991;
  await saveReviewStore(path, store);
  const loaded = await loadReviewStore(path);
  assert.equal(loaded.offset, 991);
  assert.equal(loaded.items[entry.id].title, 'خبر تازه');
  assert.equal(loaded.items[entry.id].mainEligible, true);
  assert.ok((await readFile(path, 'utf8')).endsWith('\n'));
  const missing = await loadReviewStore(join(dir, 'missing.json'));
  assert.deepEqual(missing.items, {});
});

test('a malformed store is normalized instead of breaking the poller', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-items-bad-'));
  const path = join(dir, 'feedback.json');
  await writeFile(path, JSON.stringify({
    offset: -4,
    items: { '../bad': { title: 'x' }, abcdef12: { status: 'pending', title: 'ok' } },
    actions: [null, { action: 'reject' }],
  }));
  const loaded = await loadReviewStore(path);
  assert.equal(loaded.offset, 0);
  assert.deepEqual(Object.keys(loaded.items), ['abcdef12']);
  assert.equal(loaded.actions.length, 1);
  assert.equal(normalizeReviewStore(null).offset, 0);
});

test('pruning drops old items, trims the excess, and keeps recent feedback', () => {
  const store = emptyReviewStore();
  const old = item(store, { now: '2026-10-01T00:00:00Z' });
  old.updatedAt = '2026-10-01T00:00:00Z';
  const fresh = item(store, { now: NOW });
  store.actions.push({ at: '2026-01-01T00:00:00Z', action: 'reject' });
  store.actions.push({ at: NOW, action: 'publish' });
  const removed = pruneReviewStore(store, '2026-11-14T18:00:00Z', { days: 14, maxItems: 10 });
  assert.equal(removed, 1);
  assert.equal(store.items[old.id], undefined);
  assert.ok(store.items[fresh.id]);
  assert.deepEqual(store.actions.map((entry) => entry.action), ['publish']);
});
