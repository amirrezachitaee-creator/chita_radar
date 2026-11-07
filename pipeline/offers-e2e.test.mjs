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
  'The credits can be used with the text, voice and image endpoints, and they expire after a limited promotional period.',
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
        ${item('offer-a', 'Get 100 free credits for the API', 'Mon, 02 Nov 2026 16:00:00 GMT')}
        ${item('offer-b', 'Get 200 free credits for the API', 'Mon, 02 Nov 2026 16:05:00 GMT')}
      </channel></rss>`);
      return;
    }
    if (req.url === '/offer-a' || req.url === '/offer-b') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head>
        <title>Free credits for developers</title>
        <meta property="og:title" content="Free credits for developers">
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

test('an official offer without a stated expiry is written to review, not published', async () => {
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
    assert.match(result.stdout, /REVIEW_REQUIRED reason=expiry_missing/);
    assert.match(result.stdout, /RESULT EMPTY attempts=1 reviews=1/);
    assert.match(result.stdout, /NOTHING_WAS_SENT/);
    assert.doesNotMatch(result.stdout, /MODEL /);

    await assert.rejects(stat(join(dir, 'outbox')), /ENOENT/);

    const dayDir = join(dir, 'review', '2026-11-02');
    const entries = await readdir(dayDir);
    assert.equal(entries.length, 1);
    const reviewText = await readFile(join(dayDir, entries[0], 'review.txt'), 'utf8');
    assert.match(reviewText, /بازبینی آفر/);
    assert.match(reviewText, /تاریخ انقضا: روشن نیست/);
    assert.match(reviewText, /127\.0\.0\.1/);

    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    const records = Object.values(state.seen);
    assert.ok(records.some((record) => record.decision === 'review' && record.reason === 'expiry_missing'));
  } finally {
    server.close();
  }
});

test('review caps queue the overflow and the next day flushes it instead of losing it', async () => {
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

  const args = (now, date) => [
    '--slot', '20:30',
    '--now', now,
    '--date', date,
    '--sources-file', sourcesPath,
    '--state', join(dir, 'state.json'),
    '--main-state', join(dir, 'main.json'),
    '--review-state', join(dir, 'review-state.json'),
    '--out', join(dir, 'outbox'),
    '--review-out', join(dir, 'review'),
    '--max-candidates', '2',
  ];

  try {
    const first = await run(args('2026-11-02T17:00:00Z', '2026-11-02'));
    assert.equal(first.code, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /REVIEW_REQUIRED reason=expiry_missing/);

    const second = await run([
      '--slot', '23:00',
      '--now', '2026-11-02T19:30:00Z',
      '--date', '2026-11-02',
      '--sources-file', sourcesPath,
      '--state', join(dir, 'state.json'),
      '--main-state', join(dir, 'main.json'),
      '--review-state', join(dir, 'review-state.json'),
      '--out', join(dir, 'outbox'),
      '--review-out', join(dir, 'review'),
      '--max-candidates', '1',
    ]);
    assert.equal(second.code, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /REVIEW_QUEUED reason=expiry_missing cap=review_source_cap/);

    const queued = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(queued.offerReviews.length, 1);
    assert.equal(Object.keys(queued.reviewPending).length, 1);

    const third = await run(args('2026-11-03T17:00:00Z', '2026-11-03'));
    assert.equal(third.code, 0, third.stderr || third.stdout);
    assert.match(third.stdout, /REVIEW_PENDING pool=1/);
    assert.match(third.stdout, /REVIEW_FLUSHED reason=expiry_missing/);
    assert.match(third.stdout, /RESULT EMPTY/);

    const flushed = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(flushed.offerReviews.length, 2);
    assert.equal(Object.keys(flushed.reviewPending).length, 0);
    assert.ok(
      Object.values(flushed.seen).some(
        (record) => record.decision === 'review' && record.reason === 'expiry_missing'
      )
    );
  } finally {
    server.close();
  }
});
