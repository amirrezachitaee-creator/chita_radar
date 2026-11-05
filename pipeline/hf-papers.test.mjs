import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchDailyPapers,
  isNotableOrganization,
  parseDailyPapers,
  selectDailyPapers,
} from './hf-papers.mjs';
import { collectCandidates } from './collect.mjs';
import { emptyState } from './store.mjs';

const entry = ({ id, title, publishedAt, comments = 0, org = '', summary = 'short abstract' }) => ({
  paper: {
    id,
    title,
    summary,
    publishedAt,
    submittedOnDailyAt: '2026-11-05T00:00:00.000Z',
  },
  numComments: comments,
  organization: org ? { name: org, fullname: org } : null,
});

const settings = {
  enabled: true,
  min_comments: 4,
  notable_min_comments: 2,
  max_candidates: 3,
  notable_organizations: ['tencent', 'nvidia', 'microsoft', 'meta'],
};

test('daily papers parser builds paper links and drops malformed rows', () => {
  const items = parseDailyPapers(
    JSON.stringify([
      entry({ id: '2611.00001', title: 'An LLM paper', publishedAt: '2026-11-04T00:00:00.000Z', comments: 5 }),
      entry({ id: '2611.00001', title: 'Duplicate id', publishedAt: '2026-11-04T00:00:00.000Z' }),
      { paper: { id: '', title: 'No id' } },
      { paper: { id: '2611.00002', title: '' } },
    ])
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://huggingface.co/papers/2611.00001');
  assert.equal(items[0].published, '2026-11-04T00:00:00.000Z');
  assert.equal(items[0].comments, 5);
  assert.deepEqual(parseDailyPapers('not json'), []);
});

test('abstracts drop latex escapes that would leak into review text', () => {
  const items = parseDailyPapers([
    {
      paper: {
        id: '2611.00004',
        title: 'Compression',
        summary: 'saves 41.7\\%--45.4\\% of tokens~on average',
        publishedAt: '2026-11-04T00:00:00.000Z',
      },
    },
  ]);
  assert.equal(items[0].summary, 'saves 41.7%--45.4% of tokens on average');
});

test('papers without a publication date fall back to the daily feature date', () => {
  const items = parseDailyPapers([
    { paper: { id: '2611.00003', title: 'No publish date', submittedOnDailyAt: '2026-11-05T00:00:00.000Z' } },
  ]);
  assert.equal(items[0].published, '2026-11-05T00:00:00.000Z');
  assert.equal(items[0].featuredAt, '2026-11-05T00:00:00.000Z');
});

test('notable organizations match whole tokens only', () => {
  assert.equal(isNotableOrganization('Tencent Hunyuan', settings.notable_organizations), true);
  assert.equal(isNotableOrganization('Meta AI', settings.notable_organizations), true);
  assert.equal(isNotableOrganization('Metabolic Systems Lab', settings.notable_organizations), false);
  assert.equal(isNotableOrganization('', settings.notable_organizations), false);
});

test('selection keeps high-interest papers and notable labs above a lower bar', () => {
  const selected = selectDailyPapers(
    [
      { title: 'popular independent', comments: 7, organization: '', published: '2026-11-04T00:00:00.000Z' },
      { title: 'notable lab', comments: 2, organization: 'Tencent Hunyuan', published: '2026-11-04T00:00:00.000Z' },
      { title: 'quiet independent', comments: 1, organization: '', published: '2026-11-04T00:00:00.000Z' },
      { title: 'solid independent', comments: 4, organization: '', published: '2026-11-03T00:00:00.000Z' },
    ],
    settings
  );
  assert.deepEqual(selected.map((item) => item.title), [
    'popular independent',
    'solid independent',
    'notable lab',
  ]);
});

test('selection respects the candidate cap and reports fetch errors to the collector', async () => {
  const selected = selectDailyPapers(
    Array.from({ length: 6 }, (_, index) => ({
      title: `paper ${index}`,
      comments: 10 - index,
      organization: '',
      published: '2026-11-04T00:00:00.000Z',
    })),
    settings
  );
  assert.equal(selected.length, 3);

  const result = await collectCandidates({
    sources: [{ id: 'hf-papers', name: 'HF', type: 'research_index', use: 'api', api_url: 'https://hf.example/api' }],
    state: emptyState(),
    now: '2026-11-05T15:00:00Z',
    hfPapers: { ...settings, enabled: false },
    fetchImpl: async () => {
      throw new Error('must not fetch when disabled');
    },
  });
  assert.equal(result.stats.sources, 0);
  assert.equal(result.stats.apiItems, 0);
  assert.equal(result.candidates.length, 0);

  const failed = await collectCandidates({
    sources: [{ id: 'hf-papers', name: 'HF', type: 'research_index', use: 'api', api_url: 'https://hf.example/api' }],
    state: emptyState(),
    now: '2026-11-05T15:00:00Z',
    hfPapers: settings,
    fetchImpl: async () => {
      throw new Error('HTTP 503');
    },
  });
  assert.equal(failed.stats.errors.length, 1);
  assert.equal(failed.stats.errors[0].kind, 'api');
});

test('collector turns selected daily papers into fresh model candidates', async () => {
  const payload = JSON.stringify([
    entry({
      id: '2611.00011',
      title: 'Popular LLM research paper',
      publishedAt: '2026-11-04T00:00:00.000Z',
      comments: 7,
    }),
    entry({
      id: '2611.00012',
      title: 'Tencent agent paper',
      publishedAt: '2026-11-04T06:00:00.000Z',
      comments: 2,
      org: 'Tencent Hunyuan',
    }),
    entry({
      id: '2611.00013',
      title: 'Quiet independent paper',
      publishedAt: '2026-11-04T00:00:00.000Z',
      comments: 1,
    }),
    entry({
      id: '2611.00014',
      title: 'Old but popular LLM paper',
      publishedAt: '2026-10-30T00:00:00.000Z',
      comments: 9,
    }),
  ]);

  const result = await collectCandidates({
    sources: [
      {
        id: 'hf-papers',
        name: 'Hugging Face Daily Papers',
        type: 'research_index',
        use: 'api',
        api_url: 'https://hf.example/api',
        categories: ['models'],
      },
    ],
    state: emptyState(),
    now: '2026-11-05T15:00:00Z',
    hfPapers: settings,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://hf.example/api');
      assert.match(String(options.accept), /application\/json/);
      return { text: payload, url };
    },
  });

  assert.deepEqual(result.candidates.map((candidate) => candidate.title), [
    'Popular LLM research paper',
    'Tencent agent paper',
  ]);
  assert.equal(result.candidates[0].link, 'https://huggingface.co/papers/2611.00011');
  assert.equal(result.candidates[0].categoryHint, 'models');
  assert.equal(result.candidates[0].aiCentral, true);
  assert.equal(result.candidates[0].needsReview, true);
  assert.equal(result.candidates[0].reviewReason, 'research_paper');
  assert.match(result.candidates[0].messageText, /short abstract/);
  assert.equal(result.stats.sources, 1);
  assert.equal(result.stats.apiItems, 4);
  assert.equal(result.stats.stale, 1);
  assert.equal(result.stats.kept, 2);
});

test('fetchDailyPapers reads the registered api url', async () => {
  const items = await fetchDailyPapers(
    { api_url: 'https://hf.example/daily' },
    async (url, options) => {
      assert.equal(url, 'https://hf.example/daily');
      assert.equal(options.accept, 'application/json');
      return { text: JSON.stringify([entry({ id: '2611.00021', title: 'API paper', publishedAt: '2026-11-04T00:00:00.000Z' })]) };
    }
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://huggingface.co/papers/2611.00021');
});
