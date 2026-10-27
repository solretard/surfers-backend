// Waves engine tests: paddle, streaks, sets, tiers, swells, payouts. Run: npm test
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const fix = (s, ch = "b") => s.replace(/[0OIl]/g, ch);
const PROJECT = fix("rPRojectWa11etxxxxxxxxxxxxxxxxxxxx", "a");
const NFT_ISSUER = fix("rNFTissuerxxxxxxxxxxxxxxxxxxxxxxx", "a");
const TOKEN_ISSUER = fix("rT0kenIssuerxxxxxxxxxxxxxxxxxxxxx", "a");
const GROM = fix("rGr0mxxxxxxxxxxxxxxxxxxxxxxxxxxxxA");   // 3 plain NFTs → 1.5x
const PRO = fix("rPr0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxB");    // 3 NFTs incl. a Pro → 2x
const TOKY = fix("rT0kyxxxxxxxxxxxxxxxxxxxxxxxxxxxxC");   // tokens only → 1x
const SURF_HEX = Buffer.from("SURF").toString("hex").toUpperCase().padEnd(40, "0");
const PRO_ID = "000800PRO".padEnd(64, "0");
const START = Date.parse("2026-11-01T00:00:00Z");
const DAY = 864e5;
const at = (days, hours = 12) => START + days * DAY + hours * 36e5;

// ---------- fake ledger ----------
const nfts = {
  [GROM]: [1, 2, 3].map(i => ({ Issuer: NFT_ISSUER, NFTokenTaxon: 0, NFTokenID: "G" + i })),
  [PRO]: [{ Issuer: NFT_ISSUER, NFTokenTaxon: 0, NFTokenID: PRO_ID }, ...[1, 2].map(i => ({ Issuer: NFT_ISSUER, NFTokenTaxon: 0, NFTokenID: "P" + i }))],
  [TOKY]: [],
};
const lines = { [GROM]: [], [PRO]: [], [TOKY]: [{ account: TOKEN_ISSUER, currency: SURF_HEX, balance: "20000" }] };
const txs = [];
let n = 0;
const pay = (from, memo) => txs.unshift({
  tx: { TransactionType: "Payment", Account: from, Destination: PROJECT, hash: "H" + ++n, date: Math.floor(Date.now() / 1000) - 946684800,
        Memos: [{ Memo: { MemoData: Buffer.from(memo).toString("hex") } }] },
  meta: { TransactionResult: "tesSUCCESS" }, validated: true,
});
const fake = createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const { method, params: [p] } = JSON.parse(raw);
  const out = r => res.end(JSON.stringify({ result: r }));
  if (method === "account_nfts") return out({ account_nfts: nfts[p.account] || [] });
  if (method === "account_lines") return out({ lines: (lines[p.account] || []).filter(l => l.account === p.peer) });
  if (method === "account_tx") return out({ transactions: txs });
});
await new Promise(r => fake.listen(4311, r));

writeFileSync(new URL("../tiers.json", import.meta.url), JSON.stringify({ pro: [PRO_ID], legend: [] }));
const srv = spawn(process.execPath, ["--no-warnings", "server.js"], {
  env: { ...process.env, PORT: "4322", DB_PATH: ":memory:", XRPL_RPC: "http://127.0.0.1:4311/",
         PROJECT_WALLET: PROJECT, NFT_ISSUER, NFT_TAXON: "0", TOKEN_ISSUER, TOKEN_CURRENCY: "SURF",
         SWELL_START: new Date(START).toISOString(), SWELL_DAYS: "4", POOL_PER_SWELL: "3000",
         ADMIN_TOKEN: "secret123", RESCAN_MINUTES: "0", ALLOW_TIME_TRAVEL: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise(r => srv.stdout.on("data", d => String(d).includes("backend on") && r()));

let ipN = 0;
const api = async (path, body, now) => {
  const headers = { "content-type": "application/json", "x-forwarded-for": "10.0.0." + (++ipN % 250) };
  if (now) headers["x-test-now"] = String(now);
  const r = await fetch("http://127.0.0.1:4322" + path, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
};
async function keyFor(address) {
  const m = (await api("/api/verify/start", { address })).body.memo;
  pay(address, m);
  return (await api("/api/verify/check", { address, memo: m })).body.key;
}

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log("  ✓", name); };

try {
  const kG = await keyFor(GROM), kP = await keyFor(PRO), kT = await keyFor(TOKY);

  await t("tiers: 3 NFTs = GROM 1.5x, Pro NFT = PRO 2x, tokens only = SURFER 1x", async () => {
    const g = (await api("/api/me", { key: kG }, at(0))).body;
    const p = (await api("/api/me", { key: kP }, at(0))).body;
    const k = (await api("/api/me", { key: kT }, at(0))).body;
    assert.deepEqual([g.tier, g.boost, p.tier, p.boost, k.tier, k.boost], ["GROM", 1.5, "PRO", 2, "SURFER", 1]);
  });

  await t("before Swell 1 starts: paddle and sets are locked", async () => {
    const r = await api("/api/paddle", { key: kG }, START - 3600e3);
    assert.equal(r.status, 409); assert.equal(r.body.reason, "not_open");
    assert.equal((await api("/api/set", { key: kG, id: "tg" }, START - 3600e3)).body.reason, "not_open");
  });

  await t("paddle out: +15 for GROM, once per day", async () => {
    const r = await api("/api/paddle", { key: kG }, at(0));
    assert.equal(r.body.gained, 15); assert.equal(r.body.board.waves, 15); assert.equal(r.body.board.paddledToday, true);
    const again = await api("/api/paddle", { key: kG }, at(0, 20));
    assert.equal(again.status, 409); assert.equal(again.body.reason, "already");
  });

  await t("new UTC day → can paddle again, streak grows", async () => {
    const r = await api("/api/paddle", { key: kG }, at(1, 1));
    assert.equal(r.body.streak, 2);
  });

  await t("7 days in a row → +50 streak bonus (×1.5 = 75)", async () => {
    for (let d = 2; d <= 5; d++) await api("/api/paddle", { key: kG }, at(d));
    const r = await api("/api/paddle", { key: kG }, at(6));
    assert.equal(r.body.streak, 7); assert.equal(r.body.gained, 15 + 75);
  });

  await t("miss a day → streak resets to 1", async () => {
    const r = await api("/api/paddle", { key: kG }, at(8));
    assert.equal(r.body.streak, 1);
    assert.equal((await api("/api/me", { key: kG }, at(8))).body.streak, 1);
  });

  await t("one-time set: claim once, never again", async () => {
    const r = await api("/api/set", { key: kP, id: "tg" }, at(0));
    assert.equal(r.body.gained, 100); // 50 × 2x
    assert.equal((await api("/api/set", { key: kP, id: "tg" }, at(30))).body.reason, "already");
  });

  await t("weekly set: once per week, opens again next Monday", async () => {
    // START is Sunday Nov 1 2026; Monday Nov 2 starts a new week
    assert.equal((await api("/api/set", { key: kT, id: "repost" }, at(0))).body.gained, 25);
    assert.equal((await api("/api/set", { key: kT, id: "repost" }, at(0, 20))).body.reason, "already");
    assert.equal((await api("/api/set", { key: kT, id: "repost" }, at(1))).body.gained, 25);
  });

  await t("unknown set id → rejected", async () => {
    assert.equal((await api("/api/set", { key: kT, id: "free-money" }, at(1))).body.reason, "unknown_set");
  });

  await t("lineup + rank + share inside a Swell", async () => {
    // Swell 1 = days 0-3. GROM: 15+15+15+15 = 60 (days 0-3); PRO: 100; TOKY: 50
    const me = (await api("/api/me", { key: kP }, at(3, 23))).body;
    assert.equal(me.swell.n, 1);
    assert.deepEqual(me.lineup.map(r => r.waves), [100, 60, 50]);
    assert.equal(me.rank, 1); assert.equal(me.everyone, 210); assert.equal(me.surfers, 3);
    assert.equal(me.share, Math.round(100 / 210 * 3000 * 100) / 100);
    assert.equal(me.lineup[0].you, true);
  });

  await t("new Swell starts fresh (waves reset, streak carries on)", async () => {
    const me = (await api("/api/me", { key: kG }, at(4))).body;
    assert.equal(me.swell.n, 2);
    // Swell 2 = days 4-7: paddles on days 4, 5, 6 (+15 each) + 7-day bonus on day 6 (+75); day 8 is Swell 3
    assert.equal(me.waves, 120);
    assert.equal((await api("/api/me", { key: kG }, at(8))).body.swell.n, 3);
    assert.equal((await api("/api/me", { key: kG }, at(8))).body.waves, 15);
  });

  await t("sold below the bar → actions refused", async () => {
    const saved = nfts[GROM]; nfts[GROM] = [];
    const r = await api("/api/paddle", { key: kG }, at(9));
    assert.equal(r.status, 403); assert.equal(r.body.reason, "below_bar");
    nfts[GROM] = saved;
  });

  await t("bad key → 401", async () => {
    assert.equal((await api("/api/me", { key: "ZZZZZZZZ" }, at(1))).status, 401);
  });

  await t("payout list: wrong token refused", async () => {
    assert.equal((await api("/api/admin/payout?swell=1&token=nope")).status, 401);
  });

  await t("payout list for Swell 1: amounts add up to the pool, biggest first", async () => {
    const r = (await api("/api/admin/payout?swell=1&token=secret123", null, at(5))).body;
    assert.equal(r.ended, true); assert.equal(r.surfers, 3); assert.equal(r.totalWaves, 210);
    assert.equal(r.payouts[0].address, PRO);
    const sum = r.payouts.reduce((a, p) => a + p.amount, 0);
    assert.ok(sum <= 3000 && sum > 2999.99, "sum " + sum);
  });

  await t("payout list as CSV (for a spreadsheet)", async () => {
    const r = await api("/api/admin/payout?swell=1&token=secret123&format=csv", null, at(5));
    assert.match(r.body, /^address,waves,share_percent,amount_surf\n/);
    assert.equal(r.body.trim().split("\n").length, 4);
  });

  await t("payout list for a running Swell is marked not final", async () => {
    const r = (await api("/api/admin/payout?swell=2&token=secret123", null, at(5))).body;
    assert.equal(r.ended, false);
  });

  console.log(`\nAll ${passed} waves tests passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.message);
  process.exitCode = 1;
} finally {
  srv.kill(); fake.close();
  rmSync(new URL("../tiers.json", import.meta.url), { force: true });
}
