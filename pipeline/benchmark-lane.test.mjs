import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkSignals, isBenchmarkCandidate } from './benchmark-lane.mjs';

test('dedicated benchmark sources are always in the benchmark lane', () => {
  assert.equal(isBenchmarkCandidate({ sourceType: 'benchmark', title: 'Update README' }), true);
  assert.equal(isBenchmarkCandidate({ benchmark: true, title: 'خبر کوتاه' }), true);
});

test('two distinct content signals identify a benchmark update', () => {
  const cases = [
    { title: 'Gemini-4-Carbon tops The Gamefeel Benchmark with 57.5 overall' },
    {
      title:
        'مدل DeepSeek V4.1 Flash اولین اوپن‌ویتی شد که توی بنچمارک SWE-sweep از ۱٪ رد شد',
    },
    {
      title: "Google's Gemini 4 Hydrogen outscores the bigger Argon",
      summary: 'The result comes from the Artificial Analysis Intelligence Index.',
    },
    { title: 'جدول رتبه‌بندی مدل‌های زبانی به‌روز شد' },
  ];
  for (const candidate of cases) {
    assert.equal(isBenchmarkCandidate(candidate), true, candidate.title);
  }
});

test('a model launch that only names a model is not a benchmark story', () => {
  assert.equal(
    isBenchmarkCandidate({ title: 'گوگل از مدل جدید Gemini 4 Hydrogen رونمایی کرد' }),
    false
  );
  assert.equal(
    isBenchmarkCandidate({
      title: 'Google launches Gemini 4 Hydrogen',
      summary: 'The model is available today in AI Studio.',
    }),
    false
  );
  assert.equal(
    isBenchmarkCandidate({ title: 'نمرهٔ مدل جدید در آزمون ریاضی اعلام شد' }),
    false
  );
});

test('signals are counted once even when a word repeats', () => {
  assert.deepEqual(benchmarkSignals('benchmark benchmark benchmark'), ['benchmark']);
  assert.deepEqual(benchmarkSignals('SWE-sweep leaderboard scores'), [
    'leaderboard',
    'named',
    'score',
  ]);
});
