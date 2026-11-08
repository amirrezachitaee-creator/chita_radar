import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveDate,
  effectiveDateLine,
  effectiveDateParts,
  mentionsEffectiveDate,
  newsDate,
  newsDateLine,
} from './newstime.mjs';
import { captionLength, postHtml, postText } from './telegram.mjs';
import { qaPost } from './engine.mjs';

const RLM = '\u200F';

test('the shamsi date uses the article timestamp in Tehran', () => {
  assert.equal(newsDate('2026-11-03T12:35:49Z'), 'سه‌شنبه ۱۲ آبان ۱۴۰۵');
  assert.equal(newsDateLine('2026-11-03T12:35:49Z'), '📅 تاریخ خبر: سه‌شنبه ۱۲ آبان ۱۴۰۵');
});

test('the shamsi date rolls over at Tehran midnight', () => {
  assert.equal(newsDate('2026-11-03T20:40:00Z'), 'چهارشنبه ۱۳ آبان ۱۴۰۵');
});

test('a missing or invalid timestamp has no date line', () => {
  assert.equal(newsDate(''), '');
  assert.equal(newsDate(undefined), '');
  assert.equal(newsDate('not a date'), '');
  assert.equal(newsDateLine(''), '');
});

const newsDateLineSample = '📅 تاریخ خبر: سه‌شنبه ۱۲ آبان ۱۴۰۵';

test('the date line sits under the title and counts toward the caption', () => {
  const post = { title: 'عنوان', news_date: newsDateLineSample, body: 'متن' };
  assert.equal(postText(post), `عنوان\n\n${newsDateLineSample}\n\nمتن`);
  assert.ok(postHtml(post).includes(`</b>\n\n${RLM}${newsDateLineSample}\n\n${RLM}متن`));
  assert.equal(captionLength(post), postText(post).length);
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
  image_url: 'https://example.com/a.jpg',
  dedupe_key: 'news-date-test',
};

const context = {
  url: 'https://example.com',
  host: 'example.com',
  sourceType: 'news',
  imageUrl: 'https://example.com/a.jpg',
  title: 'خبر',
  description: '',
  content: '',
  publishedAt: '2026-11-02T15:00:00Z',
  now: '2026-11-02T17:00:00Z',
};

test('QA checks the date line and reserves caption space for it', () => {
  const passing = qaPost({ ...basePost, title: 'تیتر خبر', body: 'ا'.repeat(840) }, context);
  const dateCheck = passing.checks.find((check) => check.name === 'news_date');
  assert.equal(dateCheck.ok, true);
  assert.equal(dateCheck.hard, false);
  assert.equal(dateCheck.detail, '📅 تاریخ خبر: دوشنبه ۱۱ آبان ۱۴۰۵');
  const passingCaption = passing.checks.find((check) => check.name === 'caption');
  assert.equal(passingCaption.ok, true);

  const overflowing = qaPost({ ...basePost, title: 'تیتر خبر', body: 'ا'.repeat(860) }, context);
  const overflowCaption = overflowing.checks.find((check) => check.name === 'caption');
  assert.equal(overflowCaption.ok, false);
  assert.ok(overflowing.problems.includes('caption'));
});

test('QA counts the quote in the image caption budget', () => {
  const withoutQuote = qaPost({ ...basePost, title: 'تیتر خبر', body: 'ا'.repeat(540) }, context);
  assert.equal(withoutQuote.checks.find((check) => check.name === 'caption').ok, true);

  const withQuote = qaPost(
    { ...basePost, title: 'تیتر خبر', body: 'ا'.repeat(540), quote: 'ا'.repeat(330) },
    context
  );
  const captionCheck = withQuote.checks.find((check) => check.name === 'caption');
  assert.equal(captionCheck.ok, false);
  assert.ok(withQuote.problems.includes('caption'));
});

test('QA has no date line when the timestamp is invalid', () => {
  const qa = qaPost({ ...basePost, title: 'تیتر خبر', body: 'ا'.repeat(500) }, { ...context, publishedAt: '' });
  const dateCheck = qa.checks.find((check) => check.name === 'news_date');
  assert.equal(dateCheck.ok, false);
  assert.equal(dateCheck.hard, false);
});

test('the effective date is rendered in Jalali with its own line', () => {
  assert.equal(effectiveDate('2026-11-12T12:00:00Z'), '۲۱ آبان ۱۴۰۵');
  assert.deepEqual(effectiveDateParts('2026-11-12T12:00:00Z'), {
    day: '۲۱',
    month: 'آبان',
    year: '۱۴۰۵',
    text: '۲۱ آبان ۱۴۰۵',
  });
  assert.equal(effectiveDateLine('2026-11-12T12:00:00Z'), '📅 تاریخ اجرا: ۲۱ آبان ۱۴۰۵');
  assert.equal(effectiveDateLine(''), '');
  assert.equal(effectiveDateLine('not a date'), '');
});

test('the effective date can be matched inside the body regardless of year or digits', () => {
  const iso = '2026-11-12';
  assert.equal(mentionsEffectiveDate('این سیاست از ۲۱ آبان ۱۴۰۵ اجرا می‌شه.', iso), true);
  assert.equal(mentionsEffectiveDate('این سیاست از ۲۱ آبان اجرا می‌شه.', iso), true);
  assert.equal(mentionsEffectiveDate('تاریخ اجرا 2026-11-12 است.', iso), true);
  assert.equal(mentionsEffectiveDate('این سیاست از ۲۲ آبان ۱۴۰۵ اجرا می‌شه.', iso), false);
  assert.equal(mentionsEffectiveDate('متن بدون تاریخ', ''), false);
});

test('QA rejects a policy body that drops the effective date', () => {
  const policyContext = { ...context, effectiveDate: '2026-11-12', policy: true };
  const missing = qaPost(
    { ...basePost, title: 'سیاست تازهٔ استفاده از سرویس', body: 'لید خبر.\n\nاهمیتش اینه که دسترسی روشن‌تر می‌شه.' },
    policyContext
  );
  assert.ok(missing.problems.includes('effective_date'));
  const present = qaPost(
    {
      ...basePost,
      title: 'سیاست تازهٔ استفاده از سرویس',
      body: 'این سیاست از ۲۱ آبان ۱۴۰۵ اجرا می‌شه.\n\nاهمیتش اینه که دسترسی روشن‌تر می‌شه.',
    },
    policyContext
  );
  assert.equal(present.problems.includes('effective_date'), false);
});

test('QA rejects a policy body that only implies Iran instead of stating the list fact', () => {
  const policyContext = { ...context, effectiveDate: '2026-11-12', policy: true, policyIran: true };
  const vague = qaPost(
    {
      ...basePost,
      title: 'سیاست تازهٔ استفاده از سرویس',
      body: 'این سیاست از ۲۱ آبان ۱۴۰۵ اجرا می‌شه.\n\nاین تغییر برای کاربران ایرانی مهمه.',
    },
    policyContext
  );
  assert.ok(vague.problems.includes('policy_iran'));

  const explicit = qaPost(
    {
      ...basePost,
      title: 'سیاست تازهٔ استفاده از سرویس',
      body: 'این سیاست از ۲۱ آبان ۱۴۰۵ اجرا می‌شه. ایران در فهرست رسمی کشورهای پشتیبانی‌شده نیست.',
    },
    policyContext
  );
  assert.equal(explicit.problems.includes('policy_iran'), false);

  const noIranRule = qaPost(
    {
      ...basePost,
      title: 'سیاست تازهٔ استفاده از سرویس',
      body: 'این سیاست از ۲۱ آبان ۱۴۰۵ اجرا می‌شه.\n\nاین تغییر برای کاربران ایرانی مهمه.',
    },
    { ...policyContext, policyIran: false }
  );
  assert.equal(noIranRule.problems.includes('policy_iran'), false);
});
