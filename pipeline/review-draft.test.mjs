import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateFromItem,
  draftReviewPost,
  offerContextFromItem,
  qaContextForItem,
  resolvedImageUrl,
} from './review-draft.mjs';

const NOW = '2026-11-14T15:00:00Z';
const LONG = 'این یک متن خبری کوتاه دربارهٔ مدل تازه است. '.repeat(12);

function baseItem(fields = {}) {
  return {
    id: 'a1b2c3d4e5',
    kind: 'post',
    title: 'مدل تازه شرکت',
    url: 'https://example.com/news',
    sourceName: 'منبع رسمی',
    sourceType: 'official_blog',
    publishedAt: '2026-11-14T10:00:00Z',
    messageText: LONG,
    relatedLinks: [],
    images: [],
    imageUrl: '',
    keys: [],
    ...fields,
  };
}

const PUBLISH_JSON = JSON.stringify({
  decision: 'publish',
  post_type: 'deep',
  importance: 4,
  verification: 'official',
  category: 'models',
  title: 'مدل تازه شرکت معرفی شد',
  body: 'شرکت مدل تازه‌اش را معرفی کرد.\n\nاهمیتش اینه که دسترسی توسعه‌دهنده‌ها را ساده‌تر می‌کند.',
  quote: '',
  source_url: 'https://example.com/news',
  image_url: '',
  key_facts: ['مدل تازه معرفی شد', 'دسترسی توسعه‌دهنده ساده‌تر شد'],
  entities: { companies: ['شرکت'], models: ['مدل تازه'] },
  dedupe_key: 'model-taze',
});

test('a short source is not sent to the writer', async () => {
  let called = false;
  const result = await draftReviewPost({
    item: baseItem({ messageText: 'کوتاه' }),
    now: NOW,
    request: async () => {
      called = true;
    },
  });
  assert.equal(result.reason, 'short');
  assert.equal(called, false);
});

test('an offer without an expiry cannot be rewritten blindly', async () => {
  let called = false;
  const result = await draftReviewPost({
    item: baseItem({ kind: 'offer', offerHint: true }),
    now: NOW,
    request: async () => {
      called = true;
    },
  });
  assert.equal(result.reason, 'offer_context_missing');
  assert.equal(called, false);
});

test('a model skip returns the source reason without a post', async () => {
  const result = await draftReviewPost({
    item: baseItem(),
    now: NOW,
    request: async () => ({
      content: JSON.stringify({ decision: 'skip', reason_code: 'off_topic', reason: 'ربطی به هوش مصنوعی ندارد' }),
      usage: { total_tokens: 20 },
    }),
  });
  assert.equal(result.reason, 'model_skip');
  assert.match(result.detail, /ربطی/);
  assert.equal(result.post, null);
  assert.equal(result.tokens, 20);
});

test('a failed or non-json model answer stays retryable', async () => {
  const failed = await draftReviewPost({
    item: baseItem(),
    now: NOW,
    request: async () => ({ content: '', status: 502, error: 'Bad Gateway' }),
  });
  assert.equal(failed.reason, 'model_failed');
  assert.match(failed.detail, /502/);
  const invalid = await draftReviewPost({
    item: baseItem(),
    now: NOW,
    request: async () => ({ content: 'not-json' }),
  });
  assert.equal(invalid.reason, 'model_failed');
  assert.equal(invalid.detail, 'invalid_json');
});

test('a valid rewrite gets mechanical fixes and the same QA gate as the main lane', async () => {
  let story;
  const item = baseItem();
  const result = await draftReviewPost({
    item,
    now: NOW,
    request: async (input) => {
      story = input;
      return { content: PUBLISH_JSON, usage: { cost: 0.0012, total_tokens: 321 } };
    },
  });
  assert.equal(story.article.content, LONG.trim());
  assert.equal(story.url, 'https://example.com/news');
  assert.equal(story.item.title, 'مدل تازه شرکت');
  assert.ok(result.post);
  assert.equal(result.post.source_url, 'https://example.com/news');
  assert.match(result.post.body, /منبع:/);
  assert.equal(result.cost, 0.0012);
  assert.equal(result.tokens, 321);
  assert.equal(typeof result.qa.pass, 'boolean');
  assert.equal(result.reason, result.qa.pass ? 'ok' : 'qa_failed');
});

test('the item context keeps the source, links, flags, and offer expiry', () => {
  const item = baseItem({
    kind: 'offer',
    expiry: { date: '۲۰ نوامبر ۲۰۲۶', remainingHours: 30 },
    relatedLinks: ['https://example.com/tool'],
    policy: true,
  });
  const candidate = candidateFromItem(item);
  assert.equal(candidate.link, 'https://example.com/news');
  assert.equal(candidate.sourceType, 'official_blog');
  assert.equal(candidate.policy, true);
  assert.equal(candidate.offerHint, false);
  const offer = offerContextFromItem(item, { offers: { min_remaining_hours: 24 } });
  assert.equal(offer.detected, true);
  assert.equal(offer.openEnded, false);
  assert.equal(offer.date, '۲۰ نوامبر ۲۰۲۶');
  assert.equal(offer.minRemainingHours, 24);
  assert.equal(offerContextFromItem(baseItem(), {}), null);
  const open = offerContextFromItem(baseItem({ kind: 'offer', expiry: null }), {
    offers: { no_expiry_note: 'بدون تاریخ انقضای اعلام‌شده' },
  });
  assert.equal(open.openEnded, true);
  assert.match(open.note, /بدون تاریخ/);
});

test('the QA context uses the resolved image and the source URL', () => {
  const withImage = baseItem({ images: ['https://cdn.example.com/a.jpg'], imageUrl: '' });
  assert.equal(resolvedImageUrl(withImage), 'https://cdn.example.com/a.jpg');
  assert.equal(resolvedImageUrl(baseItem({ images: ['http://insecure/a.jpg'] })), '');
  const context = qaContextForItem(withImage, { category: 'models' }, NOW, {});
  assert.equal(context.url, 'https://example.com/news');
  assert.equal(context.host, 'example.com');
  assert.equal(context.imageUrl, 'https://cdn.example.com/a.jpg');
  assert.equal(context.category, 'models');
  assert.equal(context.policy, false);
});
