import { createServer } from "node:http";
import { config, checkConfig } from "./config.js";
import { store, newMemo } from "./db.js";
import { scanHoldings, findProofPayment } from "./xrpl.js";
import { board, paddle, claimSet, payoutList, swellAt, resetWaves } from "./waves.js";
import { inviteFor, startTelegram, tgEnabled } from "./tg.js";

checkConfig();

const isAddress = a => typeof a === "string" && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a);
const cleanKey = k => String(k || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ---------- simple per-IP rate limiting ----------
const hits = new Map();
function limited(ip, bucket, max, windowMs) {
  const id = `${bucket}:${ip}`;
  const now = Date.now();
  const h = hits.get(id);
  if (!h || h.reset < now) { hits.set(id, { n: 1, reset: now + windowMs }); return false; }
  h.n++;
  return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();

// ---------- helpers ----------
function cors(req, res) {
  const origin = req.headers.origin;
  const allow = config.allowedOrigins.includes("*") ? "*"
              : origin && config.allowedOrigins.includes(origin) ? origin : null;
  if (allow) {
    res.setHeader("Access-Control-Allow-Origin", allow);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-test-now");
  }
}
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 10_000) throw new Error("Body too large"); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error("Bad JSON"); }
}
// Holdings cache: re-scan the ledger at most every RESCAN_MINUTES per wallet while playing.
const holdCache = new Map();
async function holdingFor(address, force = false) {
  const c = holdCache.get(address);
  if (!force && c && Date.now() - c.at < config.rescanMinutes * 60_000) return c.h;
  const h = await scanHoldings(address);
  holdCache.set(address, { h, at: Date.now() });
  return h;
}
// Who is this key? Returns [row, holding] or an error reply.
async function player(body, ip, force = false) {
  if (limited(ip, "play", 60, 60_000)) return { err: [429, { error: "Slow down a little." }] };
  const key = cleanKey(body.key);
  const row = key.length === 8 ? store.keyByKey(key) : null;
  if (!row) return { err: [401, { ok: false, reason: "bad_key" }] };
  const h = await holdingFor(row.address, force);
  if (!h.qualified) return { err: [403, { ok: false, reason: "below_bar", nfts: h.nfts, tokens: h.tokens }] };
  return { row, h };
}

const clientIp = req => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

// ---------- routes ----------
const routes = {
  "GET /api/health": async () => [200, { ok: true, keys: store.keyCount(), telegram: tgEnabled() }],

  // Step 1: give the wallet a memo code to send.
  "POST /api/verify/start": async (body, ip) => {
    if (limited(ip, "start", 10, 60_000)) return [429, { error: "Slow down a little and try again." }];
    const address = String(body.address || "").trim();
    if (!isAddress(address)) return [400, { error: "That doesn't look like an XRPL address." }];

    // Check holdings first (public data): don't ask for a payment if they can't qualify.
    const h = await scanHoldings(address);
    if (!h.qualified) return [200, { status: "not_qualified", nfts: h.nfts, tokens: h.tokens }];

    const now = Date.now();
    const memo = newMemo();
    const expires = now + config.challengeMinutes * 60_000;
    store.putChallenge(address, memo, now, expires);
    return [200, { status: "verify", memo, expiresAt: expires, projectWallet: config.projectWallet, nfts: h.nfts, tokens: h.tokens }];
  },

  // Step 2: look for the payment, then scan holdings and hand out the key.
  "POST /api/verify/check": async (body, ip) => {
    if (limited(ip, "check", 30, 60_000)) return [429, { error: "Slow down a little and try again." }];
    const address = String(body.address || "").trim();
    const memo = String(body.memo || "").trim().toUpperCase();
    if (!isAddress(address)) return [400, { error: "That doesn't look like an XRPL address." }];
    const ch = store.getChallenge(address);
    if (!ch || ch.memo !== memo) return [400, { error: "That memo code isn't active. Start again." }];
    if (ch.expires_at < Date.now()) return [400, { error: "That memo code expired. Start again." }];

    const hash = await findProofPayment(address, memo, ch.created_at, store.isUsedTx);
    if (!hash) return [200, { status: "waiting" }];

    store.useTx(hash, address);
    store.delChallenge(address);

    const h = await scanHoldings(address);
    if (!h.qualified) return [200, { status: "not_qualified", nfts: h.nfts, tokens: h.tokens }];
    const key = store.issueKey(address);
    store.touchKey(key, h.nfts, h.tokens);
    return [200, { status: "qualified", key, nfts: h.nfts, tokens: h.tokens }];
  },

  // Front page: check a key and re-scan the wallet behind it.
  "POST /api/enter": async (body, ip) => {
    if (limited(ip, "enter", 8, 60_000)) return [429, { error: "Too many tries. Wait a minute." }];
    const key = cleanKey(body.key);
    if (key.length !== 8) return [400, { ok: false, reason: "bad_key" }];
    const row = store.keyByKey(key);
    if (!row) return [200, { ok: false, reason: "bad_key" }];
    const h = await holdingFor(row.address, true);
    store.touchKey(key, h.nfts, h.tokens);
    const wallet = row.address.slice(0, 6) + "…" + row.address.slice(-4);
    if (!h.qualified) return [200, { ok: false, reason: "below_bar", wallet, nfts: h.nfts, tokens: h.tokens }];
    return [200, { ok: true, wallet, nfts: h.nfts, tokens: h.tokens }];
  },

  // ---------- inside the app ----------
  "POST /api/me": async (body, ip, ctx) => {
    const p = await player(body, ip);
    if (p.err) return p.err;
    return [200, { ok: true, ...board(p.row.address, p.h, ctx.now) }];
  },

  "POST /api/paddle": async (body, ip, ctx) => {
    const p = await player(body, ip);
    if (p.err) return p.err;
    const r = paddle(p.row.address, p.h.boost, ctx.now);
    return [r.ok ? 200 : 409, { ...r, board: board(p.row.address, p.h, ctx.now) }];
  },

  "POST /api/set": async (body, ip, ctx) => {
    const p = await player(body, ip);
    if (p.err) return p.err;
    const r = claimSet(p.row.address, String(body.id || ""), p.h.boost, ctx.now);
    return [r.ok ? 200 : 409, { ...r, board: board(p.row.address, p.h, ctx.now) }];
  },

  // ---------- holders-only Telegram group ----------
  "POST /api/tg/invite": async (body, ip) => {
    const p = await player(body, ip, true); // fresh scan: must hold right now
    if (p.err) return p.err;
    if (limited(ip, "tginv", 5, 10 * 60_000)) return [429, { ok: false, reason: "slow", error: "Too many invites. Try again in a few minutes." }];
    const r = await inviteFor(p.row.address);
    return [r.ok ? 200 : r.reason === "tg_off" ? 503 : 409, r];
  },

  // ---------- admin: clear test waves, keep keys ----------
  // POST /api/admin/reset-waves?token=ADMIN_TOKEN&confirm=yes
  "POST /api/admin/reset-waves": async (body, ip, ctx) => {
    if (!config.adminToken || ctx.query.get("token") !== config.adminToken) return [401, { error: "Wrong admin token" }];
    if (ctx.query.get("confirm") !== "yes") return [400, { error: "Add &confirm=yes" }];
    const cleared = resetWaves();
    return [200, { ok: true, clearedEvents: cleared, keysKept: store.keyCount() }];
  },

  // ---------- admin: who gets paid, and how much ----------
  // GET /api/admin/payout?swell=1&token=ADMIN_TOKEN   (add &format=csv for a spreadsheet)
  "GET /api/admin/payout": async (body, ip, ctx) => {
    if (!config.adminToken || ctx.query.get("token") !== config.adminToken) return [401, { error: "Wrong admin token" }];
    const current = swellAt(ctx.now);
    const n = Number(ctx.query.get("swell") || (current.open ? Math.max(1, current.n - 1) : 1));
    const list = payoutList(n);
    const ended = n < current.n || (n === current.n && ctx.now >= current.ends);
    if (ctx.query.get("format") === "csv") {
      const lines = ["address,waves,share_percent,amount_surf", ...list.payouts.map(p => `${p.address},${p.waves},${p.share},${p.amount}`)];
      return [200, lines.join("\n"), "text/csv"];
    }
    return [200, { ...list, ended, note: ended ? "Final. Safe to pay." : "This Swell is still running. Numbers will change." }];
  },
};

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  const handler = routes[`${req.method} ${path}`];
  if (!handler) return send(res, 404, { error: "Not found" });
  try {
    const body = req.method === "POST" ? await readJson(req) : {};
    const query = new URL(req.url, "http://x").searchParams;
    const testNow = config.timeTravel ? Number(req.headers["x-test-now"]) : NaN;
    const ctx = { query, now: Number.isFinite(testNow) ? testNow : Date.now() };
    const [status, out, type] = await handler(body, clientIp(req), ctx);
    if (type) { res.writeHead(status, { "content-type": type }); return res.end(out); }
    send(res, status, out);
  } catch (err) {
    console.error(`[${req.method} ${path}]`, err.message);
    send(res, 502, { error: "The ledger is slow right now. Try again in a moment." });
  }
});

server.listen(config.port, () => {
  console.log(`Surfers backend on :${config.port}`);
  startTelegram(address => holdingFor(address, true));
});
