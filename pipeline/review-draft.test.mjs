import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUserMessage } from './engine.mjs';
import {
  candidateFromItem,
  draftReviewPost,
  noteLinksForItem,
  offerContextFromItem,
  qaContextForItem,
  resolvedImageUrl,
} from './review-draft.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

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

test('a short source is allowed only when a human asks for the rewrite', async () => {
  let called = false;
  const result = await draftReviewPost({
    item: baseItem({ messageText: 'یک ابزار تازه.' }),
    now: NOW,
    manual: true,
    request: async () => {
      called = true;
      return {
        content: JSON.stringify(MANUAL_JSON),
        usage: { cost: 0, total_tokens: 10 },
      };
    },
  });
  assert.equal(called, true);
  assert.notEqual(result.reason, 'short');
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

test('a tool rewrite cites the tool once and never the Telegram channel', async () => {
  const repo = 'https://github.com/LottieFiles/motion-design-skill';
  let story;
  const result = await draftReviewPost({
    item: baseItem({
      url: repo,
      sourceName: 'Code.Cloud | کد کلاد',
      sourceType: 'telegram_channel',
      relatedLinks: [repo],
    }),
    now: NOW,
    request: async (input) => {
      story = input;
      return {
        content: JSON.stringify({
          ...JSON.parse(PUBLISH_JSON),
          category: 'tools',
          title: 'مهارت طراحی موشن برای هوش مصنوعی',
          source_url: repo,
        }),
        usage: { cost: 0, total_tokens: 10 },
      };
    },
  });
  assert.equal(story.toolUrl, repo);
  assert.ok(result.post);
  assert.ok(
    result.post.body.endsWith(`لینک استفاده: [LottieFiles/motion-design-skill](${repo})`),
    result.post.body
  );
  assert.equal(result.post.body.includes('Code.Cloud'), false);
  assert.equal(result.post.body.includes('منبع:'), false);
  assert.equal(result.qa.problems.includes('source'), false);
});

test('a too-long title goes to a focused repair instead of being cut', async () => {
  const longTitle = 'شرکت مدل تازه‌اش را با قابلیت‌های بیشتر برای همه توسعه‌دهنده‌ها در سراسر جهان معرفی کرد و گفت';
  const saved = {
    ...JSON.parse(PUBLISH_JSON),
    body: 'شرکت مدل هوش مصنوعی تازه‌اش را معرفی کرد.\n\nاهمیتش اینه که دسترسی توسعه‌دهنده‌ها را ساده‌تر می‌کند.',
  };
  let repairs = 0;
  const result = await draftReviewPost({
    item: baseItem(),
    now: NOW,
    request: async () => ({
      content: JSON.stringify({ ...saved, title: longTitle }),
      usage: { cost: 0.001, total_tokens: 200 },
    }),
    repairTitle: async ({ parsed, qa }) => {
      repairs += 1;
      assert.equal(parsed.title, longTitle);
      assert.ok(qa.problems.includes('title_words'));
      return {
        content: JSON.stringify({ title: 'مدل تازه شرکت معرفی شد' }),
        usage: { cost: 0.0005, total_tokens: 50 },
      };
    },
  });
  assert.equal(repairs, 1);
  assert.equal(result.post.title, 'مدل تازه شرکت معرفی شد');
  assert.equal(result.qa.problems.includes('title_words'), false);
  assert.equal(result.cost, 0.0015);
  assert.equal(result.tokens, 250);
});

test('without a repair the long title is kept so QA can reject it', async () => {
  const longTitle = 'شرکت مدل تازه‌اش را با قابلیت‌های بیشتر برای همه توسعه‌دهنده‌ها در سراسر جهان معرفی کرد و گفت';
  const saved = {
    ...JSON.parse(PUBLISH_JSON),
    body: 'شرکت مدل هوش مصنوعی تازه‌اش را معرفی کرد.\n\nاهمیتش اینه که دسترسی توسعه‌دهنده‌ها را ساده‌تر می‌کند.',
  };
  const result = await draftReviewPost({
    item: baseItem(),
    now: NOW,
    request: async () => ({ content: JSON.stringify({ ...saved, title: longTitle }) }),
  });
  assert.equal(result.post.title, longTitle);
  assert.ok(result.qa.problems.includes('title_words'));
  assert.equal(result.reason, 'qa_failed');
});

const REPAIRED_BODY = [
  'شرکت مدل تازه‌اش را برای توسعه‌دهنده‌ها معرفی کرد و گفت دسترسی به آن از همین امروز باز شده.',
  '',
  'به گفتهٔ شرکت، این مدل برای کارهای روزمره تیم‌ها ساخته شده و لازم نیست کسی تنظیمات پیچیده انجام بدهد. هر کسی می‌تواند با همان حساب فعلی‌اش امتحانش کند و نتیجه را مستقیم در کار خودش ببیند.',
  '',
  'این موضوع از اونجایی مهمه که ورود به این مدل بدون فرایند تازه انجام می‌شه و تیم‌های کوچک می‌تونن زودتر کارشان را شروع کنند.',
].join('\n');

test('a length failure gets one repair and the better version is kept', async () => {
  const shortStandard = {
    ...JSON.parse(PUBLISH_JSON),
    post_type: 'standard',
    category: 'models',
    title: 'مدل تازه شرکت معرفی شد',
    body: 'شرکت مدل تازه‌اش را معرفی کرد.\n\nاهمیتش اینه که دسترسی توسعه‌دهنده‌ها ساده‌تر می‌شود.',
  };
  let repairs = 0;
  const result = await draftReviewPost({
    item: baseItem(),
    now: NOW,
    manual: true,
    request: async () => ({ content: JSON.stringify(shortStandard), usage: { cost: 0.001, total_tokens: 200 } }),
    repairPost: async ({ parsed, qa }) => {
      repairs += 1;
      assert.equal(parsed.post_type, 'standard');
      assert.ok(qa.problems.includes('length'), qa.problems.join(','));
      return {
        content: JSON.stringify({ ...shortStandard, body: REPAIRED_BODY }),
        usage: { cost: 0.0005, total_tokens: 50 },
      };
    },
  });
  assert.equal(repairs, 1);
  assert.equal(result.qa.pass, true, result.qa.problems.join(','));
  assert.equal(result.qa.problems.includes('length'), false);
  assert.equal(result.post.body.includes('تیم‌های کوچک می‌تونن زودتر'), true);
  assert.equal(result.cost, 0.0015);
  assert.equal(result.tokens, 250);
  assert.equal(result.reason, 'ok');
});

test('a repair that does not improve the post leaves the original for QA', async () => {
  const shortStandard = {
    ...JSON.parse(PUBLISH_JSON),
    post_type: 'standard',
    category: 'models',
    body: 'شرکت مدل تازه‌اش را معرفی کرد.\n\nاهمیتش اینه که دسترسی توسعه‌دهنده‌ها ساده‌تر می‌شود.',
  };
  let repairs = 0;
  const result = await draftReviewPost({
    item: baseItem(),
    now: NOW,
    manual: true,
    request: async () => ({ content: JSON.stringify(shortStandard), usage: { cost: 0.001, total_tokens: 200 } }),
    repairPost: async () => {
      repairs += 1;
      return { content: JSON.stringify({ ...shortStandard, body: 'خیلی کوتاه' }), usage: { cost: 0.0002, total_tokens: 20 } };
    },
  });
  assert.equal(repairs, 1);
  assert.ok(result.qa.problems.includes('length'));
  assert.equal(result.reason, 'qa_failed');
  assert.ok(Math.abs(result.cost - 0.0012) < 1e-12);
  assert.equal(result.tokens, 220);
});

test('an operator note reaches the writer prompt and the QA grounding', async () => {
  const note = 'منبع مکمل: https://example.com/extra\nاین را هم در متن لحاظ کن.';
  const item = baseItem({ note });
  let story;
  await draftReviewPost({
    item,
    now: NOW,
    request: async (input) => {
      story = input;
      return { content: PUBLISH_JSON, usage: { cost: 0, total_tokens: 10 } };
    },
  });
  assert.equal(story.note, note);
  const prompt = buildUserMessage(story);
  assert.match(prompt, /یادداشت اپراتور/);
  assert.ok(prompt.includes('https://example.com/extra'));
  const context = qaContextForItem(item, { category: 'models' }, NOW, {});
  assert.ok(context.content.includes(note));
  assert.ok(context.links.includes('https://example.com/extra'));
  assert.deepEqual(
    noteLinksForItem(baseItem({ note: 'https://t.me/example/1 https://example.com/a' })),
    ['https://example.com/a']
  );
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

const MANUAL_SOURCE = 'این یک متن خبری کوتاه دربارهٔ یک تقویم آنلاین تازه است. '.repeat(12);
const MANUAL_BODY = [
  'تقویم آنلاین تازه‌ای منتشر شد که کار تیم‌ها را برای هماهنگی جلسه‌ها ساده‌تر می‌کند.',
  '',
  'در این نسخه، هر عضو می‌تواند زمان‌های خالی را ببیند و جلسه را بدون رفت‌وآمد در چند پیام تنظیم کند. سازنده می‌گوید این تغییر برای تیم‌های کوچک و پروژه‌های پرسرعت طراحی شده و نیازی به ابزار جداگانه نیست. همهٔ اعضا یک نمای مشترک از برنامهٔ هفته دارند و می‌توانند تغییرها را همان‌جا ببینند.',
  '',
  'این موضوع از اونجایی مهمه که وقت تیم‌ها با هماهنگی دستی هدر می‌ره و یک تقویم ساده می‌تونه کار روزمره را جمع‌وجورتر کند.',
].join('\n');

const MANUAL_JSON = {
  decision: 'publish',
  post_type: 'standard',
  importance: 3,
  verification: 'unverified',
  category: 'tools',
  title: 'تقویم آنلاین تازه برای تیم‌ها',
  body: MANUAL_BODY,
  quote: '',
  source_url: '',
  image_url: '',
  key_facts: ['تقویم تازه منتشر شد', 'هماهنگی جلسه‌ها ساده‌تر شد'],
  entities: { companies: ['سازنده'], models: [] },
  dedupe_key: 'calendar-online',
};

function manualItem(fields = {}) {
  return baseItem({
    title: 'تقویم آنلاین تازه',
    url: 'https://t.me/example/1',
    leadPostUrl: 'https://t.me/example/1',
    sourceName: 'کانال نمونه',
    sourceType: 'telegram_channel',
    publishedAt: '2026-10-01T00:00:00Z',
    messageText: MANUAL_SOURCE,
    ...fields,
  });
}

test('a manual rewrite ignores freshness, source, and AI relevance but keeps structure', async () => {
  let story;
  const result = await draftReviewPost({
    item: manualItem(),
    now: NOW,
    manual: true,
    request: async (input) => {
      story = input;
      return { content: JSON.stringify(MANUAL_JSON), usage: { cost: 0.0004, total_tokens: 120 } };
    },
  });
  assert.equal(story.manual, true);
  assert.equal(story.noSource, true);
  assert.ok(result.post);
  assert.equal(result.qa.pass, true);
  assert.equal(result.qa.problems.includes('ai_relevance'), false);
  assert.equal(result.qa.problems.includes('category_fresh'), false);
  assert.equal(result.qa.problems.includes('source'), false);
  assert.ok(result.qa.warnings.includes('ai_relevance'));
  assert.ok(result.qa.warnings.includes('category_fresh'));
  assert.equal(result.post.body.includes('منبع:'), false);
  assert.equal(result.post.body.includes('t.me'), false);
  assert.equal(result.post.source_url, 'https://t.me/example/1');
  assert.equal(result.reason, 'ok');
});

test('a manual rewrite with no stored source falls back to the saved draft', async () => {
  let story;
  const item = manualItem({
    messageText: '',
    post: { title: MANUAL_JSON.title, body: MANUAL_BODY, quote: 'نقل قول کوتاه' },
  });
  const result = await draftReviewPost({
    item,
    now: NOW,
    manual: true,
    request: async (input) => {
      story = input;
      return { content: JSON.stringify(MANUAL_JSON), usage: { cost: 0, total_tokens: 10 } };
    },
  });
  assert.ok(story, result.reason);
  assert.equal(story.article.content, `${MANUAL_BODY.trim()}\n\nنقل قول کوتاه`);
  assert.notEqual(result.reason, 'short');
  assert.ok(result.post, result.reason);
  const context = qaContextForItem(item, { category: 'tools' }, NOW, {}, '', { manual: true });
  assert.equal(context.content, `${MANUAL_BODY.trim()}\n\nنقل قول کوتاه`);
});

test('an automatic rewrite with no stored source still fails before the model', async () => {
  let called = false;
  const result = await draftReviewPost({
    item: manualItem({ messageText: '', post: { body: MANUAL_BODY, quote: '' } }),
    now: NOW,
    request: async () => {
      called = true;
    },
  });
  assert.equal(result.reason, 'short');
  assert.equal(called, false);
});

test('a manual offer without expiry or official source is rewritten with the no-expiry note', async () => {
  const note = 'بدون تاریخ انقضای اعلام‌شده';
  const result = await draftReviewPost({
    item: manualItem({ kind: 'offer', offerHint: true, expiry: null }),
    now: NOW,
    manual: true,
    config: {
      offers: {
        no_expiry_note: `${note}؛ پیش از اقدام، صفحهٔ رسمی را ببینید`,
        manual_no_expiry_note: note,
        min_remaining_hours: 24,
      },
    },
    request: async () => ({
      content: JSON.stringify(MANUAL_JSON),
      usage: { cost: 0, total_tokens: 10 },
    }),
  });
  assert.ok(result.post, result.reason);
  assert.equal(result.qa.pass, true);
  assert.ok(result.post.body.includes(note));
  assert.equal(result.post.body.includes('صفحهٔ رسمی'), false);
  assert.equal(result.post.body.includes('t.me'), false);
  assert.equal(result.post.body.includes('منبع:'), false);
  assert.equal(result.qa.problems.includes('offer_expiry'), false);
  assert.equal(result.reason, 'ok');
});

test('the same offer without expiry is still blocked when the rewrite is automatic', async () => {
  let called = false;
  const result = await draftReviewPost({
    item: manualItem({ kind: 'offer', offerHint: true, expiry: null }),
    now: NOW,
    request: async () => {
      called = true;
    },
  });
  assert.equal(result.reason, 'offer_context_missing');
  assert.equal(called, false);
});

test('the same post is still blocked when the rewrite is automatic', async () => {
  const result = await draftReviewPost({
    item: manualItem(),
    now: NOW,
    request: async () => ({
      content: JSON.stringify({ ...MANUAL_JSON, source_url: 'https://t.me/example/1' }),
      usage: { cost: 0, total_tokens: 10 },
    }),
  });
  assert.equal(result.reason, 'qa_failed');
  assert.ok(result.qa.problems.includes('ai_relevance'));
  assert.ok(result.qa.problems.includes('category_fresh'));
  assert.ok(result.qa.problems.includes('source'));
});

test('a manual rewrite keeps the stored tool link as the only tail', async () => {
  const repo = 'https://github.com/LottieFiles/motion-design-skill';
  let story;
  const result = await draftReviewPost({
    item: baseItem({
      url: repo,
      sourceName: 'Code.Cloud | کد کلاد',
      sourceType: 'telegram_channel',
      relatedLinks: [repo],
    }),
    now: NOW,
    manual: true,
    request: async (input) => {
      story = input;
      return {
        content: JSON.stringify({
          ...JSON.parse(PUBLISH_JSON),
          category: 'tools',
          title: 'مهارت طراحی موشن برای هوش مصنوعی',
          source_url: repo,
        }),
        usage: { cost: 0, total_tokens: 10 },
      };
    },
  });
  assert.equal(story.manual, true);
  assert.equal(story.noSource, false);
  assert.ok(result.post);
  assert.ok(
    result.post.body.endsWith(`لینک استفاده: [LottieFiles/motion-design-skill](${repo})`),
    result.post.body
  );
  assert.equal(result.post.body.includes('Code.Cloud'), false);
  assert.equal(result.post.body.includes('منبع:'), false);
  assert.equal(result.qa.problems.includes('source'), false);
});

test('the manual writer prompt overrides skip rules and forbids a Telegram citation', () => {
  const prompt = buildUserMessage({
    item: { title: 'تقویم آنلاین تازه', published: '2026-10-01T00:00:00Z' },
    article: {
      title: 'تقویم آنلاین تازه',
      published: '2026-10-01T00:00:00Z',
      content: MANUAL_SOURCE,
      imageAlt: '',
    },
    url: 'https://t.me/example/1',
    now: NOW,
    imageUrl: '',
    manual: true,
    noSource: true,
  });
  assert.match(prompt, /بازنویسی دستی/);
  assert.match(prompt, /رد نکن/);
  assert.match(prompt, /تلگرام/);
  assert.match(prompt, /هیچ خط منبع/);
  assert.match(prompt, /لینک داخلی/);
  assert.match(prompt, /نبود اشارهٔ صریح/);
  assert.ok(prompt.includes('نام منبع: داخلی (در متن نیاور)'));
  assert.match(prompt, /تبلیغ\/رپورتاژ/);
});

test('a manual offer without a link keeps the no-expiry note but drops the source-tail instruction', () => {
  const prompt = buildUserMessage({
    item: { title: 'آفر دستی', published: '2026-10-01T00:00:00Z' },
    article: {
      title: 'آفر دستی',
      published: '2026-10-01T00:00:00Z',
      content: MANUAL_SOURCE,
      imageAlt: '',
    },
    url: 'https://t.me/example/1',
    now: NOW,
    imageUrl: '',
    offer: { openEnded: true, note: 'بدون تاریخ انقضای اعلام‌شده' },
    manual: true,
    noSource: true,
  });
  assert.ok(prompt.includes('بدون تاریخ انقضای اعلام‌شده'));
  assert.equal(prompt.includes('پیش از خط منبع'), false);
  assert.equal(prompt.includes('صفحه رسمی فروشنده'), false);
});

test('the system prompt scopes automatic skips so manual mode is not contradictory', async () => {
  const prompt = await readFile(resolve(ROOT, 'bench', 'system-prompt.md'), 'utf8');
  for (const line of [
    '## ۰.۱) حالت بازنویسی دستی',
    'در حالت بازنویسی دستی فقط ورودی خالی، بند ۴ (تبلیغ/رپورتاژ) و بند ۵ (تکرار) اعمال می‌شوند',
    'در حالت بازنویسی دستی ارزش واقعی را بین ۱ تا ۵ بگذار و برای رسیدن به حداقل، عدد را بالا نبر',
    'در حالت خودکار خبر قدیمی‌تر را skip کن',
    'unverified در حالت خودکار به‌طور پیش‌فرض skip',
    'در حالت دستی، خط پایانی مطابق بخش ۰.۱ است',
    'اگر آفر دستی تاریخ انقضای اعلام‌شده ندارد',
    'تنها استثنا خط «بدون تاریخ انقضای اعلام‌شده»',
    'اگر در حالت خودکار شک داشتی',
    'در حالت دستی فقط تبلیغ/رپورتاژ یا تکرار را skip کرده‌ای',
  ]) {
    assert.ok(prompt.includes(line), line);
  }
});
