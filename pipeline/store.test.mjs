import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  resolveSlot,
  slotStart,
  slotKey,
  weekKey,
  addDays,
  emptyState,
  loadState,
  saveState,
  dedupeKeys,
  findSeen,
  findSeenInStates,
  deliveredEntries,
  SEEN_RETENTION_DAYS,
  markSeen,
  markSlot,
  deferCandidate,
  deferredId,
  clearDeferred,
  listDeferred,
  MAX_DEFER_ATTEMPTS,
  DEFER_TTL_HOURS,
  isSlotSettled,
  inQuietHours,
  quotaSnapshot,
  recordPublished,
  recordEducationReview,
  educationReviewUsage,
  pruneState,
} from './store.mjs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const SLOTS = config.schedule.slots;

test('Tehran slot maps to the correct UTC instant', () => {
  assert.equal(slotStart('2026-11-02', '08:30').toISOString(), '2026-11-02T05:00:00.000Z');
  assert.equal(slotStart('2026-11-02', '23:00').toISOString(), '2026-11-02T19:30:00.000Z');
  assert.equal(slotKey('2026-11-02', '08:30'), '2026-11-02T08:30+03:30');
  assert.equal(addDays('2026-11-02', 1), '2026-11-03');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('a run on time resolves to the current slot', () => {
  const result = resolveSlot('2026-11-02T05:00:00Z', { slots: SLOTS });
  assert.equal(result.ready, true);
  assert.equal(result.slot, '08:30');
  assert.equal(result.key, '2026-11-02T08:30+03:30');
});

test('an early trigger keeps the upcoming slot', () => {
  const result = resolveSlot('2026-11-02T04:50:00Z', { slots: SLOTS });
  assert.equal(result.ready, true);
  assert.equal(result.slot, '08:30');
});

test('a five-minute window accepts a trigger inside the window', () => {
  const result = resolveSlot('2026-11-02T04:56:00Z', { slots: SLOTS, earlyMinutes: 5 });
  assert.equal(result.ready, true);
  assert.equal(result.slot, '08:30');
});

test('a five-minute window does not take the next slot ten minutes early', () => {
  const result = resolveSlot('2026-11-02T07:50:00Z', { slots: SLOTS, earlyMinutes: 5 });
  assert.equal(result.ready, false);
  assert.equal(result.next.slot, '11:30');
});

test('a late trigger inside the grace window still uses the slot', () => {
  const result = resolveSlot('2026-11-02T06:30:00Z', { slots: SLOTS });
  assert.equal(result.ready, true);
  assert.equal(result.slot, '08:30');
});

test('a trigger between windows reports the next slot', () => {
  const result = resolveSlot('2026-11-02T07:00:00Z', { slots: SLOTS });
  assert.equal(result.ready, false);
  assert.equal(result.next.slot, '11:30');
  assert.equal(result.next.key, '2026-11-02T11:30+03:30');
});

test('the 23:00 grace window after midnight stays on the previous day', () => {
  const result = resolveSlot('2026-11-02T20:40:00Z', { slots: SLOTS });
  assert.equal(result.ready, true);
  assert.equal(result.slot, '23:00');
  assert.equal(result.key, '2026-11-02T23:00+03:30');
});

test('after the grace window nothing is published until the morning slot', () => {
  const result = resolveSlot('2026-11-02T21:10:00Z', { slots: SLOTS });
  assert.equal(result.ready, false);
  assert.equal(result.next.key, '2026-11-03T08:30+03:30');
});

test('quiet hours cover Tehran midnight to 08:30 only', () => {
  assert.equal(inQuietHours('2026-11-02T20:40:00Z', ['00:00', '08:30']), true);
  assert.equal(inQuietHours('2026-11-03T04:59:00Z', ['00:00', '08:30']), true);
  assert.equal(inQuietHours('2026-11-03T05:00:00Z', ['00:00', '08:30']), false);
  assert.equal(inQuietHours('2026-11-02T19:35:00Z', ['00:00', '08:30']), false);
  assert.equal(inQuietHours('2026-11-02T20:40:00Z', []), false);
  assert.equal(inQuietHours('2026-11-02T20:40:00Z', ['23:00', '08:30']), true);
});

test('a late evening trigger stays inside the same day', () => {
  const result = resolveSlot('2026-11-02T19:35:00Z', { slots: SLOTS });
  assert.equal(result.ready, true);
  assert.equal(result.slot, '23:00');
});

test('the weekly key starts on Saturday in Tehran', () => {
  assert.equal(weekKey('2026-11-02'), '2026-10-31');
  assert.equal(weekKey('2026-10-31'), '2026-10-31');
  assert.equal(weekKey('2026-11-06'), '2026-10-31');
  assert.equal(weekKey('2026-11-07'), '2026-11-07');
});

test('dedupe keys survive tracking parameters and title whitespace', () => {
  const first = dedupeKeys({ url: 'https://example.com/a?utm_source=x', title: 'Hello  World' });
  const second = dedupeKeys({ url: 'https://example.com/a', title: 'hello world' });
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  const state = emptyState();
  markSeen(state, first, { decision: 'publish', category: 'tools' });
  assert.ok(findSeen(state, second));
});

test('seen lookup reaches both lanes and ignores records older than 30 days', () => {
  const active = emptyState();
  const review = emptyState();
  const recent = dedupeKeys({ url: 'https://example.com/recent', title: 'Recent story' });
  const old = dedupeKeys({ url: 'https://example.com/old', title: 'Old story' });
  markSeen(review, recent, { at: '2026-11-01T00:00:00.000Z', decision: 'review' });
  markSeen(review, old, { at: '2026-09-01T00:00:00.000Z', decision: 'publish' });

  assert.equal(SEEN_RETENTION_DAYS, 30);
  assert.equal(findSeenInStates([active], recent, '2026-11-02T15:00:00.000Z'), null);
  assert.ok(findSeenInStates([active, review], recent, '2026-11-02T15:00:00.000Z'));
  assert.equal(findSeenInStates([active, review], old, '2026-11-02T15:00:00.000Z'), null);
});

test('legacy seen records without a date still block an exact repeat', () => {
  const state = emptyState();
  const keys = dedupeKeys({ url: 'https://example.com/legacy', title: 'Legacy story' });
  markSeen(state, keys, { at: '', decision: 'skip' });
  assert.ok(findSeenInStates([state], keys, '2026-11-02T15:00:00.000Z'));
});

test('delivered memory keeps published and review entries only for 30 days', () => {
  const now = '2026-11-02T15:00:00.000Z';
  const main = emptyState();
  const review = emptyState();
  main.published = [
    { title: 'Main story', at: '2026-10-29T15:00:00.000Z', slot: '2026-10-29T20:30+03:30', category: 'tools' },
    { title: 'Old main story', at: '2026-09-01T15:00:00.000Z', slot: '2026-09-01T20:30+03:30', category: 'tools' },
  ];
  markSeen(main, dedupeKeys({ url: 'https://example.com/reviewed', title: 'Reviewed story' }), {
    at: '2026-11-01T00:00:00.000Z',
    decision: 'review',
    title: 'Reviewed story',
    slot: '2026-11-01T08:30+03:30',
  });
  markSeen(main, dedupeKeys({ url: 'https://example.com/edu', title: 'Education story' }), {
    at: '2026-10-20T00:00:00.000Z',
    decision: 'education_review',
    title: 'Education story',
    slot: '2026-10-20T08:30+03:30',
  });
  markSeen(main, dedupeKeys({ url: 'https://example.com/failed', title: 'Rejected story' }), {
    at: '2026-11-01T00:00:00.000Z',
    decision: 'qa_failed',
    title: 'Rejected story',
  });
  markSeen(main, dedupeKeys({ url: 'https://example.com/dupe', title: 'Education duplicate' }), {
    at: '2026-11-01T00:00:00.000Z',
    decision: 'education_duplicate',
    title: 'Education duplicate',
  });
  review.published = [
    { title: 'Review story', at: '2026-11-02T10:00:00.000Z', slot: '2026-11-02T14:00+03:30', category: 'models' },
  ];
  markSeen(review, dedupeKeys({ url: 'https://example.com/review-published', title: 'Review story' }), {
    at: '2026-11-02T10:00:00.000Z',
    decision: 'publish',
    title: 'Review story',
    slot: '2026-11-02T14:00+03:30',
  });
  markSeen(review, dedupeKeys({ url: 'https://example.com/old-review', title: 'Old review story' }), {
    at: '2026-09-15T00:00:00.000Z',
    decision: 'review',
    title: 'Old review story',
  });

  const entries = deliveredEntries(
    [{ lane: 'main', state: main }, { lane: 'review', state: review }],
    now,
    { days: SEEN_RETENTION_DAYS }
  );
  assert.deepEqual(
    entries.map((entry) => `${entry.lane}|${entry.title}`),
    ['review|Review story', 'main|Reviewed story', 'main|Main story', 'main|Education story']
  );
  assert.equal(entries[0].decision, 'publish');
  assert.equal(entries[1].decision, 'review');
  assert.equal(entries[3].decision, 'education_review');
});

test('slot status is settled for ready, sent, skipped, or reviewed', () => {
  const state = emptyState();
  assert.equal(isSlotSettled(state, '2026-11-02T08:30+03:30'), false);
  markSlot(state, '2026-11-02T08:30+03:30', { status: 'empty' });
  assert.equal(isSlotSettled(state, '2026-11-02T08:30+03:30'), false);
  markSlot(state, '2026-11-02T08:30+03:30', { status: 'ready' });
  assert.equal(isSlotSettled(state, '2026-11-02T08:30+03:30'), true);
  markSlot(state, '2026-11-02T08:30+03:30', { status: 'sent' });
  assert.equal(isSlotSettled(state, '2026-11-02T08:30+03:30'), true);
  markSlot(state, '2026-11-02T08:30+03:30', { status: 'skipped' });
  assert.equal(isSlotSettled(state, '2026-11-02T08:30+03:30'), true);
  markSlot(state, '2026-11-02T08:30+03:30', { status: 'review' });
  assert.equal(isSlotSettled(state, '2026-11-02T08:30+03:30'), true);
});

test('weekly quotas count only the current week and category', () => {
  const state = emptyState();
  state.published = [
    { week: '2026-10-31', category: 'tools' },
    { week: '2026-10-31', category: 'tools' },
    { week: '2026-10-31', category: 'business' },
    { week: '2026-10-24', category: 'tools' },
  ];
  const snapshot = quotaSnapshot(config, state, '2026-10-31');
  assert.equal(snapshot.tools.used, 2);
  assert.equal(snapshot.tools.remaining, 29);
  assert.equal(snapshot.business.used, 1);
  assert.equal(snapshot.models.used, 0);
  assert.equal(snapshot.models.remaining, 24);
});

test('recording a publish sets the week from the slot key', () => {
  const state = emptyState();
  const entry = recordPublished(state, {
    slot: '2026-11-02T08:30+03:30',
    category: 'tools',
    title: 'تست',
  });
  assert.equal(entry.week, '2026-10-31');
  assert.equal(state.published.length, 1);
  assert.equal(quotaSnapshot(config, state, '2026-10-31').tools.used, 1);
});

test('recording a publish stores the source for diversity caps', () => {
  const state = emptyState();
  const entry = recordPublished(state, {
    slot: '2026-11-07T08:30+03:30',
    category: 'models',
    title: 'مدل تازه',
    sourceId: 'source-one',
    sourceName: 'Source One',
    sourceType: 'news',
    url: 'https://example.com/model',
  });
  assert.equal(entry.sourceId, 'source-one');
  assert.equal(entry.sourceName, 'Source One');
  assert.equal(entry.sourceType, 'news');
  assert.equal(entry.url, 'https://example.com/model');
  assert.equal(entry.week, '2026-11-07');
  assert.equal(state.published[0].sourceId, 'source-one');
});

test('education reviews are counted per Tehran day and source', () => {
  const state = emptyState();
  recordEducationReview(state, {
    source: 'channel-a',
    title: 'دوره یک',
    url: 'https://example.com/one',
    at: '2026-11-06T20:00:00.000Z',
  });
  recordEducationReview(state, {
    source: 'channel-a',
    title: 'دوره دو',
    url: 'https://example.com/two',
    at: '2026-11-07T05:30:00.000Z',
  });
  recordEducationReview(state, {
    source: 'channel-b',
    title: 'دوره سه',
    url: 'https://example.com/three',
    at: '2026-11-07T08:00:00.000Z',
  });
  const usage = educationReviewUsage(state, '2026-11-07T12:00:00Z');
  assert.equal(usage.total, 2);
  assert.equal(usage.source, 0);
  assert.deepEqual(usage.bySource, { 'channel-a': 1, 'channel-b': 1 });
  assert.equal(educationReviewUsage(state, '2026-11-07T12:00:00Z', { source: 'channel-a' }).source, 1);
});

test('old education reviews are pruned after fourteen days', () => {
  const state = emptyState();
  recordEducationReview(state, {
    source: 'old',
    title: 'قدیمی',
    at: '2026-10-01T00:00:00.000Z',
  });
  recordEducationReview(state, {
    source: 'new',
    title: 'تازه',
    at: '2026-11-01T00:00:00.000Z',
  });
  pruneState(state, '2026-11-05T00:00:00Z');
  assert.deepEqual(state.educationReviews.map((entry) => entry.source), ['new']);
});

test('state round-trips through disk and prunes old records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-state-'));
  const path = join(dir, 'state.json');
  const state = emptyState();
  markSeen(state, dedupeKeys({ url: 'https://example.com/new', title: 'new' }), {
    at: '2026-11-01T00:00:00.000Z',
    decision: 'skip',
    category: 'models',
  });
  state.seen['url:old'] = { at: '2026-01-01T00:00:00.000Z', decision: 'publish' };
  state.slots['2026-11-02T08:30+03:30'] = { status: 'ready', at: '2026-11-02T05:00:00.000Z' };
  state.slots['2026-01-01T08:30+03:30'] = { status: 'sent', at: '2026-01-01T05:00:00.000Z' };
  state.published = [
    { week: '2026-10-31', category: 'tools', slot: '2026-11-02T08:30+03:30', at: '2026-11-02T05:00:00.000Z' },
    { week: '2025-12-27', category: 'tools', slot: '2025-12-27T08:30+03:30', at: '2025-12-27T05:00:00.000Z' },
  ];
  await saveState(path, state);
  const loaded = await loadState(path);
  assert.equal(loaded.seen['url:old'].decision, 'publish');
  assert.equal(loaded.slots['2026-11-02T08:30+03:30'].status, 'ready');

  pruneState(loaded, '2026-11-02T06:00:00Z');
  assert.equal(loaded.seen['url:old'], undefined);
  assert.ok(Object.keys(loaded.seen).length >= 1);
  assert.equal(loaded.slots['2026-01-01T08:30+03:30'], undefined);
  assert.equal(loaded.published.length, 1);

  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.version, 2);
  assert.ok(raw.updatedAt);
});

test('missing state file starts empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-state-missing-'));
  const state = await loadState(join(dir, 'none.json'));
  assert.deepEqual(state, emptyState());
});

test('an old state file is loaded into the current schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-state-migrate-'));
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({ version: 1, seen: {}, published: [] }));
  const state = await loadState(path);
  assert.equal(state.version, 2);
  assert.deepEqual(state.educationReviews, []);
  assert.deepEqual(state.reviewPending, {});
});

const deferredCandidate = {
  title: 'خبر تازه',
  link: 'https://example.com/a',
  canonical: 'https://example.com/a',
  keys: dedupeKeys({ url: 'https://example.com/a', title: 'خبر تازه' }),
  published: '2026-11-02T00:00:00.000Z',
};

test('a deferred candidate is retried and cleared after publishing', () => {
  const state = emptyState();
  const first = deferCandidate(state, deferredCandidate, { reason: 'invalid_json' });
  assert.equal(first.attempts, 1);
  assert.equal(listDeferred(state, '2026-11-02T02:00:00Z').length, 1);

  const second = deferCandidate(state, deferredCandidate, { reason: 'fetch_failed' });
  assert.equal(second.attempts, 2);
  assert.deepEqual(second.reasons, ['invalid_json', 'fetch_failed']);

  markSeen(state, deferredCandidate.keys, { decision: 'publish' });
  assert.equal(listDeferred(state, '2026-11-02T02:00:00Z').length, 0);
  assert.equal(state.deferred[deferredId(deferredCandidate)], undefined);
});

test('deferred retries stop at the attempt cap and after the freshness ttl', () => {
  const state = emptyState();
  for (let index = 0; index < MAX_DEFER_ATTEMPTS; index += 1) {
    deferCandidate(state, deferredCandidate, { reason: 'quota_full' });
  }
  assert.equal(listDeferred(state, '2026-11-02T02:00:00Z').length, 0);
  assert.equal(listDeferred(state, '2026-11-02T02:00:00Z', { maxAttempts: MAX_DEFER_ATTEMPTS + 1 }).length, 1);

  const old = { ...deferredCandidate, title: 'خبر قدیمی', link: 'https://example.com/old', canonical: 'https://example.com/old', published: '2026-10-25T00:00:00.000Z' };
  deferCandidate(state, old, { reason: 'invalid_json' });
  assert.equal(
    listDeferred(state, '2026-11-02T02:00:00Z', { ttlHours: DEFER_TTL_HOURS }).some((entry) => entry.title === 'خبر قدیمی'),
    false
  );
});

test('pruning drops expired deferred records and caps the queue', () => {
  const state = emptyState();
  for (let index = 0; index < 55; index += 1) {
    deferCandidate(
      state,
      {
        ...deferredCandidate,
        title: `خبر ${index}`,
        link: `https://example.com/${index}`,
        canonical: `https://example.com/${index}`,
      },
      { reason: 'invalid_json' }
    );
  }
  for (const entry of Object.values(state.deferred)) entry.at = '2026-11-02T00:00:00.000Z';
  pruneState(state, '2026-11-02T01:00:00Z');
  assert.equal(Object.keys(state.deferred).length, 50);

  const stale = Object.values(state.deferred)[0];
  stale.at = '2026-01-01T00:00:00.000Z';
  pruneState(state, '2026-11-02T01:00:00Z');
  assert.equal(state.deferred[stale.id], undefined);
});

test('deferred records survive a state round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-state-deferred-'));
  const path = join(dir, 'state.json');
  const state = emptyState();
  deferCandidate(state, deferredCandidate, { reason: 'invalid_json', detail: 'writer=primary' });
  await saveState(path, state);
  const loaded = await loadState(path);
  assert.equal(Object.keys(loaded.deferred).length, 1);
  assert.equal(Object.values(loaded.deferred)[0].reason, 'invalid_json');
  assert.equal(Object.values(loaded.deferred)[0].candidate.canonical, 'https://example.com/a');
});

test('review history and the pending review queue survive a round-trip and prune', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-state-review-'));
  const path = join(dir, 'state.json');
  const state = emptyState();
  state.offerReviews.push({
    id: '2026-11-02|tg-a|https://example.com/a',
    date: '2026-11-02',
    at: '2026-11-02T05:00:00.000Z',
    source: 'tg-a',
    title: 'آفر',
    url: 'https://example.com/a',
    reason: 'expiry_missing',
    kind: 'offer',
    mainEligible: false,
  });
  state.reviewPending['2026-11-02|tg-a|https://example.com/a'] = {
    id: '2026-11-02|tg-a|https://example.com/a',
    queuedAt: '2026-11-02T05:00:00.000Z',
    source: 'tg-a',
    title: 'آفر',
    url: 'https://example.com/a',
    reason: 'expiry_missing',
    kind: 'offer',
    text: 'متن بازبینی',
  };
  await saveState(path, state);
  const loaded = await loadState(path);
  assert.equal(loaded.offerReviews.length, 1);
  assert.equal(Object.keys(loaded.reviewPending).length, 1);

  pruneState(loaded, '2026-11-02T06:00:00Z');
  assert.equal(loaded.offerReviews.length, 1);
  assert.equal(Object.keys(loaded.reviewPending).length, 1);

  pruneState(loaded, '2026-11-20T06:00:00Z');
  assert.equal(loaded.offerReviews.length, 0);
  assert.equal(Object.keys(loaded.reviewPending).length, 0);
});
