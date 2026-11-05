import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  categoryHint,
  dayKey,
  matrixTotals,
  planSlotQueue,
  slotTarget,
} from './diversity.mjs';
import { emptyState, weekKey } from './store.mjs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

const DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const live = (title, categoryHint, sourceId, ageHours = 1) => ({
  title,
  categoryHint,
  sourceId,
  ageHours,
  keys: [],
});
const run = (candidates, { state = emptyState(), date = '2026-11-07', slot = '08:30', overrides = {} } = {}) => {
  const planConfig = {
    ...config,
    ...overrides,
    diversity: { ...config.diversity, ...(overrides.diversity ?? {}) },
    categories: { ...config.categories, ...(overrides.categories ?? {}) },
  };
  return planSlotQueue({
    config: planConfig,
    state,
    date,
    slot,
    week: weekKey(date),
    candidates,
    maxCandidates: overrides.maxCandidates ?? 6,
  });
};

test('the matrix fills every slot and totals the weekly quotas', () => {
  assert.deepEqual(Object.keys(config.diversity.weekly_matrix).sort(), [...DAYS].sort());
  for (const [day, row] of Object.entries(config.diversity.weekly_matrix)) {
    assert.equal(row.length, config.schedule.slots.length, `${day} has the wrong slot count`);
  }
  assert.deepEqual(matrixTotals(config), {
    tools: 17,
    models: 13,
    security: 6,
    business: 6,
  });
  assert.equal(config.diversity.max_per_category_per_day, 3);
  assert.equal(config.diversity.max_per_source_per_day, 1);
  assert.equal(config.diversity.max_per_source_per_week, 4);
  assert.equal(config.diversity.max_candidates, 6);
  assert.equal(config.diversity.no_consecutive_category, true);
});

test('no category repeats back to back inside the week or at its edges', () => {
  for (const day of DAYS) {
    const row = config.diversity.weekly_matrix[day];
    for (let index = 1; index < row.length; index += 1) {
      assert.notEqual(row[index], row[index - 1], `${day} repeats ${row[index]}`);
    }
  }
  for (let index = 0; index < DAYS.length; index += 1) {
    const current = config.diversity.weekly_matrix[DAYS[index]].at(-1);
    const next = config.diversity.weekly_matrix[DAYS[(index + 1) % DAYS.length]][0];
    assert.notEqual(current, next, `${DAYS[index]} ends next to ${DAYS[(index + 1) % DAYS.length]}`);
  }
});

test('the slot target follows the Tehran weekday and slot index', () => {
  assert.equal(dayKey('2026-11-07'), 'sat');
  assert.equal(dayKey('2026-11-13'), 'fri');
  assert.throws(() => dayKey('bad-date'));
  assert.equal(slotTarget(config, '2026-11-07', '08:30'), 'models');
  assert.equal(slotTarget(config, '2026-11-07', '23:00'), 'security');
  assert.equal(slotTarget(config, '2026-11-07', '12:00'), '');
  assert.equal(slotTarget(config, '2026-11-01', '08:30'), 'tools');
});

test('category hints use explicit lead flags first', () => {
  assert.equal(categoryHint({ toolHint: true, title: 'خبر تازه' }), 'tools');
  assert.equal(categoryHint({ offerHint: true, title: 'خبر تازه' }), 'tools');
  assert.equal(categoryHint({ officialCourse: true, title: 'خبر تازه' }), 'tools');
});

test('category hints weigh titles, summaries and source categories', () => {
  assert.equal(categoryHint({ title: 'ابزار تازه برای ساخت ویدیو' }), 'tools');
  assert.equal(categoryHint({ title: 'مدل زبانی تازه با بنچمارک بهتر' }), 'models');
  assert.equal(categoryHint({ title: 'حمله سایبری به شرکت‌ها' }), 'security');
  assert.equal(categoryHint({ title: 'سرمایه‌گذاری میلیاردی در یک استارتاپ' }), 'business');
  assert.equal(categoryHint({ title: 'خبر تازه', summary: 'نشت داده و حمله به سرویس' }), 'security');
  assert.equal(categoryHint({ title: 'خبر تازه', sourceCategories: ['business'] }), 'business');
  assert.equal(categoryHint({ title: 'خبر تازه' }), '');
});

test('the queue starts from the slot target', () => {
  const plan = run([
    live('یک ابزار', 'tools', 's1'),
    live('یک مدل', 'models', 's2'),
  ]);
  assert.equal(plan.target, 'models');
  assert.deepEqual(plan.queue.map((entry) => entry.categoryHint), ['models', 'tools']);
});

test('an empty target falls back to the category with the most room', () => {
  const plan = run([
    live('یک کسب‌وکار', 'business', 's1'),
    live('یک ابزار', 'tools', 's2'),
  ]);
  assert.equal(plan.target, 'models');
  assert.deepEqual(plan.queue.map((entry) => entry.categoryHint), ['tools', 'business']);
});

test('a repeated source is skipped before the queue', () => {
  const state = emptyState();
  state.published = [
    { slot: '2026-11-07T08:30+03:30', category: 'models', sourceId: 's1', week: weekKey('2026-11-07') },
  ];
  const plan = run([live('همان منبع', 'tools', 's1'), live('منبع تازه', 'business', 's2')], { state });
  assert.equal(plan.rejected.source_consecutive, 1);
  assert.deepEqual(plan.queue.map((entry) => entry.sourceId), ['s2']);
});

test('source daily and weekly caps are enforced', () => {
  const state = emptyState();
  const week = weekKey('2026-11-13');
  state.published = [
    { slot: '2026-11-07T08:30+03:30', category: 'models', sourceId: 's1', week },
    { slot: '2026-11-08T08:30+03:30', category: 'models', sourceId: 's1', week },
    { slot: '2026-11-09T08:30+03:30', category: 'models', sourceId: 's1', week },
    { slot: '2026-11-10T08:30+03:30', category: 'models', sourceId: 's1', week },
    { slot: '2026-11-13T08:30+03:30', category: 'tools', sourceId: 's3', week },
    { slot: '2026-11-13T11:30+03:30', category: 'models', sourceId: 's2', week },
  ];
  const plan = run(
    [live('منبع هفتگی', 'models', 's1'), live('منبع روزانه', 'tools', 's3'), live('منبع آزاد', 'business', 's4')],
    { state, date: '2026-11-13' }
  );
  assert.equal(plan.rejected.source_weekly, 1);
  assert.equal(plan.rejected.source_daily, 1);
  assert.deepEqual(plan.queue.map((entry) => entry.sourceId), ['s4']);
});

test('category daily and consecutive caps are enforced', () => {
  const state = emptyState();
  const week = weekKey('2026-11-07');
  state.published = [
    { slot: '2026-11-07T08:30+03:30', category: 'models', sourceId: 'a', week },
    { slot: '2026-11-07T11:30+03:30', category: 'models', sourceId: 'b', week },
    { slot: '2026-11-07T14:00+03:30', category: 'models', sourceId: 'c', week },
    { slot: '2026-11-07T17:00+03:30', category: 'tools', sourceId: 'd', week },
  ];
  const plan = run(
    [
      live('مدل چهارم', 'models', 's1'),
      live('ابزار دوم', 'tools', 's2'),
      live('کسب‌وکار', 'business', 's3'),
    ],
    { state }
  );
  assert.equal(plan.rejected.category_daily, 1);
  assert.equal(plan.rejected.category_consecutive, 1);
  assert.deepEqual(plan.queue.map((entry) => entry.sourceId), ['s3']);
});

test('a full weekly quota removes the category from fallback', () => {
  const state = emptyState();
  state.published = [
    {
      slot: '2026-11-07T08:30+03:30',
      category: 'models',
      sourceId: 's1',
      week: weekKey('2026-11-13'),
    },
  ];
  const plan = run([live('مدل', 'models', 's2'), live('ابزار', 'tools', 's3')], {
    state,
    date: '2026-11-13',
    overrides: {
      diversity: { max_per_category_per_day: 99, no_consecutive_category: false },
      categories: { models: { ...config.categories.models, weekly_quota: 1 } },
    },
  });
  assert.equal(plan.rejected.quota_full, 1);
  assert.deepEqual(plan.queue.map((entry) => entry.categoryHint), ['tools']);
});

test('a category or source from yesterday does not block the first slot today', () => {
  const state = emptyState();
  state.published = [
    {
      slot: '2026-11-06T23:00+03:30',
      category: 'business',
      sourceId: 's1',
      week: weekKey('2026-11-06'),
    },
  ];
  const plan = run([live('کسب‌وکار تازه', 'business', 's1')], {
    state,
    date: '2026-11-07',
    slot: '08:30',
  });
  assert.equal(plan.rejected.category_consecutive, 0);
  assert.equal(plan.rejected.source_consecutive, 0);
  assert.deepEqual(plan.queue.map((entry) => entry.categoryHint), ['business']);
});

test('a crowded target category still leaves room for fallback categories', () => {
  const candidates = Array.from({ length: 8 }, (_, index) =>
    live(`کسب‌وکار ${index}`, 'business', `b${index}`)
  );
  candidates.push(live('ابزار جایگزین', 'tools', 't1'));
  const plan = run(candidates, {
    date: '2026-11-05',
    slot: '20:30',
    overrides: {
      diversity: {
        max_per_category_per_day: 99,
        max_per_source_per_day: 99,
        max_per_source_per_week: 99,
        no_consecutive_category: false,
      },
    },
  });
  assert.equal(plan.target, 'business');
  assert.ok(plan.queue.some((entry) => entry.categoryHint === 'tools'));
  assert.equal(plan.queue.length, 6);
});

test('the queue keeps at most one candidate per source', () => {
  const plan = run(
    [
      live('TechCrunch 1', 'business', 'techcrunch'),
      live('TechCrunch 2', 'business', 'techcrunch'),
      live('TechCrunch 3', 'business', 'techcrunch'),
      live('The Decoder', 'business', 'the-decoder'),
      live('ابزار', 'tools', 'product-hunt'),
    ],
    { date: '2026-11-05', slot: '20:30' }
  );
  const sources = plan.queue.map((entry) => entry.sourceId);
  assert.equal(new Set(sources).size, sources.length);
  assert.deepEqual(sources, ['techcrunch', 'the-decoder', 'product-hunt']);
});

test('the queue never exceeds the candidate cap', () => {
  const many = Array.from({ length: 8 }, (_, index) => live(`ابزار ${index}`, 'tools', `s${index}`));
  const plan = run(many, {
    overrides: {
      maxCandidates: 6,
      diversity: {
        max_per_category_per_day: 99,
        max_per_source_per_day: 99,
        max_per_source_per_week: 99,
        no_consecutive_category: false,
      },
    },
  });
  assert.equal(plan.queue.length, 6);
});
