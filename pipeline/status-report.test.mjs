import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatusCard, renderDynamicSources, reportChatId, statusDue } from './status-report.mjs';
import { emptyHealth } from './source-health.mjs';

const HEALTH = {
  ...emptyHealth(),
  updatedAt: '2026-11-16T19:30:00.000Z',
  sources: {
    'auto-example-com-abc123': {
      id: 'auto-example-com-abc123',
      name: 'example.com',
      status: 'probation',
      score: 0.5,
      counts: { rejects: 1, rewrites: 0, publishes: 0 },
      trialUntil: '2026-11-30T00:00:00.000Z',
    },
    'tg-live': {
      id: 'tg-live',
      name: 'Live',
      status: 'quarantined',
      score: 0.1,
      reason: 'sustained_rejects',
      cooldownUntil: '2026-12-01T00:00:00.000Z',
      counts: { rejects: 5, rewrites: 1, publishes: 0 },
    },
  },
};

test('the daily status is due once after 22 Tehran and only once per day', () => {
  assert.deepEqual(statusDue({ health: emptyHealth(), now: '2026-11-16T18:00:00Z' }), {
    due: false,
    date: '2026-11-16',
    reason: 'before_22',
  });
  assert.equal(statusDue({ health: emptyHealth(), now: '2026-11-16T19:30:00Z' }).due, true);
  const sent = { ...emptyHealth(), lastStatusDate: '2026-11-16' };
  assert.deepEqual(statusDue({ health: sent, now: '2026-11-16T19:30:00Z' }), {
    due: false,
    date: '2026-11-16',
    reason: 'already_sent',
  });
  assert.equal(statusDue({ health: sent, now: '2026-11-16T19:30:00Z', force: true }).due, true);
});

test('the status card shows dynamic sources, trials and quarantine', () => {
  const card = buildStatusCard({
    health: HEALTH,
    dynamicDocument: {
      sources: [{ id: 'auto-example-com-abc123', name: 'example.com', trialUntil: '2026-11-30T00:00:00.000Z' }],
    },
    now: '2026-11-16T19:30:00Z',
    state: { slots: {}, published: [], deferred: {} },
    reviewStore: {
      items: { abc12345: { status: 'pending' } },
      actions: [
        { action: 'reject', at: '2026-11-16T10:00:00Z' },
        { action: 'reject', at: '2026-11-16T20:00:00Z' },
        { action: 'rewrite', at: '2026-11-16T20:10:00Z' },
        { action: 'reject', at: '2026-11-15T10:00:00Z' },
      ],
    },
    changes: [{ source: 'tg-live', from: 'watch', to: 'quarantined', reason: 'sustained_rejects' }],
    runUrl: 'https://example.com/run/1',
  });
  assert.match(card, /وضعیت رادار/);
  assert.match(card, /صف بازبینی: 1 کارت/);
  assert.match(card, /امروز: 2 رد \| 1 بازنویسی/);
  assert.match(card, /منابع پویای کشف‌شده/);
  assert.match(card, /example\.com \| آزمایشی/);
  assert.match(card, /کنار گذاشته‌شده/);
  assert.match(card, /sustained_rejects/);
  assert.match(card, /https:\/\/example\.com\/run\/1/);
});

test('no dynamic block when the discovery file is empty', () => {
  assert.equal(renderDynamicSources({ sources: [] }, HEALTH), '');
});

test('reports prefer the report chat and fall back to the review chat', () => {
  const config = {
    reports: { chat_env: 'TELEGRAM_REPORT_CHAT_ID' },
    offers: { review: { chat_env: 'TELEGRAM_REVIEW_CHAT_ID' } },
  };
  assert.deepEqual(
    reportChatId({
      env: { TELEGRAM_REPORT_CHAT_ID: '-1009', TELEGRAM_REVIEW_CHAT_ID: '-1001' },
      config,
    }),
    { chatId: '-1009', target: 'report' }
  );
  assert.deepEqual(reportChatId({ env: { TELEGRAM_REVIEW_CHAT_ID: '-1001' }, config }), {
    chatId: '-1001',
    target: 'review',
  });
  assert.deepEqual(reportChatId({ env: {}, config }), { chatId: '', target: '' });
});
