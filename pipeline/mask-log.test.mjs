import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecrets, maskLine } from './mask-log.mjs';

test('token-shaped values never reach a public log', () => {
  const line = [
    'Telegram https://api.telegram.org/bot123456789:AAH4xampleTOKENvalue0123456789abcdef/sendPhoto failed',
    'Authorization: Bearer abcdef0123456789abcdef',
    'keys sk-proj-abcdef0123456789 and gsk_abcdef0123456789 and AIzaSyAbcdef0123456789',
  ].join('\n');
  const masked = maskLine(line);
  assert.equal(masked.includes('123456789:AAH4'), false);
  assert.equal(masked.includes('Bearer abcdef'), false);
  assert.equal(masked.includes('sk-proj-abcdef'), false);
  assert.equal(masked.includes('gsk_abcdef'), false);
  assert.equal(masked.includes('AIzaSyAbcdef'), false);
});

test('exact secret values from the environment file are masked', () => {
  const masked = maskLine('request failed with key supersecretvalue123 and again supersecretvalue123', ['supersecretvalue123']);
  assert.equal(masked, 'request failed with key *** and again ***');
});

test('ordinary log lines stay untouched', () => {
  const line = 'SLOT 2026-11-11T17:00+03:30 | QUOTA models 9/24 | POST_READY QA 42/42';
  assert.equal(maskLine(line), line);
});

test('only secret-named environment values are loaded for masking', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, '.env');
  await writeFile(
    envPath,
    ['AMD_API_KEY=amd-secret-value', 'GROQ_API_KEY=short', 'TELEGRAM_BOT_TOKEN=123456:telegram-secret', 'TELEGRAM_CHAT_ID=1234567890', ''].join('\n')
  );
  assert.deepEqual(await loadSecrets(envPath), ['amd-secret-value', '123456:telegram-secret']);
});
