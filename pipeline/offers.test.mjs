import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assessOffer,
  dateMentioned,
  detectOffer,
  extractExpiry,
  offerUsage,
  openEndedKey,
  openEndedUsage,
  recordOpenEnded,
  markOpenEndedEnded,
  offerReviewUsage,
  recordOfferReview,
  reviewCapacity,
  ensureReviewBanner,
  refreshQueuedReviewText,
  REVIEW_BANNER,
  REASON_FA,
  enqueueReviewPending,
  listReviewPending,
  removeReviewPending,
  resolveVendorLink,
  reviewSummary,
  reviewText,
  reviewHtml,
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

test('free inference and no-bank-card offers are detected', () => {
  assert.equal(
    detectOffer({ title: 'Free inference with leading models', content: 'Use Inference Endpoints' }).isOffer,
    true
  );
  assert.equal(
    detectOffer({ title: 'Free access to three models', content: 'No bank card required.' }).isOffer,
    true
  );
  assert.equal(
    detectOffer({ title: 'دسترسی رایگان به سه مدل', content: 'بدون نیاز به کارت بانکی ثبت‌نام کنید.' }).isOffer,
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

test('an official offer without an expiry publishes in the open-ended tier', () => {
  const content = 'Get 100 free credits for the new API. No bank card needed.';
  const offer = detectOffer({ title: 'Free credits for the API', content });
  const result = assessOffer({
    offer: { ...offer, title: 'Free credits for the API', content },
    sourceType: 'telegram_channel',
    officialResolved: true,
    vendorKey: 'nvidia-build',
    publishedAt: '2026-11-02T15:00:00Z',
    now: NOW,
    config,
    quota,
    usage: { today: 0, week: 0 },
  });
  assert.equal(result.status, 'publish');
  assert.equal(result.reason, 'ok_no_expiry');
  assert.equal(result.openEnded, true);
});

test('an open-ended offer from the same vendor waits out the repeat window', () => {
  const content = 'Get 100 free credits for the new API. No bank card needed.';
  const offer = detectOffer({ title: 'Free credits for the API', content });
  const result = assessOffer({
    offer: { ...offer, title: 'Free credits for the API', content },
    sourceType: 'official_blog',
    vendorKey: 'nvidia-build',
    openEnded: { status: 'active', within: true, entry: { publishedAt: '2026-11-01T00:00:00Z' } },
    publishedAt: '2026-11-02T15:00:00Z',
    now: NOW,
    config,
    quota,
    usage: { today: 0, week: 0 },
  });
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'offer_vendor_repeat');
});

test('an unidentified official page still sends a no-expiry offer to review', () => {
  const content = 'Get 100 free credits for the new API. No bank card needed.';
  const offer = detectOffer({ title: 'Free credits for the API', content });
  const result = assessOffer({
    offer: { ...offer, title: 'Free credits for the API', content },
    sourceType: 'official_blog',
    vendorKey: '',
    publishedAt: '2026-11-02T15:00:00Z',
    now: NOW,
    config,
    quota,
    usage: { today: 0, week: 0 },
  });
  assert.equal(result.status, 'review');
  assert.equal(result.reason, 'expiry_missing');
});

test('open-ended tracking remembers the vendor and stops after the window', () => {
  const state = { openOffers: {} };
  const entry = recordOpenEnded(state, {
    key: 'nvidia-build',
    vendor: 'NVIDIA Build',
    url: 'https://build.nvidia.com/',
    title: 'دسترسی رایگان به سه مدل',
    at: '2026-11-07T12:00:00Z',
  });
  assert.equal(entry.status, 'active');
  assert.equal(entry.firstSeen, '2026-11-07T12:00:00.000Z');
  assert.equal(openEndedUsage(state, { key: 'nvidia-build', now: '2026-11-10T12:00:00Z', days: 14 }).within, true);
  assert.equal(openEndedUsage(state, { key: 'nvidia-build', now: '2026-11-30T12:00:00Z', days: 14 }).within, false);
  markOpenEndedEnded(state, 'nvidia-build', '2026-11-08T12:00:00Z');
  assert.equal(state.openOffers['nvidia-build'].status, 'ended');
  assert.equal(state.openOffers['nvidia-build'].endedAt, '2026-11-08T12:00:00.000Z');
  assert.equal(openEndedKey({ vendor: 'NVIDIA-Build' }), 'nvidia-build');
  assert.equal(openEndedKey({ host: 'www.build.nvidia.com' }), 'build.nvidia.com');
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

test('research paper reviews carry their own Persian reason and abstract', () => {
  const text = reviewText({
    candidate: {
      title: 'Think Less, Locally',
      sourceName: 'Hugging Face Daily Papers',
      link: 'https://huggingface.co/papers/2611.00001',
      messageText: 'short abstract about reasoning compression',
    },
    assessment: { reason: 'research_paper' },
  });
  assert.match(text, /دلیل بازبینی: مقاله پژوهشی منتخب/);
  assert.match(text, /short abstract about reasoning compression/);
  assert.match(text, /این چیه؟/);
});

test('a linkless offer resolves the registered official page from its vendor name', () => {
  const vendors = [
    { id: 'nvidia-build', name: 'NVIDIA Build', aliases: ['انویدیا', 'nvidia'], url: 'https://build.nvidia.com/' },
    { id: 'other', name: 'Other', aliases: ['otherlab'], url: 'https://other.example.com/' },
  ];
  const text = 'انویدیا دسترسی رایگان به ۳ مدل هوش مصنوعی را فراهم کرده. بدون نیاز به کارت بانکی.';
  assert.deepEqual(resolveVendorLink(text, vendors), {
    vendor: 'nvidia-build',
    name: 'NVIDIA Build',
    url: 'https://build.nvidia.com/',
  });
  assert.equal(resolveVendorLink('یک سرویس ناشناس دسترسی رایگان داده', vendors), null);
  assert.equal(
    resolveVendorLink('acme offer', [
      { id: 'a', name: 'A', aliases: ['acme'], url: 'https://a.example.com/' },
      { id: 'b', name: 'B', aliases: ['acme'], url: 'https://b.example.com/' },
    ]),
    null
  );
});

test('a missing link review starts with the review banner', () => {
  const text = reviewText({
    candidate: { title: 'Free credits', sourceName: 'Telegram', link: 'https://t.me/example/1' },
    assessment: { reason: 'link_missing' },
    kind: 'offer',
    mainEligible: false,
  });
  const lines = text.split('\n');
  assert.equal(lines[0], REVIEW_BANNER);
  assert.match(text, /لینک معتبر برای این آفر پیدا نشد/);
  assert.match(text, /منبع رسمی شرکت یا صفحهٔ اصلی محصول را پیدا کن/);
  assert.match(text, /چی را چک کنی/);
});

test('review usage counts every state once and tracks the source channel', () => {
  const main = { offerReviews: [] };
  const review = { offerReviews: [] };
  recordOfferReview(main, { source: 'tg-a', title: 'آفر', url: 'https://example.com/a', at: NOW });
  recordOfferReview(main, { source: 'tg-b', title: 'ابزار', url: 'https://example.com/b', at: NOW, kind: 'tool' });
  recordOfferReview(review, { source: 'tg-a', title: 'آفر', url: 'https://example.com/a', at: NOW });
  recordOfferReview(main, { source: 'tg-c', title: 'قدیمی', url: 'https://example.com/c', at: '2026-11-01T15:00:00Z' });

  const usage = offerReviewUsage([main, review], NOW);
  assert.equal(usage.today, 2);
  assert.equal(usage.perSource.get('tg-a'), 1);
  assert.equal(usage.perSource.get('tg-b'), 1);
});

test('the review channel is uncapped by default but still honours an explicit cap', () => {
  const usage = { today: 0, perSource: new Map() };
  assert.equal(reviewCapacity({ config, usage, sourceKey: 'tg-a' }).ok, true);

  const heavy = { today: 500, perSource: new Map([['tg-a', 500]]) };
  assert.deepEqual(reviewCapacity({ config, usage: heavy, sourceKey: 'tg-a' }), { ok: true, reason: 'ok' });

  const capped = {
    ...config,
    offers: {
      ...config.offers,
      review: { ...config.offers.review, max_per_day: 24, max_per_source_per_day: 3 },
    },
  };
  const sourceFull = { today: 3, perSource: new Map([['tg-a', 3]]) };
  assert.deepEqual(reviewCapacity({ config: capped, usage: sourceFull, sourceKey: 'tg-a' }), {
    ok: false,
    reason: 'review_source_cap',
  });
  assert.equal(reviewCapacity({ config: capped, usage: sourceFull, sourceKey: 'tg-b' }).ok, true);
  const dayFull = { today: 24, perSource: new Map() };
  assert.deepEqual(reviewCapacity({ config: capped, usage: dayFull, sourceKey: 'tg-b' }), {
    ok: false,
    reason: 'review_daily_cap',
  });
  assert.deepEqual(reviewCapacity({ config: capped, usage: dayFull }), { ok: false, reason: 'review_daily_cap' });
});

test('a full review queue defers the offer instead of skipping it', () => {
  const noExpiry = {
    title: offerArticle.title,
    content: 'Free credits for developers. Available while supplies last.',
  };
  const offer = detectOffer(noExpiry);
  const capped = {
    ...config,
    offers: {
      ...config.offers,
      review: { ...config.offers.review, max_per_day: 24, max_per_source_per_day: 3 },
    },
  };
  const base = {
    offer: { ...offer, ...noExpiry },
    sourceType: 'official_blog',
    sourceUrl: 'https://openai.com/news/test-offer',
    sourceKey: 'openai-news',
    publishedAt: '2026-11-02T15:00:00Z',
    now: NOW,
    config: capped,
    quota,
    usage: { today: 0, week: 0 },
  };
  const daily = assessOffer({ ...base, reviewUsage: { today: 24, perSource: new Map() } });
  assert.equal(daily.status, 'defer');
  assert.equal(daily.reason, 'expiry_missing');
  assert.equal(daily.cap, 'review_daily_cap');

  const source = assessOffer({
    ...base,
    reviewUsage: { today: 3, perSource: new Map([['openai-news', 3]]) },
  });
  assert.equal(source.status, 'defer');
  assert.equal(source.reason, 'expiry_missing');
  assert.equal(source.cap, 'review_source_cap');
});

test('the pending review queue keeps overflow and drops it only after the ttl', () => {
  const state = { reviewPending: {} };
  const entry = enqueueReviewPending(state, {
    source: 'tg-a',
    sourceName: 'کانال',
    title: 'آفر',
    url: 'https://example.com/a',
    reason: 'review_source_cap',
    kind: 'offer',
    at: '2026-11-02T17:00:00Z',
    text: 'متن بازبینی',
  });
  assert.ok(entry);
  assert.equal(listReviewPending(state, '2026-11-03T17:00:00Z').length, 1);
  assert.equal(listReviewPending(state, '2026-11-12T17:00:00Z').length, 1);
  assert.equal(listReviewPending(state, '2026-11-13T17:00:00Z').length, 0);

  const expiring = enqueueReviewPending(state, {
    source: 'tg-b',
    title: 'آفر دوم',
    url: 'https://example.com/b',
    kind: 'offer',
    at: '2026-11-02T17:00:00Z',
    expiry: { date: '2026-11-03' },
    text: 'متن دوم',
  });
  assert.equal(listReviewPending(state, '2026-11-05T17:00:00Z').some((item) => item.id === expiring.id), false);
  assert.equal(removeReviewPending(state, entry.id), 1);
  assert.equal(state.reviewPending[entry.id], undefined);
});

test('a tool review text marks main eligibility and carries the prepared post', () => {
  const text = reviewText({
    candidate: {
      title: 'ابزار تازه',
      sourceName: 'کانال تست',
      link: 'https://example.com/tool',
      leadPostUrl: 'https://t.me/testchannel/10',
      toolHint: true,
    },
    assessment: { reason: 'tool_incomplete' },
    kind: 'tool',
    mainEligible: true,
    text: 'متن اصلی کانال',
    post: { title: 'تیتر آماده', news_date: '۲ نوامبر ۲۰۲۶', body: 'بدنه آماده', quote: 'نقل‌قول' },
  });
  assert.match(text, /این پست آمادهٔ انتشاره/);
  assert.match(text, /تیتر آماده/);
  assert.doesNotMatch(text, /متن اصلی کانال/);
  assert.match(text, /https:\/\/t\.me\/testchannel\/10/);
  assert.match(text, /چک‌لیست قبل از ارسال/);
  assert.match(text, /این پیام فقط برای بازبینی است/);
});

test('a qa-failed review copy is labelled as a draft that still needs fixing', () => {
  const text = reviewText({
    candidate: { title: 'خبر', sourceName: 'کانال تست', link: 'https://example.com/post' },
    assessment: { reason: 'qa_failed' },
    reason: 'qa_failed',
    mainEligible: false,
    post: { title: 'تیتر نیمه‌کاره', body: 'بدنهٔ پست' },
  });
  assert.match(text, /بررسی کیفیت پاس نشد/);
  assert.match(text, /این نسخه پیش‌نویس است/);
  assert.match(text, /عنوان: تیتر نیمه‌کاره/);
  assert.doesNotMatch(text, /این پست آمادهٔ انتشاره/);
});

test('every review message starts with the siren banner and puts the prepared post first', () => {
  const text = reviewText({
    candidate: {
      title: 'Free credits',
      sourceName: 'Example',
      link: 'https://example.com/a',
      toolHint: true,
    },
    assessment: { reason: 'tool_incomplete' },
    kind: 'tool',
    mainEligible: true,
    text: 'The company announced free credits for every developer account today, and the program will continue while supplies last, according to the official page.',
    post: { title: 'تیتر آماده', body: 'بدنه آماده', quote: 'نقل‌قول' },
  });
  assert.ok(text.startsWith(REVIEW_BANNER));
  assert.match(text, /این پست آمادهٔ انتشاره/);
  assert.ok(text.indexOf('تیتر آماده') < text.indexOf('لینک منبع:'));
  assert.doesNotMatch(text, /The company announced/);
});

test('a review without a prepared post explains that it must be translated and completed', () => {
  const text = reviewText({
    candidate: { title: 'Free credits', sourceName: 'Feed', link: 'https://example.com/a' },
    assessment: { reason: 'no_link' },
    mainEligible: true,
    text: 'The company announced free credits for every developer account today, and the program will continue while supplies last.',
  });
  assert.ok(text.startsWith(REVIEW_BANNER));
  assert.match(text, /این چیه؟/);
  assert.match(text, /The company announced/);
  assert.match(text, /چی را چک کنی/);
});

test('a ready-to-publish review keeps only the post, source and a short checklist', () => {
  const text = reviewText({
    candidate: {
      title: 'بایت‌دنس مدل تصویرساز تازه‌اش را معرفی کرد',
      sourceName: 'کانال تست',
      link: 'https://t.me/testchannel/20',
      rumorHint: false,
      relatedLinks: ['https://instagram.com/example'],
    },
    assessment: { reason: 'denied_link' },
    kind: 'post',
    mainEligible: true,
    post: {
      title: 'بایت‌دنس مدل تصویرساز Seedream 5.5 را معرفی کرد',
      news_date: '۱۹ آبان ۱۴۰۵',
      body: 'متن پست آماده.\n\nمنبع: کانال تست (https://t.me/testchannel/20)',
      quote: 'نقل‌قول کوتاه',
    },
    text: 'متن خام کانال با تبلیغ و امضا که نباید در پیام بازبینی بیاید.',
  });
  assert.match(text, /این پست آمادهٔ انتشاره/);
  assert.match(text, /عنوان: بایت‌دنس مدل تصویرساز/);
  assert.match(text, /لینک منبع: https:\/\/t\.me\/testchannel\/20/);
  assert.doesNotMatch(text, /متن خام کانال/);
  assert.match(text, /چک‌لیست قبل از ارسال/);
  assert.match(text, /لینک‌های داخل پست منبع/);
  assert.ok((text.match(/^• /gm) ?? []).length <= 5);
});

test('reviewSummary removes links and handles and stays short', () => {
  const summary = reviewSummary(
    'خط اول دربارهٔ مدل تازه. https://example.com/x @channel\nخط دوم دربارهٔ تاریخ انتشار!\nخط سوم. خط چهارم. خط پنجم. خط ششم.',
    { maxChars: 110, maxSentences: 3 }
  );
  assert.doesNotMatch(summary, /https?:|@channel/);
  assert.ok(summary.length <= 111);
  assert.match(summary, /خط اول/);
  assert.doesNotMatch(summary, /خط ششم/);
});

test('every configured review reason has a Persian label', () => {
  for (const reason of config.offers.review.reasons) {
    assert.ok(REASON_FA[reason], `missing reason label: ${reason}`);
  }
});

test('a queued review from the old format gets the banner and a Persian reason before sending', () => {
  const old = 'بازبینی پست — denied_link\n\nعنوان: تست\nدلیل بازبینی: denied_link';
  const refreshed = refreshQueuedReviewText(old, 'denied_link');
  assert.ok(refreshed.startsWith(REVIEW_BANNER));
  assert.match(refreshed, /بازبینی پست — لینک خارجی این پست پذیرفته نشد/);
  assert.match(refreshed, /دلیل بازبینی: لینک خارجی این پست پذیرفته نشد/);
  assert.doesNotMatch(refreshed, /denied_link/);
  assert.equal(ensureReviewBanner(`${REVIEW_BANNER}\n\nمتن`), `${REVIEW_BANNER}\n\nمتن`);
});

test('a failed main send keeps the prepared offer in review', () => {
  const text = reviewText({
    candidate: {
      title: 'آفر رایگان',
      sourceName: 'منبع رسمی',
      link: 'https://example.com/offer',
      offerHint: true,
    },
    assessment: { reason: 'send_failed' },
    kind: 'offer',
    mainEligible: true,
    post: { title: 'تیتر آفر', body: 'بدنه آفر' },
    note: 'ارسال به کانال اصلی ناموفق بود؛ پست آماده برای بازبینی نگه داشته شد.',
  });
  assert.match(text, /این پست آمادهٔ انتشاره/);
  assert.match(text, /ارسال به کانال اصلی ناموفق بود/);
  assert.match(text, /تاریخ انقضا و شرایط آفر/);
  assert.match(text, /عنوان: تیتر آفر/);
  assert.match(text, /تیتر آفر/);
});

test('the ready review html keeps the post formatted and escapes the source', () => {
  const html = reviewHtml({
    candidate: {
      title: 'تیتر اصلی',
      sourceName: 'منبع & تست',
      link: 'https://example.com/x?a=1&b=2',
      relatedLinks: [],
    },
    assessment: { reason: 'denied_link' },
    kind: 'post',
    mainEligible: true,
    post: {
      title: 'تیتر اصلی',
      body: 'متن خبر.\n\nمنبع: [example](https://example.com/x?a=1&b=2)',
      quote: 'یک نقل‌قول.',
      news_date: '📅 تاریخ خبر: دوشنبه ۱۸ آبان ۱۴۰۵',
    },
    note: 'فقط لینک را چک کن.',
  });
  assert.ok(html.startsWith(REVIEW_BANNER));
  assert.match(html, /این پست آمادهٔ انتشاره/);
  assert.match(html, /<b>\u200F?تیتر اصلی<\/b>/);
  assert.match(html, /<a href="https:\/\/example\.com\/x\?a=1&amp;b=2">example<\/a>/);
  assert.match(html, /<blockquote expandable>\u200F?یک نقل‌قول\.<\/blockquote>/);
  assert.match(html, /منبع: منبع &amp; تست/);
  assert.match(html, /لینک منبع: https:\/\/example\.com\/x\?a=1&amp;b=2/);
  assert.match(html, /چک‌لیست قبل از ارسال:/);
  assert.doesNotMatch(html, /\]\(https/);
  assert.equal(reviewHtml({ candidate: {}, post: null }), '');
});
