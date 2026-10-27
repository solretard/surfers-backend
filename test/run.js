// End-to-end test against a fake XRPL JSON-RPC server. Run: npm test
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const PROJECT = "rPRojectWa11etxxxxxxxxxxxxxxxxxxxx".replace(/[0l]/g, "a");
const NFT_ISSUER = "rNFTissuerxxxxxxxxxxxxxxxxxxxxxxx".replace(/[0l]/g, "a");
const TOKEN_ISSUER = "rT0kenIssuerxxxxxxxxxxxxxxxxxxxxx".replace(/[0lI]/g, "a");
const A = "rWha1eAxxxxxxxxxxxxxxxxxxxxxxxxxxA".replace(/[0lI]/g, "b");  // 4 NFTs
const B = "rSma11BxxxxxxxxxxxxxxxxxxxxxxxxxxB".replace(/[0lI]/g, "b");  // 1 NFT, 3200 tokens
const C = "rTokenCxxxxxxxxxxxxxxxxxxxxxxxxxxC".replace(/[0lI]/g, "b");  // 15000 tokens
const D = "rNewDxxxxxxxxxxxxxxxxxxxxxxxxxxxxD".replace(/[0lI]/g, "b");  // account not found
const SURF_HEX = Buffer.from("SURF").toString("hex").toUpperCase().padEnd(40, "0");
const RIPPLE_EPOCH = 946684800;

// ---------- fake ledger ----------
const nfts = {
  [A]: [1, 2, 3, 4].map(i => ({ Issuer: NFT_ISSUER, NFTokenTaxon: 0, NFTokenID: "A" + i })).concat([{ Issuer: "rOther", NFTokenTaxon: 0 }]),
  [B]: [{ Issuer: NFT_ISSUER, NFTokenTaxon: 0 }, { Issuer: NFT_ISSUER, NFTokenTaxon: 9 }],
  [C]: [],
};
const lines = {
  [A]: [],
  [B]: [{ account: TOKEN_ISSUER, currency: SURF_HEX, balance: "3200" }],
  [C]: [{ account: TOKEN_ISSUER, currency: SURF_HEX, balance: "15000.5" }, { account: "rX", currency: "USD", balance: "99999" }],
};
let txs = []; // newest first
let txn = 0;
function pay(from, memo, opts = {}) {
  const hash = "H" + (++txn).toString().padStart(63, "0");
  const nowRipple = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;
  const tx = {
    TransactionType: "Payment", Account: from, Destination: opts.dest || PROJECT, Amount: "1",
    Memos: [{ Memo: { MemoData: Buffer.from(memo).toString("hex").toUpperCase() } }],
  };
  const entry = opts.v2
    ? { tx_json: tx, hash, close_time_iso: new Date().toISOString(), meta: { TransactionResult: opts.result || "tesSUCCESS" }, validated: opts.validated ?? true }
    : { tx: { ...tx, hash, date: nowRipple }, meta: { TransactionResult: opts.result || "tesSUCCESS" }, validated: opts.validated ?? true };
  txs.unshift(entry);
  return hash;
}
let rpcCalls = 0;
const fake = createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const { method, params: [p] } = JSON.parse(raw);
  rpcCalls++;
  const out = r => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result: r })); };
  if (method === "account_nfts") {
    if (!(p.account in nfts)) return out({ status: "error", error: "actNotFound" });
    return out({ status: "success", account_nfts: nfts[p.account] });
  }
  if (method === "account_lines") {
    if (!(p.account in lines)) return out({ status: "error", error: "actNotFound" });
    return out({ status: "success", lines: lines[p.account].filter(l => !p.peer || l.account === p.peer) });
  }
  if (method === "account_tx") return out({ status: "success", transactions: txs });
  out({ status: "error", error: "unknownCmd" });
});
await new Promise(r => fake.listen(4111, r));

// ---------- start backend ----------
const env = {
  ...process.env, PORT: "4222", DB_PATH: ":memory:",
  XRPL_RPC: "http://127.0.0.1:1/,http://127.0.0.1:4111/",   // first one is dead: tests failover
  PROJECT_WALLET: PROJECT, NFT_ISSUER, NFT_TAXON: "0", TOKEN_ISSUER, TOKEN_CURRENCY: "SURF",
};
const srv = spawn(process.execPath, ["--no-warnings", "server.js"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise(r => srv.stdout.on("data", d => String(d).includes("backend on") && r()));

const api = async (path, body) => {
  const r = await fetch("http://127.0.0.1:4222" + path, body
    ? { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": body._ip || "1.1.1.1" }, body: JSON.stringify(body) }
    : {});
  return { status: r.status, body: await r.json() };
};
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log("  ✓", name); };

try {
  await t("health", async () => assert.equal((await api("/api/health")).body.ok, true));

  await t("rejects a bad address", async () => {
    const r = await api("/api/verify/start", { address: "hello" });
    assert.equal(r.status, 400);
  });

  let memoA;
  await t("start gives a memo code", async () => {
    const r = await api("/api/verify/start", { address: A });
    assert.equal(r.status, 200); assert.equal(r.body.status, "verify"); assert.match(r.body.memo, /^SURF-[A-Z2-9]{6}$/);
    assert.equal(r.body.projectWallet, PROJECT);
    memoA = r.body.memo;
  });

  await t("waiting before any payment", async () => {
    assert.equal((await api("/api/verify/check", { address: A, memo: memoA })).body.status, "waiting");
  });

  await t("ignores: wrong sender, wrong memo, failed tx, unvalidated, wrong destination", async () => {
    pay(B, memoA); pay(A, "SURF-WRONG1"); pay(A, memoA, { result: "tecUNFUNDED" });
    pay(A, memoA, { validated: false }); pay(A, memoA, { dest: "rSomeoneElse" });
    assert.equal((await api("/api/verify/check", { address: A, memo: memoA })).body.status, "waiting");
  });

  let keyA;
  await t("qualified with 4 NFTs → gets an 8-char key", async () => {
    pay(A, memoA);
    const r = await api("/api/verify/check", { address: A, memo: memoA });
    assert.equal(r.body.status, "qualified"); assert.equal(r.body.nfts, 4); assert.equal(r.body.tokens, 0);
    assert.match(r.body.key, /^[A-HJ-NP-Z2-9]{8}$/);
    keyA = r.body.key;
  });

  await t("memo can't be reused after success", async () => {
    assert.equal((await api("/api/verify/check", { address: A, memo: memoA })).status, 400);
  });

  await t("same wallet verifying again gets the SAME key (one per wallet)", async () => {
    const m = (await api("/api/verify/start", { address: A })).body.memo;
    pay(A, m, { v2: true }); // API v2 response shape
    const r = await api("/api/verify/check", { address: A, memo: m });
    assert.equal(r.body.status, "qualified"); assert.equal(r.body.key, keyA);
  });

  await t("1 NFT + 3,200 $SURF → turned away at step 1, no payment asked (wrong-taxon NFT not counted)", async () => {
    const r = await api("/api/verify/start", { address: B });
    assert.deepEqual(r.body, { status: "not_qualified", nfts: 1, tokens: 3200 });
  });

  let keyC;
  await t("15,000 $SURF (hex currency) → qualified", async () => {
    const m = (await api("/api/verify/start", { address: C })).body.memo;
    pay(C, m);
    const r = await api("/api/verify/check", { address: C, memo: m });
    assert.equal(r.body.status, "qualified"); assert.equal(r.body.tokens, 15000.5);
    assert.notEqual(r.body.key, keyA); keyC = r.body.key;
  });

  await t("brand-new wallet (not on ledger) → turned away at step 1, no crash", async () => {
    assert.deepEqual((await api("/api/verify/start", { address: D })).body, { status: "not_qualified", nfts: 0, tokens: 0 });
  });

  await t("qualifies at step 1, sells before paying → not qualified at step 2", async () => {
    nfts[B] = [1, 2, 3].map(() => ({ Issuer: NFT_ISSUER, NFTokenTaxon: 0 }));
    const r1 = await api("/api/verify/start", { address: B });
    assert.equal(r1.body.status, "verify"); assert.equal(r1.body.nfts, 3);
    nfts[B] = [];
    pay(B, r1.body.memo);
    const r2 = await api("/api/verify/check", { address: B, memo: r1.body.memo });
    assert.equal(r2.body.status, "not_qualified");
  });

  await t("enter with a valid key (lowercase + dash ok)", async () => {
    const pretty = (keyA.slice(0, 4) + "-" + keyA.slice(4)).toLowerCase();
    const r = await api("/api/enter", { key: pretty, _ip: "2.2.2.2" });
    assert.equal(r.body.ok, true); assert.equal(r.body.nfts, 4);
  });

  await t("enter with an unknown key → bad_key", async () => {
    assert.deepEqual((await api("/api/enter", { key: "ZZZZZZZZ", _ip: "2.2.2.2" })).body, { ok: false, reason: "bad_key" });
  });

  await t("sold below the bar → key stops working", async () => {
    nfts[A] = nfts[A].slice(0, 2);
    const r = await api("/api/enter", { key: keyA, _ip: "2.2.2.2" });
    assert.equal(r.body.ok, false); assert.equal(r.body.reason, "below_bar"); assert.equal(r.body.nfts, 2);
  });

  await t("bought back in → key works again", async () => {
    nfts[A].push({ Issuer: NFT_ISSUER, NFTokenTaxon: 0 });
    assert.equal((await api("/api/enter", { key: keyA, _ip: "2.2.2.2" })).body.ok, true);
  });

  await t("rate limit on guessing keys", async () => {
    let last;
    for (let i = 0; i < 9; i++) last = await api("/api/enter", { key: "AAAAAAAA", _ip: "9.9.9.9" });
    assert.equal(last.status, 429);
  });

  await t("XRPL down → friendly 502, no crash", async () => {
    fake.close(); fake.closeAllConnections?.();
    const r = await api("/api/enter", { key: keyC, _ip: "3.3.3.3" });
    assert.equal(r.status, 502); assert.match(r.body.error, /ledger is slow/);
  });

  await t("currency names match in every form", async () => {
    const { currencyName } = await import("../xrpl.js");
    const std = "000000000000000000000000" + Buffer.from("DIG").toString("hex").toUpperCase() + "0000000000";
    assert.equal(currencyName("DIG"), "DIG");
    assert.equal(currencyName(std), "DIG");
    assert.equal(currencyName(Buffer.from("DIG").toString("hex").padEnd(40, "0")), "DIG");
    assert.equal(currencyName(SURF_HEX), "SURF");
    assert.equal(currencyName("surf"), "SURF");
  });

  await t("CORS preflight", async () => {
    const r = await fetch("http://127.0.0.1:4222/api/enter", { method: "OPTIONS", headers: { origin: "https://surfers.xyz" } });
    assert.equal(r.status, 204); assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });

  console.log(`\nAll ${passed} tests passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.message);
  process.exitCode = 1;
} finally {
  srv.kill(); fake.close();
}
