import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, summarizeDay, weekdayFa } from './report.mjs';
import { weekKey } from './store.mjs';

const DATE = '2026-11-05';
const WEEK = weekKey(DATE);

const config = {
  schedule: { max_posts_per_day: 6 },
  categories: {
    tools: { label: 'ابزارها و محصولات', weekly_quota: 4 },
    models: { label: 'مدل‌ها و پژوهش', weekly_quota: 3 },
    security: { label: 'امنیت و حریم خصوصی', weekly_quota: 2 },
    business: { label: 'کسب‌وکار و بازار', weekly_quota: 1 },
  },
};

const state = {
  slots: {
    '2026-11-05T08:30+03:30': {
      status: 'sent',
      category: 'tools',
      title: 'ابزار تازه',
      cost: 0.001,
      tokens: 1000,
      qa: '10/11',
      model: 'DeepSeek-V4-Flash',
    },
    '2026-11-05T11:30+03:30': {
      status: 'review',
      category: 'models',
      title: 'مقاله پژوهشی',
      reason: 'research_paper',
      cost: 0.0005,
      tokens: 500,
    },
    '2026-11-05T14:00+03:30': {
      status: 'empty',
      reason: 'all_candidates_rejected',
      cost: 0.0002,
      tokens: 200,
    },
    '2026-11-05T17:00+03:30': {
      status: 'sent',
      category: 'business',
      title: 'خبر بازار',
    },
    '2026-11-04T23:00+03:30': { status: 'sent', category: 'tools', cost: 9, tokens: 9 },
  },
  published: [
    { week: WEEK, slot: '2026-11-05T08:30+03:30', category: 'tools' },
    { week: WEEK, slot: '2026-11-05T17:00+03:30', category: 'business' },
    { week: WEEK, slot: '2026-11-04T23:00+03:30', category: 'tools' },
  ],
  offerReviews: [
    {
      id: 'a',
      date: DATE,
      reason: 'research_paper',
      mainEligible: false,
      source: 'hf-papers',
      title: 'مقاله',
    },
    { id: 'b', date: DATE, reason: 'model_skip', mainEligible: false, source: 'tg', title: 'ابزار' },
    { id: 'old', date: '2026-11-04', reason: 'quiet_hours', mainEligible: true, source: 'tg' },
  ],
  reviewPending: {
    p1: { id: 'p1', createdAt: '2026-11-05T05:00:00Z', source: 'tg', title: 'در انتظار' },
    p2: { id: 'p2', createdAt: '2026-11-04T05:00:00Z', source: 'tg', title: 'قدیمی' },
  },
  deferred: { one: {}, two: {} },
};

const extraStates = [
  {
    offerReviews: [
      { id: 'b', date: DATE, reason: 'model_skip', mainEligible: true, source: 'tg', title: 'ابزار' },
      { id: 'c', date: DATE, reason: 'quiet_hours', mainEligible: true, source: 'tg', title: 'آرام' },
    ],
    reviewPending: { p1: { id: 'p1', createdAt: '2026-11-05T05:00:00Z' } },
  },
];

const reports = [
  {
    slot: '2026-11-05T17:00+03:30',
    category: 'business',
    model: { name: 'DeepSeek-V4-Flash', cost: 0.0007, tokens: 700 },
    qa: { pass: true, score: 11, possible: 11 },
    post: { title: 'خبر بازار' },
  },
];

const summary = summarizeDay({
  date: DATE,
  state,
  extraStates,
  reports,
  config,
});

test('summary reads one day of slots and falls back to artifact costs', () => {
  assert.equal(summary.rows.length, 4);
  assert.equal(summary.weekday, 'پنجشنبه');
  assert.equal(weekdayFa(DATE), 'پنجشنبه');
  const business = summary.rows.find((row) => row.slot === '17:00');
  assert.equal(business.cost, 0.0007);
  assert.equal(business.tokens, 700);
  assert.equal(business.qa, '11/11');
  assert.equal(business.costKnown, true);
  assert.equal(summary.totals.cost.toFixed(6), '0.002400');
  assert.equal(summary.totals.tokens, 2400);
  assert.equal(summary.totals.costMissing, 0);
});

test('summary keeps the daily cap and the weekly quota from state', () => {
  assert.equal(summary.budget.used, 2);
  assert.equal(summary.budget.cap, 6);
  const tools = summary.quota.find((item) => item.category === 'tools');
  assert.equal(tools.used, 2);
  assert.equal(tools.cap, 4);
  assert.equal(tools.remaining, 2);
  assert.equal(summary.quota.find((item) => item.category === 'business').remaining, 0);
});

test('reviews are counted once per id across the main and review lanes', () => {
  assert.equal(summary.reviews.length, 3);
  assert.equal(summary.reviewReasons.research_paper, 1);
  assert.equal(summary.reviewReasons.model_skip, 1);
  assert.equal(summary.reviewReasons.quiet_hours, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.deferred, 2);
});

test('rendered report shows the date, costs, quota and review reasons', () => {
  const text = renderReport(summary);
  assert.match(text, /# گزارش روزانه 2026-11-05 \(پنجشنبه\)/);
  assert.match(text, /ثبت‌شده امروز: 2 از 6/);
  assert.match(text, /هزینه مدل: \$0\.002400/);
  assert.match(text, /میانگین هر پست ارسال‌شده: \$0\.001200/);
  assert.match(text, /ابزارها و محصولات \| 2 \| 4 \| 2/);
  assert.match(text, /مقاله پژوهشی منتخب 1/);
  assert.match(text, /در انتظار ارسال به بازبینی: 1/);
  assert.match(text, /در انتظار: 2/);
  assert.match(text, /ارسال‌شده/);
});

test('a day without artifacts says cost is not recorded instead of showing zero', () => {
  const empty = summarizeDay({
    date: '2026-11-06',
    state: { slots: {}, published: [], offerReviews: [], deferred: {} },
    reports: [],
    config,
  });
  assert.equal(empty.totals.costKnown, false);
  const text = renderReport(empty);
  assert.match(text, /امروز اجرایی ثبت نشده است/);
  assert.match(text, /اسلاتی ثبت نشده است/);
});
