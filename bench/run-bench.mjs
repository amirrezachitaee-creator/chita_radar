import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const RUNS = 3;
const TEMPERATURE = 0.6;
const OUT_DIR = 'results/bench/raw';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return out.replace(/\s+/g, ' ').trim().slice(0, 300);
};

const SYSTEM = (await readFile(resolve('bench/system-prompt.md'), 'utf8')).trim();
const cases = JSON.parse(await readFile(resolve('bench/cases.json'), 'utf8'));
const amdBase = (env.AMD_BASE_URL || 'https://developer.amd.com.cn/radeon/api/v1').replace(/\/$/, '');

const writers = [
  {
    key: 'amd-deepseek-v4-flash',
    provider: 'AMD',
    base: amdBase,
    apiKey: env.AMD_API_KEY,
    model: 'DeepSeek-V4-Flash',
    maxChars: 20000,
    maxTokens: 2600,
    timeoutMs: 150000,
    concurrency: 2,
    retries: 4,
    backoff: [5000, 20000, 45000],
  },
  {
    key: 'amd-deepseek-v4.1-flash',
    provider: 'AMD',
    base: amdBase,
    apiKey: env.AMD_API_KEY,
    model: 'DeepSeek-V4.1-Flash',
    maxChars: 20000,
    maxTokens: 2600,
    timeoutMs: 150000,
    concurrency: 2,
    retries: 4,
    backoff: [5000, 20000, 45000],
  },
  {
    key: 'groq-gpt-oss-120b',
    provider: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    apiKey: env.GROQ_API_KEY,
    model: 'openai/gpt-oss-120b',
    maxChars: 3000,
    maxTokens: 1600,
    timeoutMs: 90000,
    concurrency: 1,
    retries: 4,
    backoff: [60000, 90000, 120000],
  },
];

const active = writers.filter((w) => {
  if (!w.apiKey) {
    console.log(`SKIP ${w.key} (no key)`);
    return false;
  }
  return true;
});

function buildUserMessage(c, maxChars) {
  const text = String(c.content ?? '');
  const truncated = text.length > maxChars;
  const cut = truncated ? `${text.slice(0, maxChars).trimEnd()}\n\n[بریده شد]` : text;
  const host = (() => {
    try {
      return new URL(c.url).hostname;
    } catch {
      return '';
    }
  })();
  return `عنوان: ${c.title}\nتاریخ انتشار: ${c.published_at}\nلینک: ${c.url}\nنام منبع: ${host}\n\nمتن خبر:\n${cut}`;
}

async function callOnce(w, user) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), w.timeoutMs);
  try {
    const res = await fetch(`${w.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${w.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: w.model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        max_tokens: w.maxTokens,
        temperature: TEMPERATURE,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const msg = json?.choices?.[0]?.message ?? {};
    return {
      status: res.status,
      ms: Date.now() - started,
      content: typeof msg.content === 'string' ? msg.content : '',
      reasoningChars: typeof msg.reasoning_content === 'string' ? msg.reasoning_content.length : 0,
      finish: json?.choices?.[0]?.finish_reason ?? '',
      usage: json?.usage ?? null,
      error: !res.ok ? (json?.error?.message ? redact(json.error.message) : redact(text)) : '',
    };
  } catch (err) {
    return {
      status: 0,
      ms: Date.now() - started,
      content: '',
      reasoningChars: 0,
      finish: '',
      usage: null,
      error: err?.name === 'AbortError' ? 'timeout' : redact(err?.message),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callWithRetry(w, user) {
  let last = null;
  for (let attempt = 1; attempt <= w.retries; attempt++) {
    last = await callOnce(w, user);
    const hardFail = last.status === 0 || last.status === 429 || last.status >= 500;
    const emptyFirst = last.status === 200 && !last.content.trim() && attempt === 1;
    if (!hardFail && !emptyFirst) return { ...last, attempts: attempt };
    if (attempt === w.retries) break;
    const wait = hardFail ? w.backoff[Math.min(attempt - 1, w.backoff.length - 1)] : 3000;
    console.log(`  retry ${w.key} in ${Math.round(wait / 1000)}s (status ${last.status}${last.error ? ' ' + last.error.slice(0, 70) : ''})`);
    await sleep(wait);
  }
  return { ...last, attempts: w.retries };
}

async function pool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

const pad = (v, n) => String(v).padEnd(n);

await mkdir(resolve(OUT_DIR), { recursive: true });
for (const w of active) await mkdir(resolve(OUT_DIR, w.key), { recursive: true });

console.log(`SYSTEM ${SYSTEM.length} chars | CASES ${cases.length} | RUNS ${RUNS} | WRITERS ${active.length}`);
console.log(pad('WRITER', 26) + pad('CASE', 13) + pad('RUN', 5) + pad('HTTP', 6) + pad('MS', 8) + pad('ATT', 5) + pad('CHARS', 8) + pad('COST', 10) + pad('FINISH', 9) + 'ERR');

const records = [];
const startedAll = Date.now();

for (const w of active) {
  const tasks = [];
  for (let run = 1; run <= RUNS; run++) for (const c of cases) tasks.push({ c, run });
  const writerStarted = Date.now();

  await pool(tasks, w.concurrency, async ({ c, run }) => {
    const user = buildUserMessage(c, w.maxChars);
    const raw = await callWithRetry(w, user);
    const cost = Number(raw.usage?.cost ?? 0) || 0;
    const record = {
      writer: w.key,
      provider: w.provider,
      model: w.model,
      caseId: c.id,
      expected: c.expected,
      run,
      status: raw.status,
      ms: raw.ms,
      attempts: raw.attempts,
      finish: raw.finish,
      reasoningChars: raw.reasoningChars,
      usage: raw.usage,
      cost,
      error: raw.error,
      systemChars: SYSTEM.length,
      userChars: user.length,
      truncated: String(c.content ?? '').length > w.maxChars,
      content: raw.content,
      ranAt: new Date().toISOString(),
    };
    records.push(record);
    await writeFile(resolve(OUT_DIR, w.key, `${c.id}__r${run}.json`), JSON.stringify(record, null, 2));
    console.log(
      pad(w.key, 26) +
        pad(c.id, 13) +
        pad(run, 5) +
        pad(raw.status, 6) +
        pad(raw.ms, 8) +
        pad(raw.attempts, 5) +
        pad(raw.content.length, 8) +
        pad(cost ? cost.toFixed(5) : '0', 10) +
        pad(raw.finish || '-', 9) +
        (raw.error || '')
    );
  });

  const spent = records.filter((r) => r.writer === w.key).reduce((s, r) => s + r.cost, 0);
  console.log(`${w.key} done in ${Math.round((Date.now() - writerStarted) / 1000)}s | cost $${spent.toFixed(4)}`);
  await sleep(2000);
}

const elapsed = Math.round((Date.now() - startedAll) / 1000);
const totalCost = records.reduce((s, r) => s + r.cost, 0);
await writeFile(
  resolve('results/bench/index.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), elapsedSeconds: elapsed, runs: RUNS, systemChars: SYSTEM.length, totalCost, records }, null, 2)
);

const ok = records.filter((r) => r.status === 200).length;
const skipped = records.length - ok;
console.log(`\nDONE ${elapsed}s | calls ${records.length} | http_ok ${ok} | failed ${skipped} | cost $${totalCost.toFixed(4)}`);
console.log('Wrote results/bench/index.json');
