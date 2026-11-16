import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDiscoveredSource,
  discoverFeeds,
  dynamicSourceId,
  emptyDynamicSources,
  extractCandidateDomains,
  looksAi,
  shouldDiscover,
} from './source-discovery.mjs';

const NOW = '2026-11-16T12:00:00.000Z';
const DAY = 86400000;
const at = (daysAgo) => new Date(Date.parse(NOW) - daysAgo * DAY).toISOString();

test('repeated unregistered domains become discovery candidates', () => {
  const candidates = extractCandidateDomains({
    states: [
      {
        published: [
          { at: at(1), url: 'https://blog.example.com/a', title: 'A' },
          { at: at(2), url: 'https://blog.example.com/b', title: 'B' },
          { at: at(3), url: 'https://openai.com/news/x', title: 'C' },
          { at: at(4), url: 'https://t.me/channel/1', title: 'D' },
          { at: at(5), url: 'https://t.me/channel/2', title: 'E' },
          { at: at(50), url: 'https://old.example.com/a', title: 'old' },
          { at: at(51), url: 'https://old.example.com/b', title: 'old' },
        ],
      },
    ],
    registrySources: [{ id: 'openai-news', url: 'https://openai.com/news/', type: 'official_blog' }],
    denyDomains: ['t.me'],
    now: NOW,
    windowDays: 30,
    minItems: 2,
  });
  assert.deepEqual(candidates.map((entry) => entry.host), ['blog.example.com']);
  assert.equal(candidates[0].count, 2);
});

test('a working recent AI feed is discovered from a repeated domain', async () => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>
<item><title>OpenAI ships a new model</title><link>https://blog.example.com/one</link><pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate><description>LLM release</description></item>
<item><title>A new agent framework</title><link>https://blog.example.com/two</link><pubDate>Sun, 15 Nov 2026 10:00:00 GMT</pubDate><description>Agents</description></item>
</channel></rss>`;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://blog.example.com/rss.xml') return { text: feed, url, status: 200 };
    throw new Error('HTTP 404');
  };
  const result = await discoverFeeds({
    candidates: [{ host: 'blog.example.com' }],
    fetchImpl,
    now: NOW,
    settings: { max_attempts: 6, recent_days: 14 },
  });
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].host, 'blog.example.com');
  assert.equal(result.found[0].feedUrl, 'https://blog.example.com/rss.xml');
  assert.ok(result.found[0].aiCount >= 2);
  assert.ok(calls.length <= 6);
});

test('a dead or off-topic feed is not accepted', async () => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>
<item><title>Local weather</title><link>https://blog.example.com/one</link><pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Sports results</title><link>https://blog.example.com/two</link><pubDate>Sun, 15 Nov 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;
  const result = await discoverFeeds({
    candidates: [{ host: 'blog.example.com' }],
    fetchImpl: async (url) => ({ text: feed, url, status: 200 }),
    now: NOW,
  });
  assert.equal(result.found.length, 0);
});

test('a discovered source is capped and tagged for a trial', () => {
  const doc = emptyDynamicSources();
  const result = addDiscoveredSource(
    doc,
    {
      host: 'blog.example.com',
      feedUrl: 'https://blog.example.com/rss.xml',
      titles: ['OpenAI model update'],
    },
    { now: NOW, discoveredFrom: ['https://blog.example.com/a'] }
  );
  assert.equal(result.added, true);
  assert.equal(result.source.max_items_per_run, 1);
  assert.equal(result.source.type, 'discovered_feed');
  assert.equal(result.source.id, dynamicSourceId('blog.example.com'));
  assert.ok(Date.parse(result.source.trialUntil) > Date.parse(NOW));
  const duplicate = addDiscoveredSource(
    result.document,
    { host: 'blog.example.com', feedUrl: 'https://blog.example.com/rss.xml' },
    { now: NOW }
  );
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.reason, 'duplicate');
});

test('discovery runs once per Tehran day', () => {
  assert.equal(shouldDiscover({ document: emptyDynamicSources(), now: NOW }), true);
  assert.equal(shouldDiscover({ document: { lastDiscoveryDate: '2026-11-16' }, now: NOW }), false);
});

test('the AI keyword test is not fooled by short substrings', () => {
  assert.equal(looksAi('OpenAI released a new LLM'), true);
  assert.equal(looksAi('هوش مصنوعی جدیدی معرفی شد'), true);
  assert.equal(looksAi('The email said the sail was fine'), false);
});
