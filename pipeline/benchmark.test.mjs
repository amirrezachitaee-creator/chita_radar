import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeEntities,
  fetchArticleIndex,
  parseArticleIndex,
  parseLongDate,
  textOf,
} from './benchmark.mjs';
import { collectCandidates } from './collect.mjs';
import { emptyState } from './store.mjs';

const card = ({ href, title, date }) => `<a class="relative flex flex-col gap-4 group" href="${href}">
  <img src="https://cdn.example/cover.png" alt=""/>
  <div class="space-y-2">
    <h3 class="font-brand-serif">${title}</h3>
    <p class="text-xs text-muted-foreground">${date}</p>
  </div>
</a>`;

const indexHtml = [
  card({
    href: '/articles/gemini-4-carbon-new-number-1',
    title: 'Gemini 4 Carbon is the new #1 on the Intelligence Index',
    date: 'October 28, 2026',
  }),
  card({
    href: '/articles/gpt-6-1-terra-pushes-the-cost-efficiency-frontier',
    title: 'GPT-6.1 Terra pushes the cost efficiency frontier',
    date: 'Oct 26, 2026',
  }),
].join('\n');

test('the article index parser reads dated cards and skips the rest', () => {
  const items = parseArticleIndex(indexHtml, 'https://artificialanalysis.ai/articles');
  assert.deepEqual(items, [
    {
      title: 'Gemini 4 Carbon is the new #1 on the Intelligence Index',
      link: 'https://artificialanalysis.ai/articles/gemini-4-carbon-new-number-1',
      published: '2026-10-28',
      summary: '',
    },
    {
      title: 'GPT-6.1 Terra pushes the cost efficiency frontier',
      link: 'https://artificialanalysis.ai/articles/gpt-6-1-terra-pushes-the-cost-efficiency-frontier',
      published: '2026-10-26',
      summary: '',
    },
  ]);
  const undated = card({ href: '/articles/undated', title: 'No date', date: '' });
  assert.deepEqual(parseArticleIndex(undated), []);
});

test('dates, entities and inline tags are decoded', () => {
  assert.equal(parseLongDate('October 28, 2026'), '2026-10-28');
  assert.equal(parseLongDate('Sept 3, 2026'), '2026-09-03');
  assert.equal(parseLongDate('28 October 2026'), '');
  assert.equal(parseLongDate('October 2026'), '');
  assert.equal(decodeEntities('Arena&#x27;s &amp; more'), "Arena's & more");
  assert.equal(textOf('<b>Hello</b> <i>world</i>'), 'Hello world');
});

test('fetchArticleIndex reads the source index url', async () => {
  const calls = [];
  const items = await fetchArticleIndex(
    { index_url: 'https://fixture.example/articles', url: 'https://fixture.example/articles' },
    async (url) => {
      calls.push(url);
      return { text: indexHtml, url };
    }
  );
  assert.deepEqual(calls, ['https://fixture.example/articles']);
  assert.equal(items.length, 2);
});

test('a dated page source flows through the collector like a feed', async () => {
  const now = '2026-11-02T15:00:00Z';
  const fresh = card({
    href: 'https://fixture.example/articles/fresh',
    title: 'OpenAI ships a new model with benchmark gains',
    date: 'November 2, 2026',
  });
  const old = card({
    href: 'https://fixture.example/articles/old',
    title: 'An older benchmark note',
    date: 'October 20, 2026',
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'bench',
        name: 'Bench',
        type: 'benchmark',
        use: 'page',
        index_url: 'https://fixture.example/articles',
        url: 'https://fixture.example/articles',
        categories: ['models'],
      },
    ],
    state: emptyState(),
    now,
    fetchImpl: async (url) => ({ text: `${fresh}\n${old}`, url }),
  });

  assert.equal(result.stats.sources, 1);
  assert.equal(result.stats.indexItems, 2);
  assert.equal(result.stats.stale, 1);
  assert.equal(result.stats.kept, 1);
  assert.equal(result.candidates[0].title, 'OpenAI ships a new model with benchmark gains');
  assert.equal(result.candidates[0].categoryHint, 'models');
  assert.equal(result.candidates[0].sourceId, 'bench');
});
