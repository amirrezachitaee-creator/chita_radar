import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAiMention, isAiCentral } from './relevance.mjs';
import { qaPost } from './engine.mjs';

const ukraineTitle = 'Ukraine’s new pocket-sized gadget turns Russian drones’ cameras against them';
const ukraineSummary = 'A Kyiv startup’s pocket-sized, 10-ounce receiver lets Ukrainian troops watch the video feeds of Russian drones, though Russian moves toward digital video and AI-guided drones that emit no signals could make the victory short-lived.';

test('a passing AI phrase in a general tech story is not central', () => {
  assert.equal(isAiCentral(ukraineTitle, ukraineSummary), false);
});

test('an AI company or AI phrase in the title is central', () => {
  assert.equal(
    isAiCentral('Omen AI adds liquid know-how in $16 million Aquatic Labs acquisition', 'The startup sells liquid-cooling sensors.'),
    true
  );
  assert.equal(isAiCentral('Y Combinator’s Garry Tan uses AI agents so much, he spends up to $200K a year on tokens', ''), true);
});

test('two AI-adjacent terms in the summary can make a story central', () => {
  assert.equal(
    isAiCentral(
      'New York Times and other outlets sue web browser Brave over alleged content scraping',
      'The New York Times is suing Brave for scraping content and distributing it to customers like Anthropic and Perplexity.'
    ),
    true
  );
});

test('one hardware term is not enough', () => {
  assert.equal(
    isAiCentral('Apple’s inventory surges 154% as memory chip costs climb', 'Apple says unprecedented memory chip costs will continue to rise.'),
    false
  );
  assert.equal(
    isAiCentral('In one of the largest deals in tech history, Marvell buys Lumentum for $115B', 'Both companies have the same strategic investor: Nvidia.'),
    false
  );
});

test('the final Ukraine post has no AI mention', () => {
  const post = [
    'دستگاه جیبی اوکراینی دوربین پهپادهای روسی را لو می‌دهد',
    '',
    'گروه‌های پهپادی اوکراین راه تازه‌ای برای جاسوسی از پهپادهای جاسوس روسی پیدا کرده‌اند. این پهپادها ویدیو را بدون رمزنگاری می‌فرستند.',
    '',
    'منبع: [TechCrunch](https://techcrunch.com/example)',
  ].join('\n');
  assert.equal(hasAiMention(post), false);
});

test('an Omen AI post and an OpenAI offer post both pass the mention check', () => {
  const omen = [
    'Omen AI با خرید Aquatic Labs به سراغ خنک‌کننده دیتاسنترها رفت',
    '',
    'این خرید فناوری دو سنسور را ترکیب می‌کند تا تصویر کامل‌تری از وضعیت آب به دست دهد.',
  ].join('\n');
  assert.equal(hasAiMention(omen), true);

  const offer = [
    'اعتبار رایگان صددلاری برای توسعه‌دهندگان',
    '',
    'شرکت اوپن‌ای‌آی اعلام کرد که دسترسی به اعتبار رایگان این سرویس برای توسعه‌دهندگان تازه آغاز شده است.',
  ].join('\n');
  assert.equal(hasAiMention(offer), true);
});

const basePost = {
  decision: 'publish',
  category: 'tools',
  post_type: 'standard',
  importance: 3,
  quote: '',
  key_facts: ['یک', 'دو'],
  numbers: [],
  entities: { companies: [], models: [] },
  verification: 'reported',
  source_url: 'https://example.com',
  image_url: '',
  dedupe_key: 'relevance-test',
};

const context = {
  url: 'https://example.com',
  host: 'example.com',
  sourceType: 'news',
  imageUrl: '',
  title: 'خبر',
  description: '',
  content: '',
  publishedAt: '2026-11-02T15:00:00Z',
  now: '2026-11-02T17:00:00Z',
};

test('QA adds a hard ai_relevance check', () => {
  const unrelated = qaPost({
    ...basePost,
    title: 'دستگاه جیبی اوکراینی دوربین پهپادهای روسی را لو می‌دهد',
    body: 'گروه‌های پهپادی اوکراین راه تازه‌ای پیدا کرده‌اند.\n\nاهمیتش اینه که این دستگاه مسیر پهپادها را نشان می‌دهد.\n\nمنبع: [TechCrunch](https://example.com)',
  }, context);
  const unrelatedCheck = unrelated.checks.find((check) => check.name === 'ai_relevance');
  assert.equal(unrelatedCheck.ok, false);
  assert.equal(unrelatedCheck.hard, true);
  assert.ok(unrelated.problems.includes('ai_relevance'));

  const related = qaPost({
    ...basePost,
    title: 'Omen AI با خرید Aquatic Labs به سراغ خنک‌کننده دیتاسنترها رفت',
    body: 'این خرید فناوری دو سنسور را ترکیب می‌کند.\n\nاهمیتش اینه که دیتاسنترها آب را طولانی‌تر استفاده می‌کنند.\n\nمنبع: [TechCrunch](https://example.com)',
  }, context);
  const relatedCheck = related.checks.find((check) => check.name === 'ai_relevance');
  assert.equal(relatedCheck.ok, true);
});
