import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, makeRedactor } from './engine.mjs';
import { captionLength, sendTelegram } from './telegram.mjs';
import { newsDateLine } from './newstime.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);

const DIR = resolve(ROOT, option('--dir', ''));
const APPLY = flag('--apply');

if (!option('--dir', '')) {
  console.error('USAGE --dir <run-dir> [--apply]');
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

let post;
try {
  post = JSON.parse(await readFile(resolve(DIR, 'post.json'), 'utf8'));
} catch {
  const parsed = JSON.parse(await readFile(resolve(DIR, 'parsed.json'), 'utf8'));
  const report = JSON.parse(await readFile(resolve(DIR, 'report.json'), 'utf8'));
  post = {
    title: parsed.title,
    news_date: newsDateLine(report.item?.published_at || report.article?.published_at),
    body: parsed.body,
    quote: parsed.quote ?? '',
    image_url: parsed.image_url ?? '',
    image_file: report.image?.downloaded?.file ?? report.output?.image ?? '',
    qa: report.qa,
  };
}
const imagePath = post.image_file || '';
const visible = captionLength(post);

if (post.qa && !post.qa.pass) {
  console.error('QA_NOT_PASSED');
  process.exit(1);
}

console.log(`TITLE ${post.title}`);
console.log(`CAPTION ${visible} | IMAGE ${imagePath ? 'yes' : 'no'} | QUOTE ${String(post.quote ?? '').length}`);

if (!APPLY) {
  console.log('DRY_RUN — NOTHING_WAS_SENT');
  process.exit(0);
}

const redact = makeRedactor(env);
try {
  const sent = await sendTelegram(
    { title: post.title, news_date: post.news_date, body: post.body, quote: post.quote },
    {
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      imagePath,
    }
  );
  console.log(`SENT message_id=${sent.messageId}`);
} catch (error) {
  console.error(`SEND_FAILED ${redact(error?.message)}`);
  process.exit(1);
}
