import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const pages = {
  '/dir': '<!doctype html><html><body><h1>Free directory</h1><p>Curated list of free AI tools.</p></body></html>',
  '/official': '<!doctype html><html><body><h1>Official API</h1><p>Build with our models.</p></body></html>',
  '/missing': '<!doctype html><html><body><h1>Another API</h1><p>Start building today.</p></body></html>',
};

function startFixture() {
  const server = createServer((req, res) => {
    const body = pages[req.url];
    if (!body) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['pipeline/offer-watch.mjs', ...args], {
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

test('watcher baselines pages, then reports changed offers as publish or review', async () => {
  const { server, port } = await startFixture();
  const dir = await mkdtemp(join(tmpdir(), 'qoder-offer-watch-'));
  const vendorsPath = join(dir, 'vendors.json');
  await writeFile(vendorsPath, JSON.stringify({
    version: 1,
    vendors: [
      {
        id: 'dir',
        name: 'Directory',
        url: `http://127.0.0.1:${port}/dir`,
        type: 'offer_directory',
        offer_watch: true,
        discovery_only: true,
        priority: 'very_high',
      },
      {
        id: 'official',
        name: 'Official',
        url: `http://127.0.0.1:${port}/official`,
        type: 'api_provider',
        offer_watch: true,
        priority: 'high',
      },
      {
        id: 'missing',
        name: 'Missing Expiry',
        url: `http://127.0.0.1:${port}/missing`,
        type: 'api_provider',
        offer_watch: true,
        priority: 'high',
      },
    ],
  }));

  const args = ['--vendors', vendorsPath, '--out', join(dir, 'watch'), '--now', '2026-11-02T18:00:00Z'];

  try {
    const first = await run(args);
    assert.equal(first.code, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /WATCH_RESULT targets=3 fetched=3 failed=0 baseline=3 unchanged=0 changed=0 offers=0 reviews=0 skipped=0/);
    assert.match(first.stdout, /NOTHING_WAS_SENT/);

    pages['/dir'] = '<!doctype html><html><body><h1>Free directory</h1><p>New: 100 free credits for new API users, valid until December 31, 2026.</p></body></html>';
    pages['/official'] = '<!doctype html><html><body><h1>Official API</h1><p>Get 100 free credits when you sign up. Offer expires December 31, 2026.</p></body></html>';
    pages['/missing'] = '<!doctype html><html><body><h1>Another API</h1><p>Free trial available. Free credits for every new account.</p></body></html>';

    const second = await run(args);
    assert.equal(second.code, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /CHANGE dir new_lines=1/);
    assert.match(second.stdout, /OFFER dir status=review reason=source_not_official/);
    assert.match(second.stdout, /OFFER official status=publish reason=ok expiry=2026-12-31/);
    assert.match(second.stdout, /OFFER missing status=review reason=expiry_missing/);
    assert.match(second.stdout, /WATCH_RESULT targets=3 fetched=3 failed=0 baseline=0 unchanged=0 changed=3 offers=1 reviews=2 skipped=0/);
    assert.doesNotMatch(second.stdout, /MODEL|TELEGRAM/);

    const reports = (await readdir(join(dir, 'watch', 'reports'))).sort();
    assert.equal(reports.length, 2);
    const written = await Promise.all(
      reports.map(async (name) => JSON.parse(await readFile(join(dir, 'watch', 'reports', name), 'utf8')))
    );
    const report = written.find((entry) => entry.changed === 3);
    assert.ok(report, 'the changed run report must exist');
    const byId = Object.fromEntries(report.results.map((result) => [result.id, result]));
    assert.equal(byId.dir.offer.status, 'review');
    assert.equal(byId.dir.offer.reason, 'source_not_official');
    assert.equal(byId.official.offer.status, 'publish');
    assert.equal(byId.official.offer.expiry.date, '2026-12-31');
    assert.ok(byId.official.offer.expiry.remainingHours >= 24);
    assert.equal(byId.missing.offer.status, 'review');
    assert.equal(byId.missing.offer.reason, 'expiry_missing');

    pages['/official'] = '<!doctype html><html><body><h1>Official API</h1><p>Build with our models.</p></body></html>';
    const third = await run(args);
    assert.equal(third.code, 0, third.stderr || third.stdout);
    assert.match(third.stdout, /CHANGE official new_lines=1/);
    assert.doesNotMatch(third.stdout, /OFFER official/);
    assert.match(third.stdout, /WATCH_RESULT targets=3 fetched=3 failed=0 baseline=0 unchanged=2 changed=1 offers=0 reviews=0 skipped=0/);

    pages['/official'] = '<!doctype html><html><body><h1>Official API</h1><p>Get 100 free credits when you sign up. Offer expires December 31, 2026.</p></body></html>';
    const fourth = await run(args);
    assert.equal(fourth.code, 0, fourth.stderr || fourth.stdout);
    assert.match(fourth.stdout, /OFFER official status=seen reason=already_reported/);
    assert.match(fourth.stdout, /WATCH_RESULT targets=3 fetched=3 failed=0 baseline=0 unchanged=2 changed=1 offers=0 reviews=0 skipped=0/);
  } finally {
    server.close();
  }
});
