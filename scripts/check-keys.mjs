import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const TIMEOUT_MODELS = 20000;
const TIMEOUT_CHAT = 45000;

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

function redact(input) {
  let out = String(input ?? '');
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join('***');
  return out.replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function requestJson(url, { method = 'GET', headers = {}, body, timeout = TIMEOUT_MODELS } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const quota = {};
    for (const [name, value] of res.headers.entries()) {
      if (/^x-ratelimit/i.test(name) || /quota|credit/i.test(name)) quota[name] = value;
    }
    return { ok: res.ok, status: res.status, ms, json, quota, text: json === null ? redact(text) : null };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: err?.name === 'AbortError' ? 'timeout' : redact(err?.message),
    };
  } finally {
    clearTimeout(timer);
  }
}

const auth = (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

async function openaiModels(base, key) {
  const r = await requestJson(`${base}/models`, { headers: auth(key) });
  const ids = Array.isArray(r.json?.data)
    ? r.json.data.map((m) => m.id || m.name).filter(Boolean)
    : [];
  return { ...r, ids };
}

function openaiChat(base, key, model) {
  return requestJson(`${base}/chat/completions`, {
    method: 'POST',
    headers: auth(key),
    timeout: TIMEOUT_CHAT,
    body: { model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8, temperature: 0 },
  });
}

async function checkAmd() {
  const key = env.AMD_API_KEY;
  const base = (env.AMD_BASE_URL || 'https://developer.amd.com.cn/radeon/api/v1').replace(/\/$/, '');
  const models = await openaiModels(base, key);
  const known = ['DeepSeek-V4-Flash-0731', 'Qwen3.8-Flash-Next', 'MiniCPM5-1B'];
  const model =
    known.find((m) => models.ids.includes(m)) ||
    models.ids.find((id) => !/vision|minicpm-v/i.test(id)) ||
    known[0];
  const chat = await openaiChat(base, key, model);
  return { models, chat, model };
}

async function checkGroq() {
  const key = env.GROQ_API_KEY;
  const base = 'https://api.groq.com/openai/v1';
  const models = await openaiModels(base, key);
  const model =
    models.ids.find((id) => /gpt-oss-20b/.test(id)) ||
    models.ids.find((id) => /gpt-oss-120b/.test(id)) ||
    models.ids.find((id) => /llama-3\.1-8b-instant/.test(id)) ||
    models.ids[0];
  const chat = model ? await openaiChat(base, key, model) : null;
  return { models, chat, model };
}

async function checkMistral() {
  const key = env.MISTRAL_API_KEY;
  const base = 'https://api.mistral.ai/v1';
  const models = await openaiModels(base, key);
  const model = models.ids.find((id) => /mistral-small-latest/.test(id)) || models.ids[0];
  const chat = model ? await openaiChat(base, key, model) : null;
  return { models, chat, model };
}

async function checkZai() {
  const key = env.ZAI_API_KEY;
  const base = (env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4').replace(/\/$/, '');
  const models = await openaiModels(base, key);
  const preferred = models.ids.find((id) => /glm-4\.7-flash/i.test(id));
  const candidates = preferred
    ? [preferred]
    : ['glm-4.7-flash', 'glm-4.5-flash', 'glm-4-flash'];
  let chat = null;
  let model = candidates[0];
  for (const candidate of candidates.slice(0, 2)) {
    chat = await openaiChat(base, key, candidate);
    model = candidate;
    if (chat.ok) break;
  }
  return { models, chat, model };
}

async function checkJina() {
  const key = env.JINA_API_KEY;
  const r = await requestJson('https://api.jina.ai/v1/embeddings', {
    method: 'POST',
    headers: auth(key),
    timeout: TIMEOUT_CHAT,
    body: { model: 'jina-embeddings-v3', input: ['سلام'], task: 'text-matching', dimensions: 1024 },
  });
  const dims = r.json?.data?.[0]?.embedding?.length;
  return { models: { status: '-', ok: true, ids: [] }, chat: r, model: dims ? `jina-embeddings-v3 (${dims}d)` : 'jina-embeddings-v3' };
}

async function checkCohere() {
  const key = env.COHERE_API_KEY;
  const models = await requestJson('https://api.cohere.com/v1/models', { headers: auth(key) });
  const names = Array.isArray(models.json?.models) ? models.json.models.map((m) => m.name) : [];
  const model = names.find((n) => /command-a/i.test(n)) || names.find((n) => /command-r/i.test(n)) || names[0];
  const chat = model
    ? await requestJson('https://api.cohere.com/v2/chat', {
        method: 'POST',
        headers: auth(key),
        timeout: TIMEOUT_CHAT,
        body: { model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 },
      })
    : null;
  return { models, chat, model };
}

const checks = [
  ['AMD Radeon', 'AMD_API_KEY', checkAmd],
  ['Groq', 'GROQ_API_KEY', checkGroq],
  ['Mistral', 'MISTRAL_API_KEY', checkMistral],
  ['Z.ai', 'ZAI_API_KEY', checkZai],
  ['Jina', 'JINA_API_KEY', checkJina],
  ['Cohere', 'COHERE_API_KEY', checkCohere],
];

function summarize(name, envKey, fn) {
  if (!env[envKey]) return Promise.resolve({ name, key: 'missing', pass: false, note: 'no key in .env' });
  return fn()
    .then(({ models, chat, model }) => {
      const final = chat || models;
      const quota = final.quota || models.quota || {};
      const quotaNote = Object.entries(quota)
        .filter(([k]) => /remaining|limit/i.test(k))
        .slice(0, 2)
        .map(([k, v]) => `${k.replace(/^x-ratelimit-/i, '')}=${v}`)
        .join(' ');
      const errorNote = !final.ok ? redact(final.error || final.text || `HTTP ${final.status}`) : '';
      return {
        name,
        key: 'set',
        pass: Boolean(chat?.ok ?? models.ok),
        modelsStatus: models?.status ?? '-',
        modelCount: models?.ids?.length ?? 0,
        model: model || '-',
        chatStatus: chat?.status ?? '-',
        ms: final.ms ?? 0,
        note: [errorNote, quotaNote].filter(Boolean).join(' | ') || '-',
      };
    })
    .catch((err) => ({ name, key: 'set', pass: false, note: redact(err?.message) }));
}

const results = await Promise.all(checks.map(([name, envKey, fn]) => summarize(name, envKey, fn)));

const pad = (value, width) => String(value).padEnd(width);
console.log(pad('PROVIDER', 12) + pad('KEY', 9) + pad('MODELS', 12) + pad('CHAT', 8) + pad('MODEL', 30) + pad('MS', 8) + 'NOTE');
for (const r of results) {
  console.log(
    pad(r.name, 12) +
      pad(r.key, 9) +
      pad(r.modelsStatus, 12) +
      pad(r.chatStatus, 8) +
      pad(r.model, 30) +
      pad(r.ms, 8) +
      r.note
  );
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nPASS ${passed}/${results.length}`);
console.log('Wrote results/health.json');

await mkdir(resolve('results'), { recursive: true });
await writeFile(
  resolve('results/health.json'),
  JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)
);
