import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const paragraphs = [
  'The developer platform now includes 100 free credits for every new account, the company announced on Monday.',
  'The credits can be used with the text, voice and image endpoints, and the offer is valid until 05/06/2026, the company said.',
  'Teams can request additional capacity after the free credits are consumed, and usage is measured per project.',
  'The company said the program is aimed at small teams that want to test the API before committing to a paid plan.',
];

function startFixture() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/feed.xml') {
      const port = server.address().port;
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>
        <item>
          <title>Get 100 free credits for the new API</title>
          <link>http://127.0.0.1:${port}/offer</link>
          <pubDate>Mon, 02 Nov 2026 16:00:00 GMT</pubDate>
          <description>Free credits for developers.</description>
        </item>
      </channel></rss>`);
      return;
    }
    if (req.url === '/offer') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head>
        <title>Free credits for developers</title>
        <meta property="og:title" content="Get 100 free credits for the new API">
        <meta property="og:description" content="Free credits for developers.">
        <meta property="article:published_time" content="2026-11-02T16:00:00Z">
        </head><body><article>
        ${paragraphs.map((text) => `<p>${text}</p>`).join('\n')}
        </article></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

function startTwoOfferFixture() {
  const server = createServer((req, res) => {
    if (req.url === '/feed.xml') {
      const port = server.address().port;
      const item = (name, title, published) => `<item>
        <title>${title}</title>
        <link>http://127.0.0.1:${port}/${name}</link>
        <pubDate>${published}</pubDate>
        <description>Free credits for developers.</description>
      </item>`;
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>
        ${item('offer-a', 'Get 100 free credits for the API', 'Mon, 02 Nov 2026 10:00:00 GMT')}
        ${item('offer-b', 'Get 200 free credits for the API', 'Mon, 02 Nov 2026 10:05:00 GMT')}
        ${item('offer-c', 'Get 300 free credits for the API', 'Mon, 02 Nov 2026 10:10:00 GMT')}
        ${item('offer-d', 'Get 400 free credits for the API', 'Mon, 02 Nov 2026 10:15:00 GMT')}
      </channel></rss>`);
      return;
    }
    if (/^\/offer-[abcd]$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head>
        <title>Free credits for developers</title>
        <meta property="og:title" content="Free credits for developers">
        <meta property="og:description" content="Free credits for developers.">
        <meta property="article:published_time" content="2026-11-02T10:00:00Z">
        </head><body><article>
        ${paragraphs.map((text) => `<p>${text}</p>`).join('\n')}
        </article></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['pipeline/run-slot.mjs', '--no-offers', ...args], {
      cwd: ROOT,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('an official offer with an ambiguous expiry is written to review, not published', async () => {
  const { server, port } = await startFixture();
  const dir = await mkdtemp(join(tmpdir(), 'qoder-offer-e2e-'));
  const sourcesPath = join(dir, 'sources.json');
  await writeFile(sourcesPath, JSON.stringify({
    version: 1,
    sources: [{
      id: 'fixture',
      name: 'Fixture Official',
      url: `http://127.0.0.1:${port}/`,
      feed_url: `http://127.0.0.1:${port}/feed.xml`,
      categories: ['tools'],
      type: 'official_blog',
      use: 'feed',
    }],
  }));

  try {
    const result = await run([
      '--slot', '20:30',
      '--now', '2026-11-02T17:00:00Z',
      '--sources-file', sourcesPath,
      '--state', join(dir, 'state.json'),
      '--main-state', join(dir, 'main.json'),
      '--review-state', join(dir, 'review-state.json'),
      '--out', join(dir, 'outbox'),
      '--review-out', join(dir, 'review'),
      '--max-candidates', '1',
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /COLLECT sources=1 items=1 .*kept=1/);
    assert.match(result.stdout, /REVIEW_REQUIRED reason=expiry_ambiguous/);
    assert.match(result.stdout, /RESULT EMPTY attempts=1 reviews=1/);
    assert.match(result.stdout, /NOTHING_WAS_SENT/);
    assert.doesNotMatch(result.stdout, /MODEL /);

    await assert.rejects(stat(join(dir, 'outbox')), /ENOENT/);

    const dayDir = join(dir, 'review', '2026-11-02');
    const entries = await readdir(dayDir);
    assert.equal(entries.length, 1);
    const reviewText = await readFile(join(dayDir, entries[0], 'review.txt'), 'utf8');
    assert.match(reviewText, /دلیل بازبینی: تاریخ انقضا روشن نیست/);
    assert.match(reviewText, /تاریخ انقضا: روشن نیست/);
    assert.match(reviewText, /127\.0\.0\.1/);

    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    const records = Object.values(state.seen);
    assert.ok(records.some((record) => record.decision === 'review' && record.reason === 'expiry_ambiguous'));
  } finally {
    server.close();
  }
});

test('the uncapped review channel sends every offer in its own run without a pending queue', async () => {
  const { server, port } = await startTwoOfferFixture();
  const dir = await mkdtemp(join(tmpdir(), 'qoder-offer-cap-'));
  const sourcesPath = join(dir, 'sources.json');
  await writeFile(sourcesPath, JSON.stringify({
    version: 1,
    sources: [{
      id: 'fixture',
      name: 'Fixture Official',
      url: `http://127.0.0.1:${port}/`,
      feed_url: `http://127.0.0.1:${port}/feed.xml`,
      categories: ['tools'],
      type: 'official_blog',
      use: 'feed',
    }],
  }));

  const args = (slot, now, date, max) => [
    '--slot', slot,
    '--now', now,
    '--date', date,
    '--sources-file', sourcesPath,
    '--state', join(dir, 'state.json'),
    '--main-state', join(dir, 'main.json'),
    '--review-state', join(dir, 'review-state.json'),
    '--out', join(dir, 'outbox'),
    '--review-out', join(dir, 'review'),
    '--max-candidates', String(max),
  ];

  try {
    const runs = [
      ['14:00', '2026-11-02T10:30:00Z', '2026-11-02'],
      ['17:00', '2026-11-02T13:30:00Z', '2026-11-02'],
      ['20:30', '2026-11-02T17:00:00Z', '2026-11-02'],
      ['23:00', '2026-11-02T19:30:00Z', '2026-11-02'],
    ];
    for (const [slot, now, date] of runs) {
      const result = await run(args(slot, now, date, 1));
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /REVIEW_REQUIRED reason=expiry_ambiguous/);
      assert.doesNotMatch(result.stdout, /REVIEW_QUEUED/);
    }

    const final = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(final.offerReviews.length, 4);
    assert.equal(Object.keys(final.reviewPending).length, 0);
    assert.ok(
      Object.values(final.seen).some(
        (record) => record.decision === 'review' && record.reason === 'expiry_ambiguous'
      )
    );
  } finally {
    server.close();
  }
});
