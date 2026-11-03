import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, makeRedactor } from './engine.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SEND_TEST = process.argv.slice(2).includes('--send-test');

const env = await loadEnv(resolve(ROOT, '.env'));
const redact = makeRedactor(env);
const token = env.TELEGRAM_BOT_TOKEN || '';
const mainId = env.TELEGRAM_CHAT_ID || '';
const reviewId = env.TELEGRAM_REVIEW_CHAT_ID || '';
const base = (env.TELEGRAM_BASE_URL || 'https://api.telegram.org').replace(/\/$/, '');

const missing = [
  ['TELEGRAM_BOT_TOKEN', token],
  ['TELEGRAM_CHAT_ID', mainId],
  ['TELEGRAM_REVIEW_CHAT_ID', reviewId],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.log(`TELEGRAM_ENV_MISSING ${missing.join(',')}`);
  console.log('این کلیدها را در فایل محلی دات‌ای‌ان‌وی بگذار؛ مقدارشان را در چت نفرست.');
  process.exit(1);
}

if (mainId === reviewId) {
  console.log('TELEGRAM_CHAT_IDS_IDENTICAL کانال اصلی و پشتیبان باید دو شناسه جدا باشند');
  process.exit(1);
}

async function call(method, payload = {}) {
  const response = await fetch(`${base}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.ok) {
    throw new Error(`${method} failed: HTTP ${response.status} ${String(json?.description ?? '').slice(0, 120)}`);
  }
  return json.result;
}

try {
  const me = await call('getMe');
  console.log(`BOT @${me.username} id=${me.id} name=${me.first_name ?? ''}`);

  let canPostEverywhere = true;
  for (const [label, chatId] of [['main', mainId], ['review', reviewId]]) {
    const chat = await call('getChat', { chat_id: chatId });
    console.log(
      `CHAT ${label} id=${chat.id} type=${chat.type} title=${chat.title ?? ''} username=${chat.username ?? ''}`
    );
    const member = await call('getChatMember', { chat_id: chatId, user_id: me.id });
    const canPost =
      (member.status === 'administrator' || member.status === 'creator') && member.can_post_messages !== false;
    console.log(`ACCESS ${label} status=${member.status} can_post=${canPost}`);
    if (!canPost) canPostEverywhere = false;
  }

  if (!canPostEverywhere) {
    console.log('WARNING ربات در هر دو کانال ادمین با مجوز ارسال نیست');
  }

  if (SEND_TEST) {
    const text = [
      'تست اتصال کانال پشتیبان',
      '',
      'این پیام آزمایشی است و از خط تولید منتشر نشده.',
      'اگر این را می‌بینی، ربات به کانال پشتیبان دسترسی دارد.',
    ].join('\n');
    const result = await call('sendMessage', {
      chat_id: reviewId,
      text,
      disable_web_page_preview: true,
    });
    console.log(`TEST_SENT review message_id=${result.message_id}`);
  } else {
    console.log('NOTHING_WAS_SENT');
  }
} catch (error) {
  console.error(`TELEGRAM_CHECK_FAILED ${redact(error?.message ?? error)}`);
  process.exit(1);
}
