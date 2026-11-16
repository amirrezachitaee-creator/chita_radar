import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dateKey, tehranParts } from './store.mjs';
import { newsDate } from './newstime.mjs';
import { loadEnv } from './engine.mjs';
import {
  emptyHealth,
  healthCounts,
  loadHealth,
  recentHealthChanges,
  renderHealthReport,
  renderStatusMessage,
  saveHealth,
} from './source-health.mjs';
import { loadReviewStore } from './review-items.mjs';
import { sendText } from './telegram.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const STATUS_FA = {
  active: 'فعال',
  watch: 'زیر نظر',
  probation: 'آزمایشی',
  quarantined: 'کنارگذاشته',
  protected: 'حفاظت‌شده',
};

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export function statusDue({ health, now, minHour = 22, force = false }) {
  const date = dateKey(now);
  if (!force && health?.lastStatusDate === date) return { due: false, date, reason: 'already_sent' };
  const hour = tehranParts(now).hour;
  if (!force && hour < minHour) return { due: false, date, reason: `before_${minHour}` };
  return { due: true, date, reason: '' };
}

export function renderDynamicSources(dynamicDocument, health) {
  const sources = Array.isArray(dynamicDocument?.sources) ? dynamicDocument.sources : [];
  if (!sources.length) return '';
  const lines = ['منابع پویای کشف‌شده:'];
  for (const source of sources.slice(0, 8)) {
    const entry = health?.sources?.[source.id];
    const status = STATUS_FA[entry?.status] ?? STATUS_FA.active;
    const trial = source.trialUntil ? ` | آزمایش تا ${newsDate(source.trialUntil)}` : '';
    lines.push(`• ${source.name || source.id} | ${status}${trial}`);
  }
  return `${lines.join('\n')}\n`;
}

export function buildStatusCard({
  health,
  dynamicDocument,
  now,
  state,
  reviewStore,
  changes,
  runUrl = '',
}) {
  const counts = healthCounts(health);
  const dynamicCount = Array.isArray(dynamicDocument?.sources) ? dynamicDocument.sources.length : 0;
  const base = renderStatusMessage(health, {
    now,
    state,
    reviewStore,
    dynamicCount,
    changes,
  }).trimEnd();
  const dynamicBlock = renderDynamicSources(dynamicDocument, health).trimEnd();
  const parts = [base];
  if (dynamicBlock) parts.push(dynamicBlock);
  if (counts.protected) parts.push(`منابع حفاظت‌شده: ${counts.protected}`);
  if (runUrl) parts.push(`گزارش اجرا:\n${runUrl}`);
  return `${parts.join('\n\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const flag = (name) => args.includes(name);

  const config = (await readJson(resolve(ROOT, 'pipeline/config.json'))) ?? {};
  const healthPath = resolve(ROOT, option('--health', config.source_health?.state_path || 'data/source-health.json'));
  const dynamicPath = resolve(ROOT, option('--dynamic', config.source_health?.dynamic_path || 'data/sources.dynamic.json'));
  const statePath = resolve(ROOT, option('--state', 'data/state.json'));
  const reviewPath = resolve(ROOT, option('--review', 'data/review-feedback.json'));
  const outDir = resolve(ROOT, option('--out', 'results/reports'));
  const now = option('--now', new Date().toISOString());
  const date = dateKey(now);
  const send = flag('--send');
  const force = flag('--force');
  const minHour = Number(option('--min-hour', '22')) || 22;
  const runUrl = option('--run-url', '');

  let health = emptyHealth();
  try {
    health = await loadHealth(healthPath);
  } catch (error) {
    console.log(`STATUS_HEALTH_READ_FAILED ${error?.message ?? error}`);
  }
  const dynamicDocument = (await readJson(dynamicPath)) ?? { sources: [] };
  const state = await readJson(statePath);
  let reviewStore = null;
  try {
    reviewStore = await loadReviewStore(reviewPath);
  } catch {
    reviewStore = null;
  }

  const dynamicCount = Array.isArray(dynamicDocument.sources) ? dynamicDocument.sources.length : 0;
  const changes = recentHealthChanges(health, now, { hours: 48 });
  const markdown = renderHealthReport(health, {
    date,
    dynamicCount,
    changes,
    state,
    config,
  });
  await mkdir(outDir, { recursive: true });
  const reportPath = resolve(outDir, `source-health-${date}.md`);
  await writeFile(reportPath, markdown);
  console.log(`STATUS_REPORT_SAVED ${reportPath}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }

  const card = buildStatusCard({
    health,
    dynamicDocument,
    now,
    state,
    reviewStore,
    changes,
    runUrl,
  });
  console.log('STATUS_CARD_BEGIN');
  process.stdout.write(card);
  console.log('STATUS_CARD_END');

  if (!send) {
    console.log('STATUS_SKIP reason=dry');
    return;
  }
  if (!health.updatedAt && !force) {
    console.log('STATUS_SKIP reason=no_health_data');
    return;
  }
  const due = statusDue({ health, now, minHour, force });
  if (!due.due) {
    console.log(`STATUS_SKIP reason=${due.reason}`);
    return;
  }

  const env = await loadEnv(resolve(ROOT, '.env')).catch(() => ({}));
  const token = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId =
    env[config.offers?.review?.chat_env || 'TELEGRAM_REVIEW_CHAT_ID'] ||
    process.env.TELEGRAM_REVIEW_CHAT_ID ||
    '';
  if (!token || !chatId) {
    console.log('STATUS_SKIP reason=credentials_missing');
    return;
  }
  try {
    const result = await sendText(card, { token, chatId });
    health.lastStatusDate = date;
    health.lastStatusAt = new Date().toISOString();
    await saveHealth(healthPath, health);
    console.log(`STATUS_SENT message_id=${result.messageId ?? 'unknown'}`);
  } catch (error) {
    console.log(`STATUS_SEND_FAILED ${String(error?.message ?? error).slice(0, 160)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
