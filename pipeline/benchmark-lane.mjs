const SIGNALS = [
  ['benchmark', /\bbenchmarks?\b|\bbenchmarking\b|بنچمارک/iu],
  ['leaderboard', /\bleaderboards?\b|لیدربورد/iu],
  [
    'named',
    /\b(?:swe[- ]?bench|swe[- ]?sweep|gamefeel|terminal[- ]?bench|artificial analysis|lmarena|lm arena|mmlu|gpqa|humaneval|hellaswag|bigcodebench|aider|cursorbench|vending[- ]?bench|cwe[- ]?bench|graphwalks|wandr|automationbench|arc[- ]?agi)\b/iu,
  ],
  ['evaluation', /\bevals?\b|\bevaluations?\b|\bevaluated\b|ارزیابی/iu],
  ['score', /\bscores?\b|\bscored\b|\bscoring\b|\boutscores?\b|نمره|امتیاز/iu],
  ['rank', /\brank(?:s|ed|ing|ings)?\b|رتبه/iu],
  ['index', /\bindex\b|شاخص/iu],
  ['table', /جدول[\s\u200c]+(?:رتبه|امتیاز|نمره|نتایج)/u],
];

export function benchmarkSignals(value) {
  const text = String(value ?? '');
  if (!text) return [];
  return SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
}

export function isBenchmarkCandidate({ sourceType, benchmark, title, summary, messageText } = {}) {
  if (benchmark === true || sourceType === 'benchmark') return true;
  const text = [title, summary, messageText].filter(Boolean).join('\n');
  return benchmarkSignals(text).length >= 2;
}
