// Goals, streaks and badges for the household. Everything is worked out from the activity log
// (one entry per save) and the bricks already sorted; badges are never stored as "earned",
// only which ones have been celebrated already.
import * as db from './db.js';
import * as bins from './bins.js';
import { openDialog, esc, fmt } from './ui.js';

export const DEFAULT_GOAL = 50;
export const MILESTONES = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export async function getGoal() {
  const g = Number(await db.getSetting('dailyGoal'));
  return Number.isInteger(g) && g >= 1 && g <= 99999 ? g : DEFAULT_GOAL;
}
export const setGoal = (n) => db.setSetting('dailyGoal', n);

export async function loadStats(ctx = null, now = new Date()) {
  ctx = ctx || await bins.loadContext();
  const goal = await getGoal();
  const perDay = new Map();
  for (const e of await db.all('log')) {
    if (e.deleted) continue;
    const k = dayKey(new Date(e.t));
    perDay.set(k, (perDay.get(k) || 0) + (Number(e.qty) || 0));
  }
  const today = perDay.get(dayKey(now)) || 0;
  // Current streak: consecutive days with something sorted; today may still be empty.
  let cur = 0;
  let d = perDay.get(dayKey(now)) ? now : addDays(now, -1);
  while (perDay.get(dayKey(d))) { cur++; d = addDays(d, -1); }
  // Best streak ever.
  let best = 0;
  const days = [...perDay.keys()].filter((k) => perDay.get(k) > 0).sort();
  let run = 0;
  let prev = null;
  for (const k of days) {
    const dt = new Date(`${k}T12:00:00`);
    run = prev && dayKey(addDays(prev, 1)) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = dt;
  }
  const bestDay = Math.max(0, ...perDay.values());
  const goalDays = [...perDay.values()].filter((n) => n >= goal).length;
  const total = [...ctx.byBin.values()].flat().reduce((n, l) => n + l.qty, 0);
  const complete = ctx.active.filter((a) => a.neededTotal > 0 && a.heldTotal >= a.neededTotal).length;
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const dt = addDays(now, -i);
    week.push({ key: dayKey(dt), label: dt.toLocaleDateString('en-GB', { weekday: 'narrow' }), n: perDay.get(dayKey(dt)) || 0, today: i === 0 });
  }
  return { goal, today, streak: cur, best, bestDay, goalDays, total, complete, week };
}

export const BADGES = [
  ...MILESTONES.slice(0, 6).map((n, i) => ({ id: `pieces${n}`, icon: ['🧱', '🔩', '🥉', '🥈', '🥇', '👑'][i], name: `${fmt(n)} bricks`, desc: `Sort ${fmt(n)} bricks in total`, ok: (s) => s.total >= n })),
  { id: 'goal1', icon: '🎯', name: 'On target', desc: 'Reach the daily goal once', ok: (s) => s.goalDays >= 1 },
  { id: 'goal5', icon: '🔥', name: 'Goal getter', desc: 'Reach the daily goal on 5 days', ok: (s) => s.goalDays >= 5 },
  { id: 'double', icon: '⚡', name: 'Double trouble', desc: 'Sort twice the daily goal in one day', ok: (s) => s.bestDay >= 2 * s.goal },
  { id: 'big250', icon: '🚀', name: 'Big day', desc: 'Sort 250 bricks in one day', ok: (s) => s.bestDay >= 250 },
  { id: 'streak3', icon: '📅', name: '3-day streak', desc: 'Sort something 3 days in a row', ok: (s) => s.best >= 3 },
  { id: 'streak7', icon: '🌟', name: 'Week streak', desc: 'Sort something 7 days in a row', ok: (s) => s.best >= 7 },
  { id: 'streak30', icon: '🏆', name: 'Month streak', desc: 'Sort something 30 days in a row', ok: (s) => s.best >= 30 },
  { id: 'set1', icon: '🎉', name: 'First set complete', desc: 'Finish rebuilding a set', ok: (s) => s.complete >= 1 },
  { id: 'set3', icon: '🏰', name: 'Set builder', desc: 'Have 3 complete sets', ok: (s) => s.complete >= 3 },
];

export const earnedIds = (s) => BADGES.filter((b) => b.ok(s)).map((b) => b.id);

// Next total-bricks milestone and how far through it you are.
export function nextMilestone(total) {
  const next = MILESTONES.find((m) => m > total) || null;
  const prev = [...MILESTONES].reverse().find((m) => m <= total) || 0;
  return { next, prev, pct: next ? Math.round(((total - prev) / (next - prev)) * 100) : 100 };
}

// Works out what is newly earned since last time (and whether today’s goal was just reached).
// The very first call records what already exists without celebrating it.
export async function checkNew() {
  const s = await loadStats();
  const earned = earnedIds(s);
  const seen = await db.getSetting('badgesSeen');
  const found = [];
  if (!Array.isArray(seen)) {
    await db.setSetting('badgesSeen', earned);
    if (s.today >= s.goal) await db.setSetting('goalDay', dayKey(new Date()));
    return { badges: [], goal: false, stats: s };
  }
  for (const id of earned) if (!seen.includes(id)) found.push(BADGES.find((b) => b.id === id));
  if (found.length) await db.setSetting('badgesSeen', [...new Set([...seen, ...earned])]);
  let goal = false;
  if (s.today >= s.goal && (await db.getSetting('goalDay')) !== dayKey(new Date())) {
    goal = true;
    await db.setSetting('goalDay', dayKey(new Date()));
  }
  return { badges: found, goal, stats: s };
}

// Shows a pop-up if a save just earned something.
export async function celebrate() {
  let r;
  try { r = await checkNew(); } catch { return; }
  if (!r.badges.length && !r.goal) return;
  const lines = [];
  if (r.goal) lines.push(`<p class="cel-line">🎯 <strong>Daily goal reached!</strong> ${fmt(r.stats.today)} bricks today.</p>`);
  for (const b of r.badges) lines.push(`<p class="cel-line"><span class="cel-icon" aria-hidden="true">${b.icon}</span> <strong>${esc(b.name)}</strong><br><small>${esc(b.desc)}</small></p>`);
  await openDialog(`
    <h2>${r.badges.length ? 'New badge!' : 'Well done!'}</h2>
    ${lines.join('')}
    <div class="row"><button class="btn primary" value="ok">Keep going</button></div>`);
}
