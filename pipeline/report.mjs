import { readFile, readdir, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAIN_CATEGORIES, dateKey, weekKey } from './store.mjs';
import { dailyBudget } from './guards.mjs';
import { REASON_FA } from './offers.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const WEEKDAYS_FA = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

const STATUS_FA = {
  sent: 'ارسال‌شده',
  review: 'بازبینی',
  ready: 'آماده',
  empty: 'خالی',
};

export function weekdayFa(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  if (!year || !month || !day) return '';
  return WEEKDAYS_FA[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()] ?? '';
}

function safeDate(value) {
  try {
    return dateKey(value);
  } catch {
    return '';
  }
}

function countBy(items, pick) {
  const counts = {};
  for (const item of items) {
    const key = pick(item);
    if (!key) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function slotRowsForDate(state, date) {
  const prefix = `${date}T`;
  return Object.entries(state?.slots ?? {})
    .filter(([key]) => String(key).startsWith(prefix))
    .map(([key, entry]) => ({ key, entry: entry ?? {} }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function summarizeDay({ date, state, extraStates = [], reports = [], config }) {
  const artifactBySlot = new Map();
  for (const report of reports) {
    const key = String(report?.slot ?? '');
    if (key) artifactBySlot.set(key, report);
  }

  const rows = slotRowsForDate(state, date).map(({ key, entry }) => {
    const artifact = artifactBySlot.get(key) ?? null;
    const cost = numberOrNull(entry.cost) ?? numberOrNull(artifact?.model?.cost);
    const tokens = numberOrNull(entry.tokens) ?? numberOrNull(artifact?.model?.tokens);
    return {
      slot: key.slice(11, 16),
      key,
      category: entry.category ?? artifact?.category ?? '',
      status: entry.status ?? '',
      reason: entry.reason ?? '',
      qa: entry.qa ?? (artifact?.qa ? `${artifact.qa.score}/${artifact.qa.possible}` : ''),
      cost,
      tokens,
      model: entry.model ?? artifact?.model?.name ?? '',
      title: entry.title ?? artifact?.post?.title ?? '',
      costKnown: cost !== null,
    };
  });

  const budget = dailyBudget({ config, state, date });
  const week = weekKey(date);
  const quota = MAIN_CATEGORIES.map((category) => {
    const cap = Number(config?.categories?.[category]?.weekly_quota ?? 0);
    const used = (state?.published ?? []).filter(
      (entry) => entry.week === week && entry.category === category
    ).length;
    return {
      category,
      label: config?.categories?.[category]?.label ?? category,
      cap,
      used,
      remaining: Math.max(0, cap - used),
    };
  });

  const reviewStates = [state, ...extraStates];
  const reviewMap = new Map();
  for (const lane of reviewStates) {
    for (const entry of lane?.offerReviews ?? []) {
      if (entry?.date !== date) continue;
      reviewMap.set(entry.id ?? `${entry.source}|${entry.url || entry.title}`, entry);
    }
  }
  const reviews = [...reviewMap.values()];
  const reviewReasons = countBy(reviews, (entry) => entry.reason || 'unknown');

  const pendingMap = new Map();
  for (const lane of reviewStates) {
    for (const entry of Object.values(lane?.reviewPending ?? {})) {
      if (safeDate(entry?.createdAt ?? entry?.at ?? '') !== date) continue;
      pendingMap.set(entry.id ?? `${entry.source}|${entry.url || entry.title}`, entry);
    }
  }

  const costKnownRows = rows.filter((row) => row.costKnown);
  const totals = {
    cost: costKnownRows.reduce((sum, row) => sum + row.cost, 0),
    tokens: rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0),
    costKnown: costKnownRows.length > 0,
    costMissing: rows.length - costKnownRows.length,
  };

  return {
    date,
    weekday: weekdayFa(date),
    week,
    budget,
    rows,
    quota,
    reviews,
    reviewReasons,
    pending: pendingMap.size,
    deferred: Object.keys(state?.deferred ?? {}).length,
    totals,
  };
}

export function renderReport(summary) {
  const { date, weekday, week, budget, rows, quota, reviews, reviewReasons, pending, deferred, totals } =
    summary;
  const lines = [];
  lines.push(`# گزارش روزانه ${date} (${weekday})`);
  lines.push('');
  lines.push('## ارسال و سقف روز');
  lines.push(`- ثبت‌شده امروز: ${budget.used} از ${budget.cap}`);
  if (rows.length) {
    const statuses = countBy(rows, (row) => row.status);
    const statusText = Object.entries(statuses)
      .map(([status, count]) => `${STATUS_FA[status] ?? status} ${count}`)
      .join('، ');
    lines.push(`- وضعیت اسلات‌ها: ${statusText}`);
  }
  const sentRows = rows.filter((row) => row.status === 'sent');
  if (sentRows.length) {
    const categories = countBy(sentRows, (row) =>
      summary.quota.find((item) => item.category === row.category)?.label ?? row.category
    );
    lines.push(
      `- دسته‌های ارسال‌شده: ${Object.entries(categories)
        .map(([label, count]) => `${label} ${count}`)
        .join('، ')}`
    );
  }
  lines.push('');
  lines.push('## هزینه');
  if (!totals.costKnown) {
    lines.push(
      rows.length
        ? '- هزینه مدل: برای این اسلات‌ها داده‌ای ثبت نشده است.'
        : '- هزینه مدل: امروز اجرایی ثبت نشده است.'
    );
  } else {
    lines.push(`- هزینه مدل: $${totals.cost.toFixed(6)}`);
    lines.push(`- توکن: ${totals.tokens}`);
    if (sentRows.length) {
      lines.push(`- میانگین هر پست ارسال‌شده: $${(totals.cost / sentRows.length).toFixed(6)}`);
    }
    if (totals.costMissing) {
      lines.push(`- برای ${totals.costMissing} اسلات داده هزینه ثبت نشده است.`);
    }
  }
  lines.push('');
  lines.push(`## سهمیه هفتگی (هفته ${week})`);
  lines.push('| دسته | مصرف | سهمیه | باقی‌مانده |');
  lines.push('| --- | --- | --- | --- |');
  for (const item of quota) {
    lines.push(`| ${item.label} | ${item.used} | ${item.cap} | ${item.remaining} |`);
  }
  const usedTotal = quota.reduce((sum, item) => sum + item.used, 0);
  const capTotal = quota.reduce((sum, item) => sum + item.cap, 0);
  lines.push(`| مجموع | ${usedTotal} | ${capTotal} | ${Math.max(0, capTotal - usedTotal)} |`);
  lines.push('');
  lines.push('## اسلات‌های امروز');
  if (!rows.length) {
    lines.push('- اسلاتی ثبت نشده است.');
  } else {
    lines.push('| اسلات | دسته | وضعیت | کیفیت | هزینه | توکن | عنوان |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rows) {
      const label = summary.quota.find((item) => item.category === row.category)?.label ?? row.category;
      const cost = row.costKnown ? `$${row.cost.toFixed(6)}` : '—';
      const title = String(row.title ?? '').replace(/\|/g, '/');
      lines.push(
        `| ${row.slot} | ${label} | ${STATUS_FA[row.status] ?? row.status} | ${row.qa || '—'} | ${cost} | ${
          row.tokens ?? '—'
        } | ${title} |`
      );
    }
  }
  lines.push('');
  lines.push('## بازبینی');
  if (!reviews.length && !pending) {
    lines.push('- موردی ثبت نشده است.');
  } else {
    if (reviews.length) {
      lines.push(`- کپی‌های بازبینی امروز: ${reviews.length}`);
      const reasons = Object.entries(reviewReasons)
        .map(([reason, count]) => `${REASON_FA[reason] ?? reason} ${count}`)
        .join('، ');
      if (reasons) lines.push(`- دلایل: ${reasons}`);
      const eligible = reviews.filter((entry) => entry.mainEligible).length;
      if (eligible) lines.push(`- واجد شرایط کانال اصلی: ${eligible}`);
    }
    if (pending) lines.push(`- در انتظار ارسال به بازبینی: ${pending}`);
  }
  lines.push('');
  lines.push('## صف تعویق');
  lines.push(`- در انتظار: ${deferred}`);
  return `${lines.join('\n')}\n`;
}

export async function loadArtifacts({ resultsRoot, date }) {
  const outbox = resolve(resultsRoot, 'outbox', date);
  let slots = [];
  try {
    slots = await readdir(outbox);
  } catch {
    return [];
  }
  const reports = [];
  for (const slot of slots) {
    try {
      reports.push(JSON.parse(await readFile(resolve(outbox, slot, 'report.json'), 'utf8')));
    } catch {
      // a slot dir without a finished report adds nothing to the cost sum
    }
  }
  return reports;
}

async function main() {
  const args = process.argv.slice(2);
  const values = (name) => {
    const found = [];
    args.forEach((arg, index) => {
      if (arg === name && args[index + 1]) found.push(args[index + 1]);
    });
    return found;
  };
  const date = values('--date').at(-1) || dateKey(new Date());
  const statePaths = values('--state');
  if (!statePaths.length) statePaths.push('data/state.json');
  const resultsRoot = resolve(ROOT, values('--results').at(-1) || 'results');
  const outDir = resolve(ROOT, values('--out').at(-1) || 'results/reports');

  const states = [];
  for (const path of statePaths) {
    try {
      states.push(JSON.parse(await readFile(resolve(ROOT, path), 'utf8')));
    } catch (error) {
      console.error(`STATE_READ_FAILED ${path}: ${error?.message ?? error}`);
    }
  }
  if (!states.length) {
    console.error('NO_STATE');
    process.exit(1);
  }

  const config = JSON.parse(await readFile(resolve(ROOT, 'pipeline/config.json'), 'utf8'));
  const reports = await loadArtifacts({ resultsRoot, date });
  const summary = summarizeDay({
    date,
    state: states[0],
    extraStates: states.slice(1),
    reports,
    config,
  });
  const markdown = renderReport(summary);

  await mkdir(outDir, { recursive: true });
  const file = resolve(outDir, `${date}.md`);
  await writeFile(file, markdown);
  process.stdout.write(markdown);
  console.log(`REPORT_SAVED ${file}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
