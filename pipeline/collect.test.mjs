import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCandidates, aiHint, rankCandidates } from './collect.mjs';
import { emptyState, markSeen, dedupeKeys } from './store.mjs';

const NOW = '2026-11-02T15:00:00Z';

const item = ({ title, link, date }) => `<item>
  <title><![CDATA[${title}]]></title>
  <link>${link}</link>
  <description><![CDATA[summary]]></description>
  <pubDate>${date}</pubDate>
</item>`;

const feed = (items) => `<rss><channel>${items.join('\n')}</channel></rss>`;

test('AI hints match real AI words without false positives', () => {
  assert.equal(aiHint('OpenAI ships a new model'), true);
  assert.equal(aiHint('AI agents are changing work'), true);
  assert.equal(aiHint('Ninja microwave review'), false);
  assert.equal(aiHint('Saudi fund said to buy a stake'), false);
});

test('ranking puts AI candidates before fresher off-topic ones', () => {
  const ranked = rankCandidates([
    { title: 'fresh non ai', aiHint: false, ageHours: 0.2 },
    { title: 'older ai', aiHint: true, ageHours: 5 },
    { title: 'fresher ai', aiHint: true, ageHours: 1 },
  ]);
  assert.deepEqual(ranked.map((entry) => entry.title), ['fresher ai', 'older ai', 'fresh non ai']);
});

test('collector drops stale, duplicate and already seen items', async () => {
  const feeds = {
    'https://one.example/feed': feed([
      item({ title: 'OpenAI ships a new model', link: 'https://one.example/openai?utm_source=x', date: 'Mon, 02 Nov 2026 13:00:00 +0000' }),
      item({ title: 'Ninja microwave review', link: 'https://one.example/microwave', date: 'Mon, 02 Nov 2026 14:00:00 +0000' }),
      item({ title: 'Old AI story', link: 'https://one.example/old', date: 'Wed, 29 Oct 2026 00:00:00 +0000' }),
      item({ title: 'OpenAI ships a new model', link: 'https://one.example/openai', date: 'Mon, 02 Nov 2026 13:00:00 +0000' }),
    ]),
    'https://two.example/feed': feed([
      item({ title: 'Already seen AI item', link: 'https://two.example/seen', date: 'Mon, 02 Nov 2026 12:00:00 +0000' }),
      item({ title: 'New security issue in an AI tool', link: 'https://two.example/security', date: 'Mon, 02 Nov 2026 11:00:00 +0000' }),
    ]),
  };
  const state = emptyState();
  markSeen(state, dedupeKeys({ url: 'https://two.example/seen', title: 'Already seen AI item' }), {
    decision: 'skip',
  });

  const result = await collectCandidates({
    sources: [
      { id: 'one', name: 'One', type: 'news', feed_url: 'https://one.example/feed' },
      { id: 'two', name: 'Two', type: 'news', feed_url: 'https://two.example/feed' },
      { id: 'no-feed', name: 'No feed', type: 'news' },
    ],
    state,
    now: NOW,
    fetchImpl: async (url) => {
      if (!feeds[url]) throw new Error(`missing feed ${url}`);
      return { text: feeds[url], url };
    },
  });

  assert.deepEqual(result.candidates.map((entry) => entry.title), [
    'OpenAI ships a new model',
    'New security issue in an AI tool',
    'Ninja microwave review',
  ]);
  assert.equal(result.stats.sources, 2);
  assert.equal(result.stats.feedItems, 6);
  assert.equal(result.stats.stale, 1);
  assert.equal(result.stats.duplicate, 2);
  assert.equal(result.stats.kept, 3);
  assert.equal(result.candidates[0].ageHours, 2);
  assert.equal(result.candidates[0].keys.length, 2);
});

test('an AI-only official feed keeps model releases and drops non-AI items', async () => {
  const result = await collectCandidates({
    sources: [
      {
        id: 'google-models-research',
        name: 'Google Models & Research',
        type: 'official_blog',
        categories: ['models'],
        use: 'feed',
        require_ai: true,
        feed_url: 'https://feed.example/models',
      },
    ],
    state: emptyState(),
    now: NOW,
    fetchImpl: async (url) => ({
      text: feed([
        item({
          title: 'Gemini 4 Carbon is now available',
          link: 'https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-carbon-now-available/',
          date: 'Mon, 02 Nov 2026 13:00:00 +0000',
        }),
        item({
          title:
            "We're bringing Adobe's creative and productivity tools closer to your everyday Google apps.",
          link: 'https://blog.google/company-news/inside-google/company-announcements/adobe-google-partnership-integration/',
          date: 'Mon, 02 Nov 2026 13:00:00 +0000',
        }),
      ]),
      url,
    }),
  });
  assert.equal(result.candidates.length, 1);
  const lead = result.candidates[0];
  assert.equal(lead.title, 'Gemini 4 Carbon is now available');
  assert.equal(lead.modelRelease, true);
  assert.equal(lead.categoryHint, 'models');
  assert.equal(result.stats.nonAi, 1);
});

test('collector skips an item already seen in the other lane', async () => {
  const active = emptyState();
  const review = emptyState();
  markSeen(active, dedupeKeys({ url: 'https://two.example/active', title: 'Active AI item' }), {
    at: '2026-11-02T10:00:00.000Z',
    decision: 'qa_failed',
  });
  markSeen(review, dedupeKeys({ url: 'https://two.example/reviewed', title: 'Reviewed AI item' }), {
    at: '2026-11-02T10:00:00.000Z',
    decision: 'review',
  });
  markSeen(review, dedupeKeys({ url: 'https://two.example/old-review', title: 'Old reviewed AI item' }), {
    at: '2026-09-01T10:00:00.000Z',
    decision: 'review',
  });

  const result = await collectCandidates({
    sources: [{ id: 'two', name: 'Two', type: 'news', feed_url: 'https://two.example/feed' }],
    state: active,
    memoryStates: [review],
    now: NOW,
    fetchImpl: async (url) => ({
      text: feed([
        item({ title: 'Active AI item', link: 'https://two.example/active', date: 'Mon, 02 Nov 2026 13:00:00 +0000' }),
        item({ title: 'Reviewed AI item', link: 'https://two.example/reviewed', date: 'Mon, 02 Nov 2026 13:00:00 +0000' }),
        item({ title: 'Old reviewed AI item', link: 'https://two.example/old-review', date: 'Mon, 02 Nov 2026 13:00:00 +0000' }),
      ]),
      url,
    }),
  });

  assert.deepEqual(result.candidates.map((entry) => entry.title), ['Old reviewed AI item']);
  assert.equal(result.stats.duplicate, 2);
  assert.equal(result.stats.crossLane, 1);
  assert.equal(result.stats.kept, 1);
});

test('a feed error does not stop the other sources', async () => {
  const result = await collectCandidates({
    sources: [
      { id: 'broken', name: 'Broken', type: 'news', feed_url: 'https://broken.example/feed' },
      { id: 'ok', name: 'Ok', type: 'news', feed_url: 'https://ok.example/feed' },
    ],
    state: emptyState(),
    now: NOW,
    fetchImpl: async (url) => {
      if (url.includes('broken')) throw new Error('HTTP 500');
      return {
        text: feed([
          item({ title: 'AI model release', link: 'https://ok.example/a', date: 'Mon, 02 Nov 2026 13:00:00 +0000' }),
        ]),
        url,
      };
    },
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.stats.errors.length, 1);
});

test('the benchmark source turns a model commit into a models candidate', async () => {
  const atomFeed = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title type="text">Qwen-4-Flash-Early added to the benchmark data</title>
    <link rel="alternate" type="text/html" href="https://github.com/kodasdream/gamefeel-benchmark/commit/daa3d11"/>
    <updated>2026-11-02T12:00:00Z</updated>
  </entry>
  <entry>
    <title type="text">Update README.md</title>
    <link rel="alternate" type="text/html" href="https://github.com/kodasdream/gamefeel-benchmark/commit/fdeb933"/>
    <updated>2026-11-02T13:00:00Z</updated>
  </entry>
</feed>`;
  const csv = [
    'model,effort,lab,price_per_task_usd,context,create,bugfix,gamefeel,ideas,visuals,audio,re,avg,open_weights,size_gb,re_test',
    'Qwen-4-Flash-Early,Max,Alibaba Qwen,0.4,1M,65,63,52,54,64,31,19.95,49.9,,,,',
    'Opus-5.5,XHigh,Anthropic,2.6,1M,60,58,50,51,55,33,17,47.2,,,,',
  ].join('\n');

  const result = await collectCandidates({
    sources: [
      {
        id: 'gamefeel-benchmark',
        name: 'The Gamefeel Benchmark',
        type: 'benchmark',
        use: 'benchmark',
        categories: ['models'],
        commits_url: 'https://feed.example/atom',
        data_url: 'https://data.example/csv',
      },
    ],
    state: emptyState(),
    now: NOW,
    fetchImpl: async (url) => ({ text: url.includes('atom') ? atomFeed : csv, url }),
  });

  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.categoryHint, 'models');
  assert.equal(candidate.aiCentral, true);
  assert.equal(candidate.sourceType, 'benchmark');
  assert.match(candidate.title, /tops The Gamefeel Benchmark with 49\.9/);
  assert.match(candidate.messageText, /overall 49\.9\/100/);
  assert.match(candidate.messageText, /Opus-5\.5 47\.2/);
  assert.equal(result.stats.benchmarkItems, 1);
});
