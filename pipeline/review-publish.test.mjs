import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterOwnReviewEntries,
  publishGuards,
  publishSlotFor,
  qaForPublish,
  slotWindowStatus,
} from './review-publish.mjs';
import { weekKey } from './store.mjs';

const NOW = '2026-11-14T15:00:00Z';
const DATE = '2026-11-14';
const WEEK = weekKey(DATE);
const LONG = 'این یک متن خبری کوتاه دربارهٔ مدل تازه است. '.repeat(12);

const CONFIG = {
  schedule: { max_posts_per_day: 11, quiet_hours: ['00:00', '08:30'] },
  categories: {
    tools: { weekly_quota: 31 },
    models: { weekly_quota: 24 },
    security: { weekly_quota: 11 },
    business: { weekly_quota: 11 },
  },
  diversity: {
    max_per_category_per_day: { tools: 4, models: 4, security: 2, business: 2 },
    max_per_source_per_day: 1,
    max_per_source_per_week: 4,
  },
};

function baseItem(fields = {}) {
  return {
    id: 'a1b2c3d4e5',
    status: 'pending',
    kind: 'post',
    title: 'مدل تازه شرکت',
    source: 'src-1',
    sourceName: 'منبع رسمی',
    messageText: LONG,
    url: 'https://example.com/news',
    keys: [],
    post: {
      title: 'مدل تازه شرکت معرفی شد',
      category: 'models',
      body: 'شرکت مدل تازه‌اش را معرفی کرد.\n\nاهمیتش اینه که دسترسی توسعه‌دهنده‌ها ساده‌تر می‌شه.',
    },
    ...fields,
  };
}

function published(fields = {}) {
  return {
    lane: 'main',
    decision: 'publish',
    title: 'خبر منتشرشده',
    slot: `${DATE}T08:30`,
    category: 'models',
    sourceId: '',
    sourceName: '',
    week: WEEK,
    ...fields,
  };
}

function guard(options = {}) {
  return publishGuards({
    config: CONFIG,
    state: { published: [] },
    item: baseItem(),
    qa: { pass: true, problems: [] },
    now: NOW,
    delivered: [],
    ...options,
  });
}

test('the publish slot uses the current tehran day and clock', () => {
  assert.equal(publishSlotFor(NOW), '2026-11-14T18:30');
});

test('the action poller stands down around each scheduled slot', () => {
  const slots = ['08:30', '11:30', '14:00', '17:00', '20:30', '23:00'];
  assert.equal(slotWindowStatus('2026-11-14T15:00:00Z', slots).active, false);
  const running = slotWindowStatus('2026-11-14T13:35:00Z', slots);
  assert.equal(running.active, true);
  assert.equal(running.slot, '17:00');
  const before = slotWindowStatus('2026-11-14T16:50:00Z', slots);
  assert.equal(before.active, true);
  assert.equal(before.slot, '20:30');
  const midnight = slotWindowStatus('2026-11-14T20:30:00Z', ['23:00']);
  assert.equal(midnight.active, false);
  assert.equal(slotWindowStatus('2026-11-14T20:05:00Z', ['23:00']).active, true);
});

test('the item own review record never blocks its publish as a duplicate', () => {
  const item = baseItem();
  const own = { lane: 'review', decision: 'review', title: item.title };
  const draft = { lane: 'review', decision: 'review', title: item.post.title };
  const other = { lane: 'review', decision: 'review', title: 'خبر دیگر' };
  const live = published({ title: item.title });
  const kept = filterOwnReviewEntries([own, draft, other, live], item);
  assert.deepEqual(kept, [other, live]);
  assert.deepEqual(filterOwnReviewEntries(undefined, item), []);
});

test('a post without a draft skips the publish QA', () => {
  assert.equal(qaForPublish(baseItem({ post: null }), NOW, CONFIG), null);
  const qa = qaForPublish(baseItem(), NOW, CONFIG);
  assert.equal(typeof qa.pass, 'boolean');
  assert.ok(Array.isArray(qa.problems));
});

test('a closed item or a missing draft is rejected first', () => {
  assert.equal(guard({ item: baseItem({ status: 'sent' }) }).reason, 'closed');
  assert.equal(guard({ item: baseItem({ status: 'rejected' }) }).reason, 'closed');
  assert.equal(guard({ item: baseItem({ post: null }), qa: null }).reason, 'no_post');
});

test('a failed QA blocks publish with its problems', () => {
  const result = guard({ qa: { pass: false, problems: ['title', 'source'] } });
  assert.equal(result.reason, 'qa_failed');
  assert.match(result.detail, /title/);
  assert.match(result.detail, /source/);
});

test('quiet hours block a manual publish until the morning', () => {
  const result = guard({ now: '2026-11-14T02:00:00Z' });
  assert.equal(result.reason, 'quiet_hours');
});

test('the daily budget and category caps are enforced in order', () => {
  const full = Array.from({ length: 11 }, (_, index) =>
    published({ title: `خبر ${index}`, slot: `${DATE}T08:30` })
  );
  assert.equal(guard({ state: { published: full } }).reason, 'daily_cap');

  const fourModels = Array.from({ length: 4 }, (_, index) =>
    published({ title: `مدل ${index}`, slot: `${DATE}T08:30` })
  );
  assert.equal(guard({ state: { published: fourModels } }).reason, 'category_daily_cap');

  const weekly = [published({ title: 'مدل هفته', slot: `${DATE}T08:30` })];
  const config = {
    ...CONFIG,
    categories: { ...CONFIG.categories, models: { weekly_quota: 1 } },
  };
  assert.equal(guard({ state: { published: weekly }, config }).reason, 'category_weekly_cap');
});

test('the source daily and weekly caps are enforced', () => {
  const one = [published({ sourceId: 'src-1', title: 'خبر منبع', category: 'tools' })];
  assert.equal(guard({ state: { published: one } }).reason, 'source_daily_cap');

  const config = {
    ...CONFIG,
    diversity: { ...CONFIG.diversity, max_per_source_per_day: 2, max_per_source_per_week: 1 },
  };
  assert.equal(guard({ state: { published: one }, config }).reason, 'source_weekly_cap');
});

test('an offer without a source link stays out of the main channel', () => {
  const result = guard({ item: baseItem({ kind: 'offer', url: '' }) });
  assert.equal(result.reason, 'offer_link_missing');
});

test('a story that already went out is blocked as a duplicate', () => {
  const title = 'مدل تازه شرکت معرفی شد';
  const result = guard({
    item: baseItem({ title }),
    delivered: [published({ title })],
  });
  assert.equal(result.reason, 'duplicate');
  assert.match(result.detail, /مدل تازه شرکت/);
});

test('an eligible item passes with its resolved category and caps', () => {
  const result = guard();
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'ok');
  assert.equal(result.category, 'models');
  assert.equal(result.date, DATE);
  assert.equal(result.week, WEEK);
  assert.deepEqual(result.budget, { cap: 11, used: 0, remaining: 11, ok: true });
});
