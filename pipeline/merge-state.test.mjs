import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeFeedback, mergeJson, mergeState } from './merge-state.mjs';

test('feedback keeps the highest offset and unions actions', () => {
  const local = {
    version: 1,
    offset: 20,
    items: {},
    actions: [{ id: 'a', action: 'reject', at: '2026-11-16T12:00:00Z' }],
    sources: {},
  };
  const origin = {
    version: 1,
    offset: 30,
    items: {},
    actions: [
      { id: 'a', action: 'reject', at: '2026-11-16T12:00:00Z' },
      { id: 'b', action: 'publish', at: '2026-11-16T11:00:00Z' },
    ],
    sources: {},
  };
  const merged = mergeFeedback(local, origin);
  assert.equal(merged.offset, 30);
  assert.equal(merged.actions.length, 2);
});

test('feedback keeps the newer item and the item only present on origin', () => {
  const local = {
    version: 1,
    offset: 1,
    items: { one: { id: 'one', status: 'rejected', updatedAt: '2026-11-16T12:00:00Z' } },
    actions: [],
  };
  const origin = {
    version: 1,
    offset: 1,
    items: {
      one: { id: 'one', status: 'pending', updatedAt: '2026-11-16T11:00:00Z' },
      two: { id: 'two', status: 'pending', updatedAt: '2026-11-16T12:30:00Z' },
    },
    actions: [],
  };
  const merged = mergeFeedback(local, origin);
  assert.equal(merged.items.one.status, 'rejected');
  assert.equal(merged.items.two.status, 'pending');
});

test('state merges published entries by post key without duplicates', () => {
  const local = {
    version: 2,
    updatedAt: '2026-11-16T12:00:00Z',
    published: [{ post_key: 'a', title: 'one', at: '2026-11-16T12:00:00Z' }],
  };
  const origin = {
    version: 2,
    updatedAt: '2026-11-16T11:00:00Z',
    published: [
      { post_key: 'a', title: 'one', at: '2026-11-16T12:00:00Z' },
      { post_key: 'b', title: 'two', at: '2026-11-16T10:00:00Z' },
    ],
  };
  const merged = mergeState(local, origin);
  assert.equal(merged.published.length, 2);
  assert.deepEqual(
    merged.published.map((entry) => entry.post_key).sort(),
    ['a', 'b']
  );
});

test('state keeps the newer seen record and the larger telegram counter', () => {
  const local = {
    version: 2,
    seen: { key: { at: '2026-11-16T12:00:00Z', decision: 'publish' } },
    telegram: { channel: { last_id: 10, checked_at: '2026-11-16T12:00:00Z' } },
  };
  const origin = {
    version: 2,
    seen: { key: { at: '2026-11-16T11:00:00Z', decision: 'review' } },
    telegram: { channel: { last_id: 12, checked_at: '2026-11-16T11:30:00Z' } },
  };
  const merged = mergeState(local, origin);
  assert.equal(merged.seen.key.decision, 'publish');
  assert.equal(merged.telegram.channel.last_id, 12);
  assert.equal(merged.telegram.channel.checked_at, '2026-11-16T12:00:00Z');
});

test('generic json merge keeps both sides of a plain object', () => {
  const merged = mergeJson({ a: 1, nested: { x: true } }, { b: 2, nested: { y: true } });
  assert.deepEqual(merged, { a: 1, b: 2, nested: { x: true, y: true } });
});
