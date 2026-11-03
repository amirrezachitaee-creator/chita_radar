import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, makeRedactor } from './engine.mjs';
import {
  captionLength,
  deleteMessage,
  editMessageCaption,
  formatBodyHtml,
  postHtml,
  sendText,
  TELEGRAM_CAPTION_LIMIT,
} from './telegram.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);

const DIR = resolve(ROOT, option('--dir', ''));
const MESSAGE_ID = Number(option('--message-id', '0'));
const DELETE_MESSAGE = Number(option('--delete-message', '0'));
const APPLY = flag('--apply');
const WITH_QUOTE = !flag('--no-quote');

if (!option('--dir', '') || !MESSAGE_ID) {
  console.error('USAGE --dir <run-dir> --message-id <id> [--apply] [--no-quote] [--delete-message <id>]');
  process.exit(1);
}

let env;
try {
  env = await loadEnv(resolve(ROOT, '.env'));
} catch {
  console.error('ENV_MISSING');
  process.exit(1);
}
if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
  console.error('TELEGRAM_CREDENTIALS_MISSING');
  process.exit(1);
}

const post = await (async () => {
  try {
    return JSON.parse(await readFile(resolve(DIR, 'post.json'), 'utf8'));
  } catch {
    const report = JSON.parse(await readFile(resolve(DIR, 'report.json'), 'utf8'));
    return report.post;
  }
})();
const caption = postHtml(post);
const visible = captionLength(post);
const quote = String(post.quote ?? '').trim();

console.log(`TARGET message_id=${MESSAGE_ID} caption_chars=${visible} quote_chars=${quote.length}`);
console.log(`TITLE ${post.title}`);
if (DELETE_MESSAGE) console.log(`DELETE message_id=${DELETE_MESSAGE}`);
if (visible > TELEGRAM_CAPTION_LIMIT) {
  console.error(`CAPTION_TOO_LONG ${visible}/${TELEGRAM_CAPTION_LIMIT}`);
  process.exit(1);
}
if (!APPLY) {
  console.log('DRY_RUN — NOTHING_WAS_EDITED');
  process.exit(0);
}

const redact = makeRedactor(env);
try {
  const edited = await editMessageCaption(caption, {
    token: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
    messageId: MESSAGE_ID,
  });
  console.log(`EDITED message_id=${edited.messageId}`);

  if (DELETE_MESSAGE) {
    try {
      const deleted = await deleteMessage(DELETE_MESSAGE, {
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
      });
      console.log(`DELETED message_id=${deleted.messageId}`);
    } catch (error) {
      console.error(`DELETE_FAILED ${redact(error?.message)}`);
    }
  }

  if (WITH_QUOTE && quote) {
    try {
      const quoteHtml = `<blockquote expandable>${formatBodyHtml(quote)}</blockquote>`;
      const sent = await sendText(quoteHtml, {
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
        parseMode: 'HTML',
        replyTo: MESSAGE_ID,
      });
      console.log(`QUOTE_SENT message_id=${sent.messageId}`);
    } catch (error) {
      console.log(`QUOTE_FAILED ${redact(error?.message)}`);
    }
  }
} catch (error) {
  console.error(`EDIT_FAILED ${redact(error?.message)}`);
  process.exit(1);
}
