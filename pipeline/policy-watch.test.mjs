import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffLines,
  extractCountryList,
  parseEffectiveDate,
  watchPolicySource,
} from './policy-watch.mjs';
import { collectCandidates } from './collect.mjs';
import { dedupeKeys, emptyState, markSeen } from './store.mjs';

const POLICY_URL = 'https://example.com/news/policy-update';
const LEGAL_URL = 'https://example.com/legal/aup';
const COUNTRIES_URL = 'https://example.com/supported-countries';

const countries = [
  'Albania',
  'Algeria',
  'Argentina',
  'Armenia',
  'Australia',
  'Austria',
  'Bahrain',
  'Bangladesh',
  'Belgium',
  'Brazil',
  'Bulgaria',
  'Canada',
  'Chile',
  'Colombia',
  'Croatia',
  'Cyprus',
  'Czechia',
  'Denmark',
  'Estonia',
  'Finland',
  'France',
  'Georgia',
  'Germany',
  'Ghana',
  'Greece',
];

const policyHtml = (sentence = 'The updated policy takes effect on November 12.') => `<html><head>
  <meta property="og:title" content="Updating our Usage Policy">
  <meta property="article:published_time" content="2026-10-08T00:00:00Z">
  <meta property="article:modified_time" content="2026-10-14T00:00:00Z">
  </head><body>
  <p>We are updating our Usage Policy to make it clearer for everyone who uses our services around the world today.</p>
  <p>We want to give everyone plenty of notice about this change. ${sentence} It applies to all users of our services worldwide.</p>
  <p>Our policy prohibits the use of Claude by people who are physically located in an unsupported region, by entities who are incorporated or headquartered in one, and by entities who are majority-owned or controlled by persons or entities in those regions.</p>
  </body></html>`;

const legalHtml = `<html><head><meta property="og:title" content="Usage Policy"></head><body>
  <p>This Usage Policy applies to everyone who accesses or uses our services, including free and paid accounts worldwide.</p>
  </body></html>`;

const countriesHtml = (extra = '') => `<html><body>
  <h2>Countries and regions where we currently offer our services</h2>
  <ul>${countries.map((name) => `<li>${name}</li>`).join('')}${extra}</ul>
  <p>Any country or region not listed is unsupported.</p>
  </body></html>`;

const pagesFor = (overrides = {}) => ({
  [POLICY_URL]: policyHtml(),
  [LEGAL_URL]: legalHtml,
  [COUNTRIES_URL]: countriesHtml(),
  ...overrides,
});

const source = {
  id: 'example-policy',
  name: 'Example Usage Policy',
  url: POLICY_URL,
  type: 'policy',
  use: 'policy',
  categories: ['business'],
  status: 'verified',
  watch_urls: [
    { url: POLICY_URL, parser: 'policy', label_fa: 'خبر سیاست استفاده' },
    { url: LEGAL_URL, parser: 'article', label_fa: 'متن سیاست استفاده' },
    { url: COUNTRIES_URL, parser: 'countries', label_fa: 'فهرست کشورهای پشتیبانی‌شده' },
  ],
};

const fakeFetch = (pages) => async (url) => {
  if (!pages[url]) throw new Error(`missing page ${url}`);
  return { text: pages[url], url };
};

const run = (pages, { state = { targets: {} }, now = '2026-11-08T05:00:00Z', slotDate = '2026-11-08' } = {}) =>
  watchPolicySource({
    source,
    policyState: state,
    now,
    fetchImpl: fakeFetch(pages),
    reminderDays: 7,
    slotDate,
  });

test('the effective date is parsed from the official sentence and rendered in Jalali', () => {
  const parsed = parseEffectiveDate('The updated policy takes effect on November 12.', {
    after: '2026-10-08T00:00:00Z',
    now: '2026-11-08T05:00:00Z',
  });
  assert.equal(parsed.iso, '2026-11-12');
  assert.equal(parsed.label, '۲۱ آبان ۱۴۰۵');

  const explicit = parseEffectiveDate('This policy is effective on January 5, 2027.', {
    now: '2026-11-08T05:00:00Z',
  });
  assert.equal(explicit.iso, '2027-01-05');

  const inferred = parseEffectiveDate('Effective as of January 5.', { now: '2026-11-08T05:00:00Z' });
  assert.equal(inferred.iso, '2027-01-05');

  assert.equal(parseEffectiveDate('No date is mentioned here.', { now: '2026-11-08T05:00:00Z' }), null);
  assert.equal(parseEffectiveDate('takes effect on Smarch 5', { now: '2026-11-08T05:00:00Z' }), null);
  assert.equal(parseEffectiveDate('takes effect on November 31', { now: '2026-11-08T05:00:00Z' }), null);
});

test('the official country list is extracted, cleaned and deduplicated', () => {
  const html = `<h2>Countries and regions where we currently offer our services</h2>
    <ul><li>Germany</li><li>France</li><li>Germany</li><li>Germany &amp; islands</li><li>۲</li></ul>
    <p>Unrelated paragraph.</p>`;
  const list = extractCountryList(html);
  assert.deepEqual(list, ['Germany', 'France', 'Germany & islands']);
});

test('line diffs show only the added and removed lines up to the limit', () => {
  const diff = diffLines('one\ntwo\nthree\nfour', 'one\nthree\nfive\nsix\nseven', 2);
  assert.deepEqual(diff.added, ['five', 'six']);
  assert.deepEqual(diff.removed, ['two', 'four']);
});

test('the first watch stores a baseline and queues the effective-date reminder', async () => {
  const state = { targets: {} };
  const result = await run(pagesFor(), { state });
  assert.equal(result.baseline, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.changes.length, 0);
  assert.equal(result.effective.iso, '2026-11-12');
  assert.equal(result.countries.verified, true);
  assert.equal(result.countries.count, countries.length);
  assert.equal(result.countries.hasIran, false);
  assert.equal(result.items.length, 1);

  const reminder = result.items[0];
  assert.equal(reminder.policyKind, 'effective_reminder');
  assert.match(reminder.title, /۲۱ آبان/);
  assert.match(reminder.messageText, /۲۱ آبان ۱۴۰۵/);
  assert.match(reminder.messageText, /The updated policy takes effect on November 12\./);
  assert.match(reminder.messageText, /prohibits the use of Claude/);
  assert.match(reminder.messageText, /ایران را شامل نمی‌شود/);
  assert.match(reminder.messageText, /مسدودسازی حساب اعلام نکرده است/);
  assert.equal(reminder.effectiveDate, '2026-11-12');
  assert.deepEqual(
    Object.keys(state.targets['example-policy'].pages).sort(),
    [COUNTRIES_URL, LEGAL_URL, POLICY_URL].sort()
  );
});

test('the same-day reminder is suppressed and the next day allows it again', async () => {
  const state = { targets: {} };
  const first = await run(pagesFor(), { state });
  state.targets['example-policy'].last_reminder_date = '2026-11-08';

  const sameDay = await run(pagesFor(), { state });
  assert.equal(sameDay.reminder, null);
  assert.equal(sameDay.items.length, 0);

  const nextDay = await run(pagesFor(), {
    state,
    now: '2026-11-09T05:00:00Z',
    slotDate: '2026-11-09',
  });
  assert.ok(nextDay.reminder);
  assert.deepEqual(nextDay.reminder.keys, first.reminder.keys);
});

test('a changed official page becomes a policy change item and silences the reminder', async () => {
  const state = { targets: {} };
  await run(pagesFor(), { state });
  const changedPages = pagesFor({ [COUNTRIES_URL]: countriesHtml('<li>Iran</li>') });
  const result = await run(changedPages, {
    state,
    now: '2026-11-09T05:00:00Z',
    slotDate: '2026-11-09',
  });
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].url, COUNTRIES_URL);
  assert.equal(result.reminder, null);
  assert.equal(result.items.length, 1);
  const change = result.items[0];
  assert.equal(change.policyKind, 'change');
  assert.match(change.title, /فهرست کشورهای پشتیبانی‌شده/);
  assert.match(change.messageText, /\+ <li>Iran<\/li>|\+ Iran/);
  assert.equal(change.effectiveDate, '2026-11-12');
  assert.match(change.canonical, /#policy-[0-9a-f]{10}$/);
});

test('a page fetch error is reported without stopping the other pages', async () => {
  const pages = pagesFor();
  delete pages[LEGAL_URL];
  const state = { targets: {} };
  const result = await run(pages, { state });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /missing page/);
  assert.ok(result.reminder);
  assert.ok(state.targets['example-policy'].pages[POLICY_URL]);
  assert.equal(state.targets['example-policy'].pages[LEGAL_URL], undefined);
});

test('the collector emits a business policy candidate with the effective date', async () => {
  const state = emptyState();
  const policyState = { targets: {} };
  const result = await collectCandidates({
    sources: [source],
    state,
    now: '2026-11-08T05:00:00Z',
    maxAgeHours: 72,
    fetchImpl: fakeFetch(pagesFor()),
    policyState,
    policy: { reminder_days: 7, slot_date: '2026-11-08' },
  });

  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.policy, true);
  assert.equal(candidate.policyReminder, true);
  assert.equal(candidate.policyKind, 'effective_reminder');
  assert.equal(candidate.effectiveDate, '2026-11-12');
  assert.equal(candidate.categoryHint, 'business');
  assert.equal(candidate.link, POLICY_URL);
  assert.equal(candidate.policyCountries.verified, true);
  assert.equal(candidate.policyCountries.hasIran, false);
  assert.match(candidate.messageText, /۲۱ آبان ۱۴۰۵/);
  assert.equal(result.stats.policyItems, 1);
  assert.equal(result.stats.policyReminder, 1);
  assert.equal(result.stats.policyChanges, 0);
});

test('a published policy reminder is not repeated from the seen memory', async () => {
  const state = emptyState();
  const policyState = { targets: {} };
  const options = {
    sources: [source],
    state,
    now: '2026-11-08T05:00:00Z',
    maxAgeHours: 72,
    fetchImpl: fakeFetch(pagesFor()),
    policyState,
    policy: { reminder_days: 7, slot_date: '2026-11-08' },
  };
  const first = await collectCandidates(options);
  markSeen(state, first.candidates[0].keys, { decision: 'publish' });

  const second = await collectCandidates(options);
  assert.equal(second.candidates.length, 0);
  assert.equal(second.stats.duplicate, 1);

  const missingState = await collectCandidates({ ...options, policyState: null });
  assert.equal(missingState.candidates.length, 0);
  assert.equal(missingState.stats.errors[0].kind, 'policy');
});

test('a policy reminder respects the seen memory shared with the other lane', async () => {
  const review = emptyState();
  markSeen(review, dedupeKeys({ url: POLICY_URL, title: 'سیاست استفادهٔ آنتروپیک از ۲۱ آبان اجرا می‌شود' }), {
    decision: 'publish',
  });
  const result = await collectCandidates({
    sources: [source],
    state: emptyState(),
    memoryStates: [review],
    now: '2026-11-08T05:00:00Z',
    maxAgeHours: 72,
    fetchImpl: fakeFetch(pagesFor()),
    policyState: { targets: {} },
    policy: { reminder_days: 7, slot_date: '2026-11-08' },
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.stats.crossLane, 1);
  assert.equal(result.stats.duplicate, 1);
});
