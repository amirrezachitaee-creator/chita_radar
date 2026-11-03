import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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
  markSeen,
  markSlot,
  isSlotSettled,
  quotaSnapshot,
  recordPublished,
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

test('after midnight nothing is published until the morning slot', () => {
  const result = resolveSlot('2026-11-02T20:40:00Z', { slots: SLOTS });
  assert.equal(result.ready, false);
  assert.equal(result.next.key, '2026-11-03T08:30+03:30');
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

test('slot status is settled only for ready or sent', () => {
  const state = emptyState();
  assert.equal(isSlotSettled(state, '2026-11-02T08:30+03:30'), false);
  markSlot(state, '2026-11-02T08:30+03:30', { status: 'empty' });
  assert.equal(isSlotSettled(state, '2026-11-02T08:30+03:30'), false);
  markSlot(state, '2026-11-02T08:30+03:30', { status: 'ready' });
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
  assert.equal(snapshot.tools.remaining, 15);
  assert.equal(snapshot.business.used, 1);
  assert.equal(snapshot.models.used, 0);
  assert.equal(snapshot.models.remaining, 13);
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
  assert.equal(raw.version, 1);
  assert.ok(raw.updatedAt);
});

test('missing state file starts empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-state-missing-'));
  const state = await loadState(join(dir, 'none.json'));
  assert.deepEqual(state, emptyState());
});
