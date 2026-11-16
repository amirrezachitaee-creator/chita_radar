import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySourceHealth,
  computeSourceHealth,
  emptyHealth,
  healthCounts,
  renderStatusMessage,
  sourceMetrics,
} from './source-health.mjs';

const NOW = '2026-11-16T12:00:00.000Z';
const DAY = 86400000;
const at = (daysAgo) => new Date(Date.parse(NOW) - daysAgo * DAY).toISOString();
const reject = (source, daysAgo, reason = 'irrelevant') => ({
  at: at(daysAgo),
  action: 'reject',
  source,
  reason,
});
const rewrite = (source, daysAgo) => ({ at: at(daysAgo), action: 'rewrite', source });
const publish = (source, daysAgo) => ({ at: at(daysAgo), action: 'publish', source });
const published = (sourceId, daysAgo) => ({ at: at(daysAgo), sourceId, title: 'x' });

const registry = [
  { id: 'tg-test', name: 'Test channel', type: 'telegram_channel' },
  { id: 'openai-news', name: 'OpenAI', type: 'official_blog' },
];

test('a source without signals stays active and quiet', () => {
  const health = computeSourceHealth({
    registrySources: registry,
    now: NOW,
    previous: emptyHealth(),
  });
  assert.equal(health.sources['tg-test'].status, 'active');
  assert.equal(health.sources['tg-test'].reason, 'no_signal');
  assert.equal(health.history.length, 0);
});

test('sustained rejects quarantine a channel but never an official source', () => {
  const feedback = {
    actions: [
      reject('tg-test', 1, 'promo'),
      reject('tg-test', 2, 'irrelevant'),
      reject('tg-test', 3, 'duplicate'),
      reject('tg-test', 4, 'quality'),
      rewrite('tg-test', 5),
      reject('openai-news', 1, 'quality'),
      reject('openai-news', 2, 'quality'),
      reject('openai-news', 3, 'quality'),
      reject('openai-news', 4, 'quality'),
      rewrite('openai-news', 5),
    ],
  };
  const health = computeSourceHealth({
    registrySources: registry,
    feedback,
    now: NOW,
  });
  const channel = health.sources['tg-test'];
  assert.equal(channel.status, 'quarantined');
  assert.equal(channel.reason, 'sustained_rejects');
  assert.ok(Date.parse(channel.cooldownUntil) > Date.parse(NOW));
  assert.equal(health.sources['openai-news'].status, 'active');
  assert.equal(health.sources['openai-news'].protected, true);
  assert.equal(healthCounts(health).quarantined, 1);
});

test('a quarantined source returns on probation and a publish promotes it', () => {
  const first = computeSourceHealth({
    registrySources: registry,
    feedback: {
      actions: [
        reject('tg-test', 1),
        reject('tg-test', 2),
        reject('tg-test', 3),
        reject('tg-test', 4),
        rewrite('tg-test', 5),
      ],
    },
    now: NOW,
  });
  assert.equal(first.sources['tg-test'].status, 'quarantined');
  const afterCooldown = new Date(Date.parse(first.sources['tg-test'].cooldownUntil) + 1000).toISOString();
  const second = computeSourceHealth({
    registrySources: registry,
    feedback: {
      actions: [
        reject('tg-test', 1),
        reject('tg-test', 2),
        reject('tg-test', 3),
        reject('tg-test', 4),
        rewrite('tg-test', 5),
      ],
    },
    previous: first,
    now: afterCooldown,
  });
  assert.equal(second.sources['tg-test'].status, 'probation');
  const trialStart = Date.parse(second.sources['tg-test'].trialStart);
  const third = computeSourceHealth({
    registrySources: registry,
    feedback: { actions: [publish('tg-test', 0)] },
    states: [{ published: [{ at: new Date(trialStart + 3600000).toISOString(), sourceId: 'tg-test' }] }],
    previous: second,
    now: new Date(trialStart + 2 * 3600000).toISOString(),
  });
  assert.equal(third.sources['tg-test'].status, 'active');
  assert.equal(third.sources['tg-test'].reason, 'trial_passed');
});

test('a new dynamic feed starts on probation and expires without output', () => {
  const dynamic = [
    {
      id: 'auto-x',
      name: 'blog.example.com',
      type: 'discovered_feed',
      discoveredAt: at(1),
    },
  ];
  const first = computeSourceHealth({
    registrySources: registry,
    dynamicSources: dynamic,
    now: NOW,
  });
  assert.equal(first.sources['auto-x'].status, 'probation');
  assert.equal(first.sources['auto-x'].dynamic, true);
  assert.ok(Date.parse(first.sources['auto-x'].trialUntil) > Date.parse(NOW));

  const afterTrial = new Date(Date.parse(first.sources['auto-x'].trialUntil) + 1000).toISOString();
  const second = computeSourceHealth({
    registrySources: registry,
    dynamicSources: dynamic,
    previous: first,
    now: afterTrial,
  });
  assert.equal(second.sources['auto-x'].status, 'quarantined');
  assert.equal(second.sources['auto-x'].reason, 'trial_expired');
});

test('a watch source keeps one candidate per run and a bad source is skipped', () => {
  const health = computeSourceHealth({
    registrySources: registry,
    feedback: {
      actions: [reject('tg-test', 1), reject('tg-test', 2), reject('tg-test', 3), publish('tg-test', 4)],
    },
    now: NOW,
  });
  assert.equal(health.sources['tg-test'].status, 'watch');
  const applied = applySourceHealth(
    [
      { id: 'tg-test', name: 'Test channel' },
      { id: 'openai-news', name: 'OpenAI' },
    ],
    health,
    NOW,
    { watch_limit: 1 }
  );
  assert.equal(applied.limits['tg-test'], 1);
  assert.equal(applied.limits['openai-news'], undefined);

  const bad = computeSourceHealth({
    registrySources: [...registry, { id: 'tg-bad', name: 'Bad', type: 'telegram_channel' }],
    feedback: {
      actions: [
        reject('tg-bad', 1, 'promo'),
        reject('tg-bad', 2, 'promo'),
        reject('tg-bad', 3, 'irrelevant'),
        reject('tg-bad', 4, 'irrelevant'),
        rewrite('tg-bad', 5),
      ],
    },
    now: NOW,
  });
  const filtered = applySourceHealth(
    [
      { id: 'tg-test', name: 'Test' },
      { id: 'tg-bad', name: 'Bad' },
    ],
    bad,
    NOW
  );
  assert.deepEqual(filtered.sources.map((source) => source.id), ['tg-test']);
  assert.equal(filtered.skipped[0].id, 'tg-bad');
});

test('metrics only count the current window', () => {
  const metrics = sourceMetrics({
    sourceId: 'tg-test',
    actions: [reject('tg-test', 1), reject('tg-test', 60)],
    now: NOW,
    windowDays: 45,
  });
  assert.equal(metrics.rejects, 1);
  assert.equal(metrics.decisions, 1);
});

test('the status card shows source state in Persian', () => {
  const health = computeSourceHealth({
    registrySources: registry,
    feedback: {
      actions: [
        reject('tg-test', 1),
        reject('tg-test', 2),
        reject('tg-test', 3),
        reject('tg-test', 4),
      ],
    },
    now: NOW,
  });
  const text = renderStatusMessage(health, {
    now: NOW,
    state: { slots: {}, published: [], deferred: {} },
    reviewStore: { items: {} },
    dynamicCount: 0,
  });
  assert.match(text, /وضعیت رادار/);
  assert.match(text, /منابع:/);
  assert.match(text, /کنارگذاشته/);
});
