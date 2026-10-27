// Waves engine: Paddle Out, streaks, Sets, Lineup and payout lists, per Swell.
import { db } from "./db.js";
import { config } from "./config.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    address    TEXT NOT NULL,
    swell      INTEGER NOT NULL,
    kind       TEXT NOT NULL,      -- paddle | streak | set
    ref        TEXT,               -- set id, etc.
    waves      REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_swell ON events (swell, address);
  CREATE TABLE IF NOT EXISTS paddles (
    address TEXT NOT NULL,
    day     TEXT NOT NULL,         -- YYYY-MM-DD (UTC)
    PRIMARY KEY (address, day)
  );
  CREATE TABLE IF NOT EXISTS streaks (
    address  TEXT PRIMARY KEY,
    streak   INTEGER NOT NULL,
    last_day TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS set_claims (
    address TEXT NOT NULL,
    set_id  TEXT NOT NULL,
    period  TEXT NOT NULL,         -- "once" or the Monday of that week
    PRIMARY KEY (address, set_id, period)
  );
`);

// ---------- time helpers (all UTC) ----------
const DAY = 864e5;
export const dayOf = t => new Date(t).toISOString().slice(0, 10);
export function weekOf(t) {
  const d = new Date(t); const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return dayOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY);
}
export function swellAt(t) {
  const len = config.swellDays * DAY;
  if (t < config.swellStart) return { n: 1, open: false, starts: config.swellStart, ends: config.swellStart + len };
  const k = Math.floor((t - config.swellStart) / len);
  return { n: k + 1, open: true, starts: config.swellStart + k * len, ends: config.swellStart + (k + 1) * len };
}
const round = n => Math.round(n * 100) / 100;

// ---------- queries ----------
const q = {
  addEvent: db.prepare("INSERT INTO events (address, swell, kind, ref, waves, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  myWaves: db.prepare("SELECT COALESCE(SUM(waves),0) AS w FROM events WHERE swell = ? AND address = ?"),
  totals: db.prepare("SELECT COALESCE(SUM(waves),0) AS w, COUNT(DISTINCT address) AS n FROM events WHERE swell = ?"),
  board: db.prepare("SELECT address, SUM(waves) AS w FROM events WHERE swell = ? GROUP BY address ORDER BY w DESC, MIN(created_at) ASC LIMIT ?"),
  allBoard: db.prepare("SELECT address, SUM(waves) AS w FROM events WHERE swell = ? GROUP BY address ORDER BY w DESC"),
  ahead: db.prepare("SELECT COUNT(*) AS n FROM (SELECT address, SUM(waves) AS w FROM events WHERE swell = ? GROUP BY address) WHERE w > ?"),
  log: db.prepare("SELECT kind, ref, waves, created_at FROM events WHERE address = ? ORDER BY id DESC LIMIT 10"),
  paddled: db.prepare("SELECT 1 FROM paddles WHERE address = ? AND day = ?"),
  addPaddle: db.prepare("INSERT INTO paddles (address, day) VALUES (?, ?)"),
  getStreak: db.prepare("SELECT streak, last_day FROM streaks WHERE address = ?"),
  putStreak: db.prepare(`INSERT INTO streaks (address, streak, last_day) VALUES (?, ?, ?)
                         ON CONFLICT(address) DO UPDATE SET streak = excluded.streak, last_day = excluded.last_day`),
  claimed: db.prepare("SELECT 1 FROM set_claims WHERE address = ? AND set_id = ? AND period = ?"),
  addClaim: db.prepare("INSERT INTO set_claims (address, set_id, period) VALUES (?, ?, ?)"),
};

const short = a => a.slice(0, 5) + "…" + a.slice(-4);
const periodFor = (set, t) => (set.period === "weekly" ? weekOf(t) : "once");

function currentStreak(address, t) {
  const s = q.getStreak.get(address);
  if (!s) return 0;
  const today = dayOf(t), yesterday = dayOf(t - DAY);
  return s.last_day === today || s.last_day === yesterday ? s.streak : 0; // broken if a day was missed
}

// ---------- the player's whole board ----------
export function board(address, holding, t = Date.now()) {
  const sw = swellAt(t);
  const mine = q.myWaves.get(sw.n, address).w;
  const tot = q.totals.get(sw.n);
  const rank = mine > 0 ? q.ahead.get(sw.n, mine).n + 1 : null;
  const today = dayOf(t);
  return {
    wallet: short(address),
    nfts: holding.nfts, tokens: holding.tokens, tier: holding.tier, boost: holding.boost,
    swell: { ...sw, days: config.swellDays, pool: config.poolPerSwell },
    waves: round(mine), rank, everyone: round(tot.w), surfers: tot.n,
    share: tot.w > 0 ? round((mine / tot.w) * config.poolPerSwell) : 0,
    streak: currentStreak(address, t),
    paddledToday: !!q.paddled.get(address, today),
    paddleWaves: config.paddleWaves, streakBonus: config.streakBonus,
    sets: config.sets.map(s => ({ id: s.id, waves: s.waves, period: s.period, done: !!q.claimed.get(address, s.id, periodFor(s, t)) })),
    lineup: q.board.all(sw.n, 20).map(r => ({ wallet: short(r.address), waves: round(r.w), you: r.address === address })),
    log: q.log.all(address).map(e => ({ kind: e.kind, ref: e.ref, waves: round(e.waves), at: e.created_at })),
  };
}

// ---------- actions ----------
export function paddle(address, boost, t = Date.now()) {
  const sw = swellAt(t);
  if (!sw.open) return { ok: false, reason: "not_open", opensAt: sw.starts };
  const today = dayOf(t);
  if (q.paddled.get(address, today)) return { ok: false, reason: "already" };

  const prev = q.getStreak.get(address);
  const streak = prev && prev.last_day === dayOf(t - DAY) ? prev.streak + 1 : 1;
  let gained = 0;
  db.exec("BEGIN");
  try {
    q.addPaddle.run(address, today);
    q.putStreak.run(address, streak, today);
    const w = config.paddleWaves * boost; gained += w;
    q.addEvent.run(address, sw.n, "paddle", null, w, t);
    if (streak % 7 === 0) {
      const b = config.streakBonus * boost; gained += b;
      q.addEvent.run(address, sw.n, "streak", String(streak), b, t);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { ok: true, gained: round(gained), streak };
}

export function claimSet(address, setId, boost, t = Date.now()) {
  const sw = swellAt(t);
  if (!sw.open) return { ok: false, reason: "not_open", opensAt: sw.starts };
  const set = config.sets.find(s => s.id === setId);
  if (!set) return { ok: false, reason: "unknown_set" };
  const period = periodFor(set, t);
  if (q.claimed.get(address, set.id, period)) return { ok: false, reason: "already" };
  const w = set.waves * boost;
  db.exec("BEGIN");
  try {
    q.addClaim.run(address, set.id, period);
    q.addEvent.run(address, sw.n, "set", set.id, w, t);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { ok: true, gained: round(w) };
}

// ---------- payout list for one Swell ----------
export function payoutList(swellN) {
  const rows = q.allBoard.all(swellN);
  const total = rows.reduce((a, r) => a + r.w, 0);
  const pool = config.poolPerSwell;
  return {
    swell: swellN, pool, totalWaves: round(total), surfers: rows.length,
    payouts: rows.map(r => ({
      address: r.address, waves: round(r.w),
      share: total ? round((r.w / total) * 100) : 0,                       // percent
      amount: total ? Math.floor((r.w / total) * pool * 1e6) / 1e6 : 0,    // $SURF, rounded down
    })),
  };
}
