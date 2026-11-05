import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyBudget, sendWindow } from './guards.mjs';

const config = {
  schedule: {
    max_posts_per_day: 6,
    quiet_hours: ['00:00', '08:30'],
  },
};

const sent = (...slots) => ({ published: slots.map((slot) => ({ slot })) });

test('daily budget counts only the slot date and stops at the cap', () => {
  const state = sent(
    '2026-11-05T08:30+03:30',
    '2026-11-05T11:30+03:30',
    '2026-11-05T14:00+03:30',
    '2026-11-04T23:00+03:30',
    '2026-11-04T20:30+03:30',
    '2026-11-04T17:00+03:30',
    '2026-11-04T14:00+03:30',
    '2026-11-04T11:30+03:30',
    '2026-11-04T08:30+03:30'
  );
  assert.deepEqual(dailyBudget({ config, state, date: '2026-11-05' }), {
    cap: 6,
    used: 3,
    remaining: 3,
    ok: true,
  });
  const full = sent(...Array.from({ length: 6 }, (_, index) => `2026-11-05T0${index}:00+03:30`));
  assert.equal(dailyBudget({ config, state: full, date: '2026-11-05' }).ok, false);
});

test('a send that crosses into quiet hours is blocked', () => {
  const state = sent('2026-11-05T20:30+03:30');
  const crossed = sendWindow({
    config,
    state,
    date: '2026-11-05',
    now: '2026-11-05T20:35:00Z',
  });
  assert.equal(crossed.reason, 'quiet_hours');
  assert.equal(crossed.ok, false);

  const inWindow = sendWindow({
    config,
    state,
    date: '2026-11-05',
    now: '2026-11-05T19:45:00Z',
  });
  assert.equal(inWindow.ok, true);
});

test('the daily cap is rechecked at send time and review sends bypass it', () => {
  const full = sent(...Array.from({ length: 6 }, (_, index) => `2026-11-05T0${index}:00+03:30`));
  const blocked = sendWindow({
    config,
    state: full,
    date: '2026-11-05',
    now: '2026-11-05T19:45:00Z',
  });
  assert.equal(blocked.reason, 'daily_cap');
  assert.equal(blocked.budget.used, 6);

  const review = sendWindow({
    config,
    state: full,
    date: '2026-11-05',
    now: '2026-11-05T20:35:00Z',
    reviewSend: true,
  });
  assert.equal(review.ok, true);
  assert.equal(review.reason, 'review_send');
});
