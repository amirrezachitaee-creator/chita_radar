import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const TIMEOUT = 60000;
const MAX_TOKENS = 2000;
const TEMPERATURE = 0.6;
const SCREEN_CASES = ['models-01', 'thin-01'];

const env = {};
try {
  const raw = await readFile(resolve('.env'), 'utf8');
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[k] = v;
  }
} catch {
  console.error('ENV_MISSING');
  process.exit(1);
}

const secrets = Object.values(env).filter((v) => typeof v === 'string' && v.length >= 8);
const redact = (input) => {
  let out = String(input ?? '');
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join('***');
  return out.replace(/\s+/g, ' ').trim().slice(0, 200);
};

const SYSTEM = await readFile(resolve('bench/system-prompt.md'), 'utf8');
const cases = JSON.parse(await readFile(resolve('bench/cases.json'), 'utf8'));
const selected = SCREEN_CASES.map((id) => cases.find((c) => c.id === id)).filter(Boolean);

const amdBase = (env.AMD_BASE_URL || 'https://developer.amd.com.cn/radeon/api/v1').replace(/\/$/, '');
const candidates = [
  { provider: 'AMD', base: amdBase, key: env.AMD_API_KEY, model: 'DeepSeek-V4.1-Flash' },
  { provider: 'AMD', base: amdBase, key: env.AMD_API_KEY, model: 'DeepSeek-V4-Flash' },
  { provider: 'AMD', base: amdBase, key: env.AMD_API_KEY, model: 'Qwen3.8-27B' },
  { provider: 'AMD', base: amdBase, key: env.AMD_API_KEY, model: 'Gemma-4-31B-IT' },
  { provider: 'AMD', base: amdBase, key: env.AMD_API_KEY, model: 'Qwen3.8-Flash-Next' },
  { provider: 'Groq', base: 'https://api.groq.com/openai/v1', key: env.GROQ_API_KEY, model: 'openai/gpt-oss-120b' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const BANNED = ['در دنیای امروز', 'همان‌طور که می‌دانید', 'همانطور که میدانید', 'انقلابی', 'شگفت‌انگیز', 'به عنوان یک مدل زبانی', 'game changer', 'game-changer'];

async function runOne(candidate, testCase) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const user = `عنوان: ${testCase.title}\nتاریخ انتشار: ${testCase.published_at}\nلینک: ${testCase.url}\n\nمتن خبر:\n${testCase.content}`;
  try {
    const res = await fetch(`${candidate.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${candidate.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: candidate.model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const content = json?.choices?.[0]?.message?.content ?? '';
    return {
      status: res.status,
      ms: Date.now() - started,
      content,
      error: !res.ok ? (json?.error?.message ? redact(json.error.message) : redact(text)) : '',
    };
  } catch (err) {
    return {
      status: 0,
      ms: Date.now() - started,
      content: '',
      error: err?.name === 'AbortError' ? 'timeout' : redact(err?.message),
    };
  } finally {
    clearTimeout(timer);
  }
}

function score(candidate, testCase, raw) {
  const parsed = extractJson(raw.content);
  const body = typeof parsed?.body === 'string' ? parsed.body : '';
  const persianLetters = (body.match(/[\u0600-\u06FF]/g) || []).length;
  const latinLetters = (body.match(/[A-Za-z]/g) || []).length;
  const latinWords = (body.match(/[A-Za-z][A-Za-z0-9.+-]*/g) || []).length;
  const banned = BANNED.filter((p) => body.includes(p)).length;
  const hasSource = /منبع/.test(body) || body.includes('example.com') || body.includes(testCase.url);
  const jsonOk = Boolean(
    parsed &&
      (parsed.decision === 'skip' ||
        (parsed.decision === 'publish' && typeof parsed.title === 'string' && typeof parsed.category === 'string'))
  );
  const expectedOk =
    testCase.expected === 'skip'
      ? parsed?.decision === 'skip'
      : parsed?.decision === 'publish' && parsed?.category === testCase.expected;

  return {
    provider: candidate.provider,
    model: candidate.model,
    caseId: testCase.id,
    expected: testCase.expected,
    status: raw.status,
    ms: raw.ms,
    jsonOk,
    decision: parsed?.decision ?? '-',
    category: parsed?.category ?? '-',
    title: parsed?.title ?? '',
    words: body.trim() ? body.trim().split(/\s+/).length : 0,
    latinWords,
    persianRatio: persianLetters + latinLetters ? Number((persianLetters / (persianLetters + latinLetters)).toFixed(2)) : 0,
    banned,
    hasSource,
    expectedOk,
    error: raw.error || '',
    content: raw.content,
    parsed: parsed ?? null,
  };
}

const pad = (v, n) => String(v).padEnd(n);

async function pool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
      await sleep(3000);
    }
  });
  await Promise.all(runners);
}

await mkdir(resolve('results/screen'), { recursive: true });

console.log(pad('MODEL', 24) + pad('CASE', 11) + pad('HTTP', 6) + pad('MS', 8) + pad('JSON', 6) + pad('DECISION', 10) + pad('WORDS', 7) + pad('LATIN', 7) + pad('BAN', 5) + pad('SRC', 5) + 'EXP');

const results = [];
const totalStarted = Date.now();

async function handle(candidate, testCase) {
  const raw = await runOne(candidate, testCase);
  const row = score(candidate, testCase, raw);
  results.push(row);
  const safe = `${candidate.provider}-${candidate.model}-${testCase.id}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  await writeFile(resolve('results/screen', `${safe}.txt`), raw.content || raw.error || '');
  console.log(
    pad(candidate.model, 24) +
      pad(testCase.id, 11) +
      pad(row.status, 6) +
      pad(row.ms, 8) +
      pad(row.jsonOk ? 'ok' : 'bad', 6) +
      pad(row.decision, 10) +
      pad(row.words, 7) +
      pad(row.latinWords, 7) +
      pad(row.banned, 5) +
      pad(row.hasSource ? 'yes' : 'no', 5) +
      (row.expectedOk ? 'ok' : 'NO')
  );
}

const amdCandidates = candidates.filter((c) => c.provider === 'AMD');
const groqCandidates = candidates.filter((c) => c.provider === 'Groq');

for (const testCase of selected) {
  const amdTasks = amdCandidates.map((c) => ({ candidate: c, testCase }));
  await pool(amdTasks, 2, ({ candidate, testCase }) => handle(candidate, testCase));
}

for (const testCase of selected) {
  for (const candidate of groqCandidates) {
    await handle(candidate, testCase);
    await sleep(5000);
  }
}

const elapsed = Math.round((Date.now() - totalStarted) / 1000);
const passJson = results.filter((r) => r.jsonOk).length;
const passExpected = results.filter((r) => r.expectedOk).length;
console.log(`\nELAPSED ${elapsed}s | JSON_OK ${passJson}/${results.length} | EXPECTED_OK ${passExpected}/${results.length}`);

await writeFile(
  resolve('results/screen.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), elapsedSeconds: elapsed, results }, null, 2)
);
console.log('Wrote results/screen.json');
