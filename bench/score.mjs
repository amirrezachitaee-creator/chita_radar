import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const CASES = JSON.parse(await readFile(resolve('bench/cases.json'), 'utf8'));
const index = JSON.parse(await readFile(resolve('results/bench/index.json'), 'utf8'));
const caseById = new Map(CASES.map((c) => [c.id, c]));

const BANNED = [
  'باورنکردنی',
  'شوکه‌کننده',
  'شگفت‌انگیز',
  'انقلابی',
  'تاریخ‌ساز',
  'بی‌نظیر',
  'همین حالا',
  'فرصت را از دست نده',
  'در دنیای امروز',
  'همان‌طور که می‌دانید',
  'بازی را عوض می‌کند',
  'game changer',
  'game-changer',
];

const POST_TYPES = ['breaking', 'standard', 'deep', 'tutorial'];
const VERIFY = ['official', 'reported', 'rumor', 'unverified'];
const CATEGORIES = ['tools', 'models', 'security', 'business', 'education'];
const RANGES = { breaking: [150, 400], standard: [400, 900], deep: [900, 1800] };

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function lengthOk(type, len) {
  const r = RANGES[type];
  if (!r) return true;
  return len >= r[0] * 0.9 && len <= r[1] * 1.1;
}

function evaluate(rec) {
  const c = caseById.get(rec.caseId);
  const parsed = extractJson(rec.content);
  const checks = {};
  const problems = [];
  const title = String(parsed?.title ?? '').trim();
  const body = String(parsed?.body ?? '');
  const host = (() => {
    try {
      return new URL(c.url).hostname;
    } catch {
      return '';
    }
  })();

  checks.http = rec.status === 200;
  if (!checks.http) problems.push(`http:${rec.status}${rec.error ? ':' + rec.error.slice(0, 40) : ''}`);

  checks.json = Boolean(parsed);
  if (!checks.json) problems.push('json');

  const decision = parsed?.decision;
  checks.decision =
    c.expected === 'skip' ? decision === 'skip' : decision === 'publish' && parsed?.category === c.expected;
  if (!checks.decision) problems.push(`decision:${decision ?? '-'}/${parsed?.category ?? '-'}`);

  let score = 0;
  let possible = 0;
  const add = (name, ok) => {
    checks[name] = ok;
    possible++;
    if (ok) score++;
    else problems.push(name);
  };

  add('http', checks.http);
  add('json', checks.json);
  add('decision', checks.decision);

  if (!parsed) {
    return { writer: rec.writer, caseId: rec.caseId, run: rec.run, expected: c.expected, ms: rec.ms, cost: rec.cost, checks, problems, score, possible, title, body, parsed };
  }

  if (parsed.decision === 'skip') {
    add('skip_reason', typeof parsed.reason === 'string' && parsed.reason.trim().length > 0);
    add('skip_code', typeof parsed.reason_code === 'string' && parsed.reason_code.length > 0);
    return { writer: rec.writer, caseId: rec.caseId, run: rec.run, expected: c.expected, ms: rec.ms, cost: rec.cost, checks, problems, score, possible, title, body, parsed };
  }

  const words = title ? title.replace(/\u200c/g, ' ').split(/\s+/).filter(Boolean).length : 0;
  const bullets = (body.match(/^\s*[-•–]\s+/gm) || []).length;
  const tags = (body.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  const type = parsed.post_type;

  add('schema',
    POST_TYPES.includes(type) &&
      Number.isInteger(parsed.importance) && parsed.importance >= 1 && parsed.importance <= 5 &&
      VERIFY.includes(parsed.verification) &&
      CATEGORIES.includes(parsed.category) &&
      typeof parsed.source_url === 'string' && parsed.source_url.length > 0 &&
      typeof parsed.image_url === 'string' &&
      Array.isArray(parsed.key_facts) && parsed.key_facts.length >= 2 &&
      parsed.entities && Array.isArray(parsed.entities.companies) && Array.isArray(parsed.entities.models)
  );
  add('image_url', parsed.image_url === '' || /^https:\/\//.test(parsed.image_url));
  add('caption', !parsed.image_url || body.length <= 900);
  add('dedupe_key', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(parsed.dedupe_key ?? '')));
  add('title_words', words > 0 && words <= 12);
  add('title_clean', title.length > 0 && !/[.?!؟]\s*$/.test(title) && !BANNED.some((p) => title.includes(p)));
  add('bullets', type === 'breaking' ? true : bullets >= 2 && bullets <= 5);
  add('why', !(parsed.importance >= 4 && ['standard', 'deep'].includes(type)) || /چرا\s+مهم/.test(body));
  add('source', /منبع/.test(body) || (host && body.includes(host)) || body.includes(c.url));
  add('no_signature', !body.includes('✉️'));
  add('hashtags', parsed.category === 'education' ? tags <= 2 : tags === 0);
  add('length', lengthOk(type, body.length));
  add('no_banned', !BANNED.some((p) => body.includes(p)));
  add('no_placeholder', !/\[(نام|تاریخ|لینک|عدد|شرکت|منبع)\]/u.test(body));

  return { writer: rec.writer, caseId: rec.caseId, run: rec.run, expected: c.expected, ms: rec.ms, cost: rec.cost, checks, problems, score, possible, title, body, parsed };
}

const results = index.records.map(evaluate);

const byWriter = new Map();
for (const r of results) {
  if (!byWriter.has(r.writer)) byWriter.set(r.writer, []);
  byWriter.get(r.writer).push(r);
}

const summary = [];
for (const [writer, rows] of byWriter) {
  const n = rows.length;
  const httpOk = rows.filter((r) => r.checks.http).length;
  const jsonOk = rows.filter((r) => r.checks.json).length;
  const decisionOk = rows.filter((r) => r.checks.decision).length;
  const formatScore = rows.reduce((s, r) => s + r.score, 0);
  const formatPossible = rows.reduce((s, r) => s + r.possible, 0);
  const publishRows = rows.filter((r) => r.parsed?.decision === 'publish');
  const avgBody = publishRows.length
    ? Math.round(publishRows.reduce((s, r) => s + r.body.length, 0) / publishRows.length)
    : 0;
  const times = rows.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] ?? 0;
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0;
  const perCase = {};
  for (const c of CASES) {
    const runs = rows.filter((r) => r.caseId === c.id);
    perCase[c.id] = {
      decision: runs.filter((r) => r.checks.decision).length + '/' + runs.length,
      format: runs.reduce((s, r) => s + r.score, 0) + '/' + runs.reduce((s, r) => s + r.possible, 0),
    };
  }
  const problemCounts = {};
  for (const r of rows) for (const p of r.problems) problemCounts[p.split(':')[0]] = (problemCounts[p.split(':')[0]] || 0) + 1;
  summary.push({
    writer,
    calls: n,
    httpOk,
    jsonOk,
    decisionOk,
    formatPct: formatPossible ? Math.round((formatScore / formatPossible) * 100) : 0,
    avgMs: Math.round(rows.reduce((s, r) => s + r.ms, 0) / n),
    p50,
    p95,
    avgBody,
    cost: rows.reduce((s, r) => s + r.cost, 0),
    perCase,
    problems: Object.entries(problemCounts).sort((a, b) => b[1] - a[1]),
  });
}

const pad = (v, n) => String(v).padEnd(n);
console.log(pad('WRITER', 26) + pad('CALLS', 7) + pad('HTTP', 6) + pad('JSON', 6) + pad('DECISION', 10) + pad('FORMAT%', 9) + pad('P50ms', 8) + pad('P95ms', 8) + pad('BODY', 6) + 'COST');
for (const s of summary) {
  console.log(
    pad(s.writer, 26) +
      pad(s.calls, 7) +
      pad(`${s.httpOk}/${s.calls}`, 6) +
      pad(`${s.jsonOk}/${s.calls}`, 6) +
      pad(`${s.decisionOk}/${s.calls}`, 10) +
      pad(s.formatPct, 9) +
      pad(s.p50, 8) +
      pad(s.p95, 8) +
      pad(s.avgBody, 6) +
      '$' + s.cost.toFixed(4)
  );
}

console.log('\nPER CASE (decision ok, format score)');
for (const s of summary) {
  console.log(s.writer);
  for (const c of CASES) console.log(`  ${pad(c.id, 13)} ${pad(s.perCase[c.id].decision, 8)} ${s.perCase[c.id].format}`);
}

console.log('\nPROBLEMS');
for (const s of summary) console.log(`${s.writer}: ${s.problems.map(([k, v]) => `${k}x${v}`).join(' ') || 'none'}`);

await mkdir(resolve('results/bench'), { recursive: true });
await writeFile(resolve('results/bench/score.json'), JSON.stringify({ ranAt: new Date().toISOString(), summary, results }, null, 2));
console.log('\nWrote results/bench/score.json');

const BLIND_CASES = ['tools-01', 'models-01', 'security-01'];
const writerKeys = [...byWriter.keys()];
const blindKey = {};
await mkdir(resolve('results/bench/blind'), { recursive: true });

for (const caseId of BLIND_CASES) {
  const order = [...writerKeys].sort(() => Math.random() - 0.5);
  blindKey[caseId] = {};
  order.forEach((writer, i) => {
    const label = ['A', 'B', 'C'][i];
    blindKey[caseId][label] = writer;
    const row = results.find((r) => r.writer === writer && r.caseId === caseId && r.run === 1);
    const text = row?.parsed
      ? row.parsed.decision === 'skip'
        ? `رد شده — دلیل: ${row.parsed.reason || '-'}`
        : `عنوان: ${row.parsed.title}\n\n${row.parsed.body}`
      : `[خروجی نامعتبر یا خالی]\n${row?.problems?.join(', ') ?? ''}`;
    return writeFile(resolve('results/bench/blind', `${caseId}__${label}.txt`), text);
  });
}

await writeFile(resolve('results/bench/blind-key.json'), JSON.stringify(blindKey, null, 2));
console.log(`Blind set: ${BLIND_CASES.length} cases x ${writerKeys.length} writers in results/bench/blind/`);
console.log('Key saved to results/bench/blind-key.json (open only after rating)');
