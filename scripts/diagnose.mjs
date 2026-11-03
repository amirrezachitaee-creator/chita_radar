import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const env = {};
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

const SYSTEM = await readFile(resolve('bench/system-prompt.md'), 'utf8');
const cases = JSON.parse(await readFile(resolve('bench/cases.json'), 'utf8'));
const testCase = cases.find((c) => c.id === 'models-01');
const base = (env.AMD_BASE_URL || 'https://developer.amd.com.cn/radeon/api/v1').replace(/\/$/, '');
const key = env.AMD_API_KEY;
const mask = (s) => String(s ?? '').split(key).join('***').replace(/\s+/g, ' ').slice(0, 700);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(model, system, user, maxTokens) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.6 }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, ms: Date.now() - started, json, text: mask(text) };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, error: err?.name === 'AbortError' ? 'timeout' : mask(err?.message) };
  } finally {
    clearTimeout(timer);
  }
}

const userMsg = `عنوان: ${testCase.title}\nتاریخ انتشار: ${testCase.published_at}\nلینک: ${testCase.url}\n\nمتن خبر:\n${testCase.content}`;

console.log('--- A: DeepSeek-V4.1-Flash minimal ---');
const a = await chat('DeepSeek-V4.1-Flash', SYSTEM, 'فقط بنویس: سلام', 50);
console.log(a.status, a.ms + 'ms', a.error || a.text);

await sleep(4000);
console.log('\n--- B: Qwen3.8-27B full, max_tokens 3500 ---');
const b = await chat('Qwen3.8-27B', SYSTEM, userMsg, 3500);
console.log(b.status, b.ms + 'ms', b.error || '');
if (b.json) {
  const choice = b.json.choices?.[0];
  const msg = choice?.message;
  console.log('finish=', choice?.finish_reason, 'usage=', JSON.stringify(b.json.usage));
  console.log('contentLen=', (msg?.content || '').length, 'reasoningLen=', (msg?.reasoning_content || msg?.reasoning || '').length);
  console.log('content=', (msg?.content || '').slice(0, 500));
  console.log('reasoning=', (msg?.reasoning_content || '').slice(0, 200));
} else {
  console.log(b.text);
}

await sleep(4000);
console.log('\n--- C: DeepSeek-V4.1-Flash full, max_tokens 2000 ---');
const c = await chat('DeepSeek-V4.1-Flash', SYSTEM, userMsg, 2000);
console.log(c.status, c.ms + 'ms', c.error || '');
if (c.json) {
  const choice = c.json.choices?.[0];
  console.log('finish=', choice?.finish_reason, 'contentLen=', (choice?.message?.content || '').length);
  console.log((choice?.message?.content || '').slice(0, 400));
} else {
  console.log(c.text);
}
