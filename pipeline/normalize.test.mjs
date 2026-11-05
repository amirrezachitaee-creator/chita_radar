import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalUrl,
  contentHash,
  earliestDate,
  freshness,
  windowFor,
  evaluateItem,
} from './normalize.mjs';

const NOW = '2026-11-02T12:00:00Z';

test('pre-gate rejects anything older than 72 hours', () => {
  const r = freshness('2026-10-30T10:00:00Z', NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale');
});

test('pre-gate accepts 71 hours', () => {
  assert.equal(freshness('2026-10-30T13:00:00Z', NOW).ok, true);
});

test('tools window is 48 hours', () => {
  assert.equal(freshness('2026-10-31T13:00:00Z', NOW, { maxAgeHours: windowFor('tools') }).ok, true);
  assert.equal(freshness('2026-10-31T11:00:00Z', NOW, { maxAgeHours: windowFor('tools') }).reason, 'stale');
});

test('security window is 72 hours', () => {
  assert.equal(freshness('2026-10-30T13:00:00Z', NOW, { maxAgeHours: windowFor('security') }).ok, true);
  assert.equal(freshness('2026-10-30T11:00:00Z', NOW, { maxAgeHours: windowFor('security') }).reason, 'stale');
});

test('education window is 72 hours', () => {
  assert.equal(freshness('2026-10-30T13:00:00Z', NOW, { maxAgeHours: windowFor('education') }).ok, true);
  assert.equal(freshness('2026-10-30T11:00:00Z', NOW, { maxAgeHours: windowFor('education') }).reason, 'stale');
});

test('the earliest valid date wins so an updated page cannot look fresh', () => {
  assert.equal(
    earliestDate('2026-10-20T00:00:00Z', '2026-11-05T00:00:00Z'),
    '2026-10-20T00:00:00.000Z'
  );
  assert.equal(
    earliestDate('', 'bad-date', '2026-11-02T10:00:00Z'),
    '2026-11-02T10:00:00.000Z'
  );
  assert.equal(earliestDate('', null, undefined), '');
});

test('missing date is rejected', () => {
  assert.equal(freshness('', NOW).reason, 'no_date');
  assert.equal(freshness(undefined, NOW).reason, 'no_date');
});

test('far future date is rejected', () => {
  const r = freshness('2026-11-05T12:00:00Z', NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_date');
});

test('near future date is tolerated', () => {
  assert.equal(freshness('2026-11-02T18:00:00Z', NOW).ok, true);
});

test('tracking parameters are stripped', () => {
  assert.equal(
    canonicalUrl('https://Example.com/post/?utm_source=x&b=2&a=1#top'),
    'https://example.com/post?a=1&b=2'
  );
});

test('hash ignores whitespace differences', () => {
  assert.equal(contentHash('hello   world\n'), contentHash(' hello world '));
});

test('old bench case is rejected end to end', () => {
  const r = evaluateItem(
    { id: 'old-01', url: 'https://example.com/aster-2?utm_source=rss', published_at: '2025-06-10', content: 'x' },
    { now: NOW, category: 'models' }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale');
  assert.equal(r.canonical, 'https://example.com/aster-2');
});

test('60-hour-old tool news is now rejected', () => {
  const r = evaluateItem(
    { id: 'x', url: 'https://example.com/x', published_at: '2026-10-31T00:00:00Z', content: 'y' },
    { now: NOW, category: 'tools' }
  );
  assert.equal(r.ok, false);
});
