import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contentHash } from './normalize.mjs';
import { decodeEntities, fetchText } from './engine.mjs';
import { detectOffer, expiryHint, extractExpiry, hasReferral, offerHint } from './offers.mjs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const OFFERS = config.offers ?? {};
const SEEN_DAYS = 90;
const MAX_LINES = 40;
const MAX_CONTENT = 6000;

const BLOCK_TAGS = /<\/(?:p|div|li|ul|ol|section|article|main|header|footer|h[1-6]|tr|table|blockquote|pre|figure|figcaption|title)>|<br\s*\/?>|<hr\s*\/?>/gi;
const HTML_HINT = /<\/?(?:html|body|head|div|p|article|section|li|ul|main|header|footer|table)\b/i;

export function pageText(input) {
  const raw = String(input ?? '').replace(/<!\[CDATA\[|\]\]>/g, ' ');
  const body = HTML_HINT.test(raw)
    ? raw
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
        .replace(BLOCK_TAGS, '\n')
        .replace(/<[^>]+>/g, ' ')
    : raw;
  return decodeEntities(body)
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function changedLines(before, after) {
  const known = new Set(String(before ?? '').split('\n'));
  return String(after ?? '')
    .split('\n')
    .filter((line) => !known.has(line) && line.length >= 12 && line.length <= 800)
    .slice(0, 200);
}

export function selectTargets(vendors, { priorities = ['very_high', 'high'], only = [] } = {}) {
  const wanted = new Set(priorities);
  return (vendors?.vendors ?? []).filter((vendor) => {
    if (!vendor.offer_watch || vendor.status === 'retired') return false;
    if (only.length > 0) return only.includes(vendor.id);
    return wanted.has(vendor.priority);
  });
}

function watchUrl(vendor) {
  const url = vendor.watch_url || vendor.offer_url || vendor.url;
  const blob = String(url).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  // blob pages carry repo chrome; raw keeps the diff on the document itself
  return blob ? `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}` : url;
}

export function offerCandidate({ vendor, lines, now }) {
  const offerLines = lines.filter((line) => offerHint(line));
  const expiryLines = lines.filter((line) => expiryHint(line) && !offerLines.includes(line));
  const picked = [...offerLines, ...expiryLines].slice(0, MAX_LINES);
  if (picked.length === 0) return null;

  const title = (offerLines[0] ?? picked[0]).slice(0, 160);
  const content = picked.join('\n').slice(0, MAX_CONTENT);
  const detection = detectOffer({ title, content });
  if (!detection.isOffer) return null;

  const expiry = extractExpiry(content, now);
  let status = 'publish';
  let reason = 'ok';

  if (vendor.discovery_only) {
    status = 'review';
    reason = 'source_not_official';
  } else if (OFFERS.referral_allowed === false && hasReferral(content)) {
    status = 'skip';
    reason = 'offer_referral';
  } else if (expiry.reason === 'expiry_expired') {
    status = 'skip';
    reason = 'offer_expired';
  } else if (!expiry.ok) {
    status = 'review';
    reason = expiry.reason;
  } else if (expiry.remainingHours < Number(OFFERS.min_remaining_hours ?? 24)) {
    status = 'review';
    reason = 'expiry_soon';
  }

  return { status, reason, title, content, detection, expiry, url: watchUrl(vendor) };
}

function pruneSeen(seen, nowMs) {
  const cutoff = nowMs - SEEN_DAYS * 864e5;
  const kept = {};
  for (const [key, value] of Object.entries(seen ?? {})) {
    const at = Date.parse(String(value?.first_seen ?? ''));
    if (!Number.isFinite(at) || at >= cutoff) kept[key] = value;
  }
  return kept;
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, targets: {}, seen: {} };
    throw error;
  }
}

export async function watchOnce({
  targets,
  now = new Date().toISOString(),
  outDir,
  fetchImpl = fetchText,
  timeout = 25000,
  log = () => {},
  statePath = '',
  snapshots = true,
  writeReport = true,
  includeBaselineOffers = false,
}) {
  const nowMs = Date.parse(String(now));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');

  const snapshotsDir = join(outDir, 'snapshots');
  const reportsDir = join(outDir, 'reports');
  await mkdir(outDir, { recursive: true });
  if (snapshots) await mkdir(snapshotsDir, { recursive: true });
  if (writeReport) await mkdir(reportsDir, { recursive: true });

  const resolvedStatePath = statePath || join(outDir, 'state.json');
  await mkdir(dirname(resolvedStatePath), { recursive: true });
  const state = await readState(resolvedStatePath);
  state.targets ??= {};
  state.seen ??= {};

  const report = {
    generated_at: new Date(nowMs).toISOString(),
    mode: 'local_watch',
    targets: targets.length,
    fetched: 0,
    failed: 0,
    baseline: 0,
    unchanged: 0,
    changed: 0,
    offers: 0,
    reviews: 0,
    skipped: 0,
    results: [],
    errors: [],
  };

  const persist = async () => {
    await writeFile(resolvedStatePath, JSON.stringify(state, null, 2));
  };

  const applyOffer = (target, lines, result, { source = 'change' } = {}) => {
    const candidate = offerCandidate({ vendor: target, lines, now: nowMs });
    if (!candidate) return null;
    const key = contentHash(`${target.id}\n${candidate.content}`);
    if (state.seen[key]) {
      result.offer = { status: 'seen', reason: 'already_reported', title: candidate.title };
      log(`OFFER ${target.id} status=seen reason=already_reported`);
      return null;
    }
    state.seen[key] = {
      vendor: target.id,
      first_seen: report.generated_at,
      status: candidate.status,
      reason: candidate.reason,
      source,
    };
    if (candidate.status === 'publish') report.offers += 1;
    else if (candidate.status === 'review') report.reviews += 1;
    else report.skipped += 1;
    result.offer = {
      status: candidate.status,
      reason: candidate.reason,
      title: candidate.title,
      url: candidate.url,
      content: candidate.content,
      expiry: candidate.expiry ?? null,
    };
    const expiryText = candidate.expiry?.date ? ` expiry=${candidate.expiry.date}` : '';
    log(`OFFER ${target.id} status=${candidate.status} reason=${candidate.reason}${expiryText}`);
    return candidate;
  };

  for (const target of targets) {
    const url = watchUrl(target);
    let text;
    try {
      const page = await fetchImpl(url, {
        accept: 'text/html, text/plain;q=0.9, */*;q=0.8',
        timeout,
      });
      text = pageText(page.text);
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 160);
      report.failed += 1;
      report.errors.push({ id: target.id, error: message });
      report.results.push({ id: target.id, name: target.name, url, status: 'error', error: message });
      log(`WATCH_ERROR ${target.id} ${message}`);
      continue;
    }

    report.fetched += 1;
    const hash = contentHash(text);
    const chars = text.length;
    const previous = state.targets[target.id];

    if (!previous) {
      state.targets[target.id] = { hash, chars, url, fetched_at: report.generated_at };
      if (snapshots) await writeFile(join(snapshotsDir, `${target.id}.txt`), text);
      await persist();
      report.baseline += 1;
      const result = { id: target.id, name: target.name, url, status: 'baseline', hash, chars };
      if (includeBaselineOffers) {
        applyOffer(target, text.split('\n').filter(Boolean).slice(0, 400), result, {
          source: 'baseline',
        });
      }
      report.results.push(result);
      log(`WATCH ${target.id} baseline chars=${chars} hash=${hash}`);
      continue;
    }

    if (previous.url && previous.url !== url) {
      state.targets[target.id] = { hash, chars, url, fetched_at: report.generated_at };
      if (snapshots) await writeFile(join(snapshotsDir, `${target.id}.txt`), text);
      await persist();
      report.baseline += 1;
      report.results.push({
        id: target.id,
        name: target.name,
        url,
        status: 'baseline',
        hash,
        chars,
        note: 'url_changed',
      });
      log(`WATCH ${target.id} rebaseline url_changed`);
      continue;
    }

    if (previous.hash === hash) {
      previous.fetched_at = report.generated_at;
      await persist();
      report.unchanged += 1;
      report.results.push({ id: target.id, name: target.name, url, status: 'unchanged', hash, chars });
      log(`WATCH ${target.id} unchanged`);
      continue;
    }

    let lines = [];
    let missingSnapshot = false;
    if (snapshots) {
      let before = '';
      try {
        before = await readFile(join(snapshotsDir, `${target.id}.txt`), 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        missingSnapshot = true;
      }
      if (!missingSnapshot) lines = changedLines(before, text);
    } else {
      lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= 12 && line.length <= 800)
        .slice(0, 400);
    }

    state.targets[target.id] = { hash, chars, url, fetched_at: report.generated_at };
    if (snapshots) await writeFile(join(snapshotsDir, `${target.id}.txt`), text);

    if (missingSnapshot) {
      await persist();
      report.baseline += 1;
      report.results.push({
        id: target.id,
        name: target.name,
        url,
        status: 'baseline',
        hash,
        chars,
        note: 'snapshot_missing',
      });
      log(`WATCH ${target.id} rebaseline snapshot_missing`);
      continue;
    }

    report.changed += 1;

    const result = {
      id: target.id,
      name: target.name,
      url,
      status: 'changed',
      hash,
      chars,
      newLines: lines.length,
      diffPreview: lines.slice(0, 8),
      offer: null,
    };
    log(`CHANGE ${target.id} new_lines=${lines.length}`);

    applyOffer(target, lines, result);

    await persist();
    report.results.push(result);
  }

  state.version = 1;
  state.updated_at = report.generated_at;
  state.seen = pruneSeen(state.seen, nowMs);
  await persist();

  const stamp = report.generated_at.replace(/[:.]/g, '-');
  const reportPath = join(reportsDir, `${stamp}-${contentHash(JSON.stringify(report))}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  report.report_path = reportPath;

  return report;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--now') args.now = argv[++index];
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--vendors') args.vendors = argv[++index];
    else if (arg === '--only') args.only = argv[++index].split(',').map((value) => value.trim()).filter(Boolean);
    else if (arg === '--limit') args.limit = Number(argv[++index]);
    else if (arg === '--timeout') args.timeout = Number(argv[++index]);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const vendorsPath = args.vendors ?? fileURLToPath(new URL('./vendors.json', import.meta.url));
  const outDir = args.out ?? fileURLToPath(new URL('../results/local/offer-watch/', import.meta.url));
  const vendors = JSON.parse(await readFile(vendorsPath, 'utf8'));
  const all = selectTargets(vendors, { only: args.only ?? [] });
  const targets = args.limit > 0 ? all.slice(0, args.limit) : all;

  const report = await watchOnce({
    targets,
    now: args.now ?? new Date().toISOString(),
    outDir,
    timeout: args.timeout ?? 25000,
    log: (line) => console.log(line),
  });

  console.log(
    `WATCH_RESULT targets=${report.targets} fetched=${report.fetched} failed=${report.failed} ` +
      `baseline=${report.baseline} unchanged=${report.unchanged} changed=${report.changed} ` +
      `offers=${report.offers} reviews=${report.reviews} skipped=${report.skipped}`
  );
  console.log(`REPORT ${report.report_path}`);
  console.log('NOTHING_WAS_SENT');
}
