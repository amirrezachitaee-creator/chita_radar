import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFacts,
  buildTitle,
  fetchGamefeel,
  isModelUpdate,
  modelsInCommit,
  parseGamefeelCsv,
} from './gamefeel.mjs';

const COMMITS = 'https://feed.example/commits.atom';
const DATA = 'https://data.example/gamefeel.csv';

const HEADER =
  'model,effort,lab_key,lab,price_per_task_usd,billing,context,minutes_per_task,context_compression_per_task,tokens_per_second,create,bugfix,gamefeel,ideas,visuals,audio,re,avg,open_weights,size_gb,size_basis,re_test';

const CSV = [
  HEADER,
  'Qwen-4-Flash-Early,Max,alibaba,Alibaba Qwen,0.4,api,1M,23,1,240,65,63,52,54,64,31,19.95,49.9,,,,',
  'Opus-5.5,XHigh,anthropic,Anthropic,2.6,api,1M,20,0,200,60,58,50,51,55,33,17,47.2,,,,',
  'Qwen-4-27B-Early,XHigh,alibaba,Alibaba Qwen,0.16,api,1M,185,5,370,64,63,51,43,48,28,14.88,44.6,yes,35,quantization not stated,',
  'Gpt-6.1-Sol,High,openai,OpenAI,,,,,,,,,,,,,7.61,,,,,"Semi-private subset of the RE test, 748 tasks"',
].join('\n');

const entry = ({ title, link, updated }) => `<entry>
  <title type="text">${title}</title>
  <link rel="alternate" type="text/html" href="${link}"/>
  <updated>${updated}</updated>
  <content type="html">&lt;pre&gt;${title}&lt;/pre&gt;</content>
</entry>`;

const atom = (entries) => `<feed xmlns="http://www.w3.org/2005/Atom">${entries.join('\n')}</feed>`;

const QWEN_TITLE =
  'Qwen-4-Flash-Early added; Qwen-4-27B-Early audio corrected; both Qwen-4 models in the highlight figures (2026-11-08 01:56)';
const GPT_TITLE =
  'Gpt-6.1-Sol and Gpt-6.1-Terra added to the RE scores (semi-private subset, 748 tasks)';
const CHART_TITLE =
  'Qwen-4-27B-Early on the frontier in the regular charts; purple highlight as separate figures';

const FEED = atom([
  entry({ title: GPT_TITLE, link: 'https://github.com/kodasdream/gamefeel-benchmark/commit/c1e1454', updated: '2026-11-08T13:18:58Z' }),
  entry({ title: 'Update README.md', link: 'https://github.com/kodasdream/gamefeel-benchmark/commit/fdeb933', updated: '2026-11-08T11:22:19Z' }),
  entry({ title: QWEN_TITLE, link: 'https://github.com/kodasdream/gamefeel-benchmark/commit/daa3d11', updated: '2026-11-07T23:56:28Z' }),
  entry({ title: CHART_TITLE, link: 'https://github.com/kodasdream/gamefeel-benchmark/commit/5380042', updated: '2026-11-07T19:26:59Z' }),
  entry({ title: 'Update benchmark data (2026-11-07 18:53)', link: 'https://github.com/kodasdream/gamefeel-benchmark/commit/5dceb3c', updated: '2026-11-07T16:53:28Z' }),
]);

const source = {
  id: 'gamefeel-benchmark',
  name: 'The Gamefeel Benchmark',
  type: 'benchmark',
  use: 'benchmark',
  categories: ['models'],
  commits_url: COMMITS,
  data_url: DATA,
};

test('the publisher csv keeps quoted text and empty scores apart', () => {
  const rows = parseGamefeelCsv(CSV);
  assert.equal(rows.length, 4);
  const flash = rows.find((row) => row.model === 'Qwen-4-Flash-Early');
  assert.equal(flash.avg, 49.9);
  assert.equal(flash.create, 65);
  assert.equal(flash.price, '0.4');
  const gpt = rows.find((row) => row.model === 'Gpt-6.1-Sol');
  assert.equal(gpt.avg, null);
  assert.equal(gpt.re, 7.61);
  assert.equal(gpt.reTest, 'Semi-private subset of the RE test, 748 tasks');
  assert.throws(() => parseGamefeelCsv('model,effort\nx,y'), /missing avg/);
});

test('model names match on whole boundaries and chart-only commits are not news', () => {
  const rows = parseGamefeelCsv(CSV);
  assert.deepEqual(
    modelsInCommit(QWEN_TITLE, rows).map((row) => row.model),
    ['Qwen-4-Flash-Early', 'Qwen-4-27B-Early']
  );
  assert.deepEqual(modelsInCommit('Qwen-4-Flash-Earlyish update', rows), []);
  assert.deepEqual(modelsInCommit('Update README.md', rows), []);
  assert.equal(isModelUpdate(QWEN_TITLE), true);
  assert.equal(isModelUpdate(GPT_TITLE), true);
  assert.equal(isModelUpdate(CHART_TITLE), false);
  assert.equal(isModelUpdate('Update README.md'), false);
});

test('a scoring model commit becomes a leader title with the exact scores', async () => {
  const calls = [];
  const items = await fetchGamefeel(
    source,
    async (url) => {
      calls.push(url);
      return { text: url === COMMITS ? FEED : CSV, url };
    },
    (value) => String(value ?? '').slice(0, 200)
  );
  assert.deepEqual(calls, [COMMITS, DATA]);
  assert.equal(items.length, 2);

  const qwen = items.find((item) => item.title.includes('Qwen-4-Flash-Early'));
  assert.equal(qwen.title, 'Qwen-4-Flash-Early tops The Gamefeel Benchmark with 49.9 overall');
  assert.equal(qwen.link, 'https://github.com/kodasdream/gamefeel-benchmark/commit/daa3d11');
  assert.equal(qwen.published, '2026-11-07T23:56:28Z');
  assert.match(qwen.messageText, /overall 49\.9\/100, rank 1 of 3/);
  assert.match(qwen.messageText, /create 65, bugfix 63/);
  assert.match(qwen.messageText, /price per task \$0\.40/);
  assert.match(qwen.messageText, /open weights not listed/);
  assert.match(qwen.messageText, /overall 44\.6\/100, rank 3 of 3/);
  assert.match(qwen.messageText, /open weights, 35 GB/);
  assert.match(qwen.messageText, /Qwen-4-Flash-Early 49\.9, Opus-5\.5 47\.2/);

  const gpt = items.find((item) => item.title.includes('Gpt-6.1-Sol'));
  assert.equal(gpt.title, 'Gpt-6.1-Sol added to The Gamefeel Benchmark reverse-evaluation scores');
  assert.match(gpt.messageText, /reverse-evaluation 7\.61/);
  assert.match(gpt.messageText, /748 tasks/);
});

test('a feed without model commits never downloads the score table', async () => {
  const calls = [];
  const items = await fetchGamefeel(
    source,
    async (url) => {
      calls.push(url);
      return { text: atom([entry({ title: 'Update README.md', link: 'https://example.com/a', updated: '2026-11-08T11:22:19Z' })]), url };
    },
    (value) => value
  );
  assert.deepEqual(items, []);
  assert.deepEqual(calls, [COMMITS]);
});

test('the facts block lists every model in the commit and the top three scores', () => {
  const rows = parseGamefeelCsv(CSV);
  const models = modelsInCommit(QWEN_TITLE, rows);
  const facts = buildFacts({
    commit: { title: QWEN_TITLE, published: '2026-11-07T23:56:28Z' },
    models,
    rows,
  });
  assert.match(facts, /Alibaba Qwen/);
  assert.match(facts, /overall 49\.9\/100/);
  assert.match(facts, /overall 44\.6\/100/);
  assert.match(facts, /Leaderboard context/);
  assert.match(facts, /Qwen-4-Flash-Early 49\.9/);
  assert.doesNotMatch(facts, /…/);
});

test('a commit with no overall score does not claim a rank', () => {
  const rows = parseGamefeelCsv(CSV);
  const gpt = modelsInCommit(GPT_TITLE, rows);
  assert.equal(
    buildTitle(gpt, rows),
    'Gpt-6.1-Sol added to The Gamefeel Benchmark reverse-evaluation scores'
  );
});
