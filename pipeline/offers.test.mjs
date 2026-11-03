import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assessOffer,
  dateMentioned,
  detectOffer,
  extractExpiry,
  offerUsage,
  reviewText,
} from './offers.mjs';
import { qaPost } from './engine.mjs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const NOW = '2026-11-02T17:00:00Z';

const offerArticle = {
  title: 'Get 100 free credits for the new API',
  content: 'The new developer program includes 100 free credits. This offer is valid until December 31, 2026.',
};

const validBody = [
  'شرکت اوپن‌ای‌آی اعلام کرد که دسترسی به اعتبار رایگان این سرویس برای توسعه‌دهندگان تازه آغاز شده است.',
  '',
  '- هر حساب تازه صد دلار اعتبار رایگان دریافت می‌کند',
  '- این اعتبار برای فراخوانی مدل و ابزارهای صوتی قابل استفاده است',
  '- امکان انتقال اعتبار به حساب دیگر وجود ندارد',
  '',
  'این آفر تا ۳۱ دسامبر ۲۰۲۶ معتبر است و پس از آن اعتبار باقی‌مانده سوخت می‌شود.',
  '',
  'این موضوع از اونجایی مهمه که این آفر هزینه شروع کار برای تیم‌های کوچک را کاهش می‌دهد و رقابت میان سرویس‌دهندگان را جدی‌تر می‌کند.',
  '',
  'منبع: [OpenAI](https://openai.com/news/test-offer)',
].join('\n');

function post(overrides = {}) {
  return {
    decision: 'publish',
    title: 'اعتبار رایگان صددلاری برای توسعه‌دهندگان',
    body: validBody,
    post_type: 'standard',
    importance: 3,
    verification: 'official',
    category: 'tools',
    source_url: 'https://openai.com/news/test-offer',
    image_url: '',
    key_facts: ['صد دلار اعتبار رایگان', 'اعتبار تا پایان دسامبر'],
    entities: { companies: ['OpenAI'], models: [] },
    dedupe_key: 'openai-free-credits',
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    url: 'https://openai.com/news/test-offer',
    host: 'openai.com',
    sourceType: 'official_blog',
    category: 'tools',
    imageUrl: '',
    title: offerArticle.title,
    description: offerArticle.content,
    content: offerArticle.content,
    publishedAt: '2026-11-02T15:00:00Z',
    now: NOW,
    offer: {
      detected: true,
      expiry: { date: '2026-12-31', year: 2026, month: 12, day: 31, remainingHours: 1419.5 },
      remainingHours: 1419.5,
      minRemainingHours: 24,
    },
    ...overrides,
  };
}

const quota = { tools: { quota: 17, used: 0, remaining: 17 } };

test('offer detection needs a strong term and avoids passing mentions', () => {
  assert.equal(detectOffer(offerArticle).isOffer, true);
  assert.equal(detectOffer({ title: 'A new model with better reasoning', content: 'The launch improves math scores.' }).isOffer, false);
  assert.equal(detectOffer({ title: 'Pricing update', content: 'The free tier exists.' }).isOffer, false);
  assert.equal(
    detectOffer({ title: 'Pricing update', content: 'The free tier exists. The offer is valid until December 31, 2026.' }).isOffer,
    true
  );
});

test('expiry parser reads explicit dates in several formats', () => {
  assert.equal(extractExpiry('Offer valid until December 31, 2026.', NOW).date, '2026-12-31');
  assert.equal(extractExpiry('Valid through 2026-12-15.', NOW).date, '2026-12-15');
  assert.equal(extractExpiry('Ends 12/31/2026.', NOW).date, '2026-12-31');
  assert.equal(extractExpiry('Ends 31/12/2026.', NOW).date, '2026-12-31');
  assert.equal(extractExpiry('Valid until December 31.', NOW).date, '2026-12-31');
  assert.equal(extractExpiry('Valid until January 5.', NOW).date, '2027-01-05');
});

test('a missing or ambiguous expiry is never accepted', () => {
  const missing = extractExpiry('Free credits available while supplies last.', NOW);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'expiry_missing');

  const ambiguous = extractExpiry('Free credits. Ends 05/06/2026.', NOW);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'expiry_ambiguous');

  const expired = extractExpiry('Free credits. Expires 2026-01-01.', NOW);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expiry_expired');
});

test('an offer from a news source goes to review, not the main channel', () => {
  const offer = detectOffer(offerArticle);
  const result = assessOffer({
    offer: { ...offer, ...offerArticle },
    sourceType: 'news',
    publishedAt: '2026-11-02T15:00:00Z',
    now: NOW,
    config,
    quota,
    usage: { today: 0, week: 0 },
  });
  assert.equal(result.status, 'review');
  assert.equal(result.reason, 'source_not_official');
  assert.equal(result.expiry.date, '2026-12-31');
});

test('only an official source with a clear future expiry is publishable', () => {
  const offer = detectOffer(offerArticle);
  const result = assessOffer({
    offer: { ...offer, ...offerArticle },
    sourceType: 'official_blog',
    publishedAt: '2026-11-02T15:00:00Z',
    now: NOW,
    config,
    quota,
    usage: { today: 0, week: 0 },
  });
  assert.equal(result.status, 'publish');
  assert.equal(result.reason, 'ok');
  assert.equal(result.expiry.remainingHours, 1419.5);
});

test('expiry inside the minimum window asks for review', () => {
  const offer = detectOffer({ title: offerArticle.title, content: 'Free credits. Valid until December 31, 2026.' });
  const result = assessOffer({
    offer: { ...offer, title: offerArticle.title, content: 'Free credits. Valid until December 31, 2026.' },
    sourceType: 'official_blog',
    publishedAt: '2026-12-30T20:00:00Z',
    now: '2026-12-31T00:00:00Z',
    config,
    quota,
    usage: { today: 0, week: 0 },
  });
  assert.equal(result.status, 'review');
  assert.equal(result.reason, 'expiry_soon');
});

test('daily and weekly offer caps stop publication', () => {
  const offer = detectOffer(offerArticle);
  const base = {
    offer: { ...offer, ...offerArticle },
    sourceType: 'official_blog',
    publishedAt: '2026-11-02T15:00:00Z',
    now: NOW,
    config,
    quota,
  };
  assert.equal(assessOffer({ ...base, usage: { today: 1, week: 1 } }).reason, 'offer_daily_cap');
  assert.equal(assessOffer({ ...base, usage: { today: 0, week: 3 } }).reason, 'offer_weekly_cap');
});

test('a stale or expired offer is skipped instead of reviewed', () => {
  const offer = detectOffer(offerArticle);
  const base = {
    offer: { ...offer, ...offerArticle },
    sourceType: 'official_blog',
    quota,
    usage: { today: 0, week: 0 },
    config,
  };
  assert.equal(
    assessOffer({ ...base, publishedAt: '2026-10-31T00:00:00Z', now: NOW }).reason,
    'offer_stale'
  );
  assert.equal(
    assessOffer({ ...base, publishedAt: '2027-01-01T01:00:00Z', now: '2027-01-02T00:00:00Z' }).reason,
    'offer_expired'
  );
});

test('offer QA requires a tools category, expiry in the body and no referral', () => {
  const good = qaPost(post(), context());
  assert.equal(good.pass, true);
  for (const name of ['offer_category', 'offer_source', 'offer_expiry', 'offer_remaining', 'offer_referral']) {
    assert.ok(good.checks.some((check) => check.name === name && check.ok), `${name} did not pass`);
  }

  const noExpiry = qaPost(
    post({ body: validBody.replace('این آفر تا ۳۱ دسامبر ۲۰۲۶ معتبر است و پس از آن اعتبار باقی‌مانده سوخت می‌شود.', 'این آفر برای مدت محدود در دسترس است.') }),
    context()
  );
  assert.equal(noExpiry.pass, false);
  assert.ok(noExpiry.problems.includes('offer_expiry'));

  const wrongCategory = qaPost(post({ category: 'business' }), context());
  assert.ok(wrongCategory.problems.includes('offer_category'));

  const referral = qaPost(post({ body: validBody.replace('منبع:', 'affiliate link\n\nمنبع:') }), context());
  assert.ok(referral.problems.includes('offer_referral'));
});

test('date mention accepts Persian digits and month names', () => {
  const expiry = { date: '2026-12-31', year: 2026, month: 12, day: 31 };
  assert.equal(dateMentioned('این آفر تا ۳۱ دسامبر ۲۰۲۶ معتبر است.', expiry), true);
  assert.equal(dateMentioned('This offer is valid until 31 December 2026.', expiry), true);
  assert.equal(dateMentioned('این آفر تا پایان دسامبر معتبر است.', expiry), false);
});

test('offer usage counts only offer posts in the current day and week', () => {
  const state = {
    published: [
      { slot: '2026-11-02T08:30+03:30', week: '2026-10-31', kind: 'offer' },
      { slot: '2026-11-02T11:30+03:30', week: '2026-10-31', kind: 'news' },
      { slot: '2026-11-01T20:30+03:30', week: '2026-10-31', kind: 'offer' },
      { slot: '2026-10-25T20:30+03:30', week: '2026-10-24', kind: 'offer' },
    ],
  };
  assert.deepEqual(offerUsage(state, NOW), { today: 1, week: 2 });
});

test('review text names the reason and links the original source', () => {
  const text = reviewText({
    article: { title: 'Free credits', url: 'https://example.com/a', published: '2026-11-02T15:00:00Z' },
    candidate: { title: 'Free credits', sourceName: 'Example', published: '2026-11-02T15:00:00Z' },
    assessment: { reason: 'expiry_missing', expiry: { ok: false, reason: 'expiry_missing' } },
    offer: { isOffer: true },
  });
  assert.match(text, /تاریخ انقضا: روشن نیست/);
  assert.match(text, /https:\/\/example\.com\/a/);
  assert.match(text, /کانال اصلی/);
});
