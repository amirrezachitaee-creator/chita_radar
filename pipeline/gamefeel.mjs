import { parseFeed } from './engine.mjs';

const MODEL_UPDATE = /\b(?:added|adds|added to|new model|now included|entered|scored|scores?|benchmark data|rescored|re-?scored)\b/i;

const SUB_SCORES = [
  ['create', 'create'],
  ['bugfix', 'bugfix'],
  ['gamefeel', 'gamefeel'],
  ['ideas', 'ideas'],
  ['visuals', 'visuals'],
  ['audio', 'audio'],
  ['re', 'reverse-evaluation'],
];

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const cleanCommitTitle = (value) =>
  String(value ?? '').replace(/\s*(?:…|\.\.\.)\s*$/, '').trim();

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => String(cell).trim() !== ''));
}

export function parseGamefeelCsv(text) {
  const rows = parseCsv(text);
  const header = (rows.shift() ?? []).map((name) => String(name).trim());
  const indexOf = new Map(header.map((name, index) => [name, index]));
  for (const name of ['model', 'effort', 'avg']) {
    if (!indexOf.has(name)) throw new Error(`gamefeel csv is missing ${name}`);
  }
  const value = (row, name) => {
    const index = indexOf.get(name);
    return index === undefined ? '' : String(row[index] ?? '').trim();
  };
  const num = (raw) => {
    const textValue = String(raw ?? '').trim();
    if (!textValue) return null;
    const parsed = Number(textValue.replace(/[$\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  };
  return rows
    .map((row) => ({
      model: value(row, 'model'),
      effort: value(row, 'effort'),
      lab: value(row, 'lab'),
      price: value(row, 'price_per_task_usd'),
      context: value(row, 'context'),
      create: num(value(row, 'create')),
      bugfix: num(value(row, 'bugfix')),
      gamefeel: num(value(row, 'gamefeel')),
      ideas: num(value(row, 'ideas')),
      visuals: num(value(row, 'visuals')),
      audio: num(value(row, 'audio')),
      re: num(value(row, 're')),
      avg: num(value(row, 'avg')),
      openWeights: value(row, 'open_weights'),
      sizeGb: value(row, 'size_gb'),
      reTest: value(row, 're_test'),
    }))
    .filter((row) => row.model && row.effort);
}

export function isModelUpdate(title) {
  return MODEL_UPDATE.test(String(title ?? ''));
}

export function modelsInCommit(title, rows) {
  const haystack = `-${normalize(title)}-`;
  const seen = new Set();
  const matched = [];
  for (const row of rows) {
    const key = normalize(row.model);
    if (!key || !haystack.includes(`-${key}-`)) continue;
    const id = `${row.model}|${row.effort}`;
    if (seen.has(id)) continue;
    seen.add(id);
    matched.push(row);
  }
  return matched;
}

export function buildTitle(models, rows) {
  const names = [...new Set(models.map((row) => row.model))];
  const leader = [...rows]
    .filter((row) => Number.isFinite(row.avg))
    .sort((left, right) => right.avg - left.avg)[0];
  const scored = models.filter((row) => Number.isFinite(row.avg));
  if (leader && scored.some((row) => row.model === leader.model && row.avg === leader.avg)) {
    return `${leader.model} tops The Gamefeel Benchmark with ${leader.avg} overall`;
  }
  if (scored.length === 1) {
    return `${scored[0].model} scores ${scored[0].avg} on The Gamefeel Benchmark`;
  }
  if (!scored.length) {
    return `${names.join(' and ')} added to The Gamefeel Benchmark reverse-evaluation scores`;
  }
  return `${names.join(' and ')} added to The Gamefeel Benchmark`;
}

export function buildFacts({ commit, models, rows }) {
  const ranked = rows
    .filter((row) => Number.isFinite(row.avg))
    .sort((left, right) => right.avg - left.avg);
  const lines = [
    'The Gamefeel Benchmark: a creativity benchmark for AI models on game development. Each model adds content and balance changes to 12 unpublished games, and is scored on coding, gamefeel, creativity and reverse-evaluation.',
    `Update commit (${commit.published || commit.updated || 'undated'}): ${cleanCommitTitle(commit.title)}.`,
  ];
  for (const row of models) {
    const parts = [];
    if (Number.isFinite(row.avg)) {
      const rank = ranked.indexOf(row) + 1;
      parts.push(`overall ${row.avg}/100${rank ? `, rank ${rank} of ${ranked.length}` : ''}`);
    }
    const subs = SUB_SCORES.map(([key, label]) =>
      Number.isFinite(row[key]) ? `${label} ${row[key]}` : ''
    ).filter(Boolean);
    if (subs.length) parts.push(subs.join(', '));
    if (row.price) {
      const price = Number(row.price);
      parts.push(`price per task $${Number.isFinite(price) ? price.toFixed(2) : row.price}`);
    }
    if (row.context) parts.push(`context ${row.context}`);
    if (row.openWeights === 'yes') {
      parts.push(`open weights${row.sizeGb ? `, ${row.sizeGb} GB` : ''}`);
    } else if (row.openWeights === 'no') {
      parts.push('closed weights');
    } else {
      parts.push('open weights not listed');
    }
    const meta = [row.lab, row.effort ? `effort ${row.effort}` : ''].filter(Boolean).join(', ');
    lines.push(
      `${row.model}${meta ? ` (${meta})` : ''}: ${parts.join('; ') || 'no scores published yet'}.`
    );
    if (row.reTest) lines.push(`The reverse-evaluation score comes from ${row.reTest}.`);
  }
  const top = [...rows]
    .filter((row) => Number.isFinite(row.avg))
    .sort((left, right) => right.avg - left.avg)
    .slice(0, 3);
  if (top.length) {
    lines.push(
      `Leaderboard context: ${top.map((row) => `${row.model} ${row.avg}`).join(', ')}.`
    );
  }
  return lines.join('\n');
}

export async function fetchGamefeel(source, fetchImpl, redact) {
  const feedPage = await fetchImpl(source.commits_url, {
    accept: 'application/atom+xml, application/xml, text/xml, */*',
    redact,
  });
  const commits = parseFeed(feedPage.text).filter((item) => isModelUpdate(item.title));
  if (!commits.length) return [];

  const dataPage = await fetchImpl(source.data_url, {
    accept: 'text/csv, text/plain, */*',
    redact,
  });
  const rows = parseGamefeelCsv(dataPage.text);
  const items = [];
  for (const commit of commits) {
    const models = modelsInCommit(commit.title, rows);
    if (!models.length) continue;
    items.push({
      title: buildTitle(models, rows),
      link: commit.link,
      published: commit.published || commit.updated || '',
      summary: 'The Gamefeel Benchmark scores on game development tasks.',
      messageText: buildFacts({ commit, models, rows }),
    });
  }
  return items;
}
