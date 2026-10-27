// Telegram gate tests against a fake Telegram + fake ledger. Run: npm test
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const fix = s => s.replace(/[0OIl]/g, "b");
const PROJECT = fix("rPRojectWaxxetxxxxxxxxxxxxxxxxxxxx"), NFTI = fix("rNFTissuerxxxxxxxxxxxxxxxxxxxxxxx"), TOKI = fix("rTakenxssuerxxxxxxxxxxxxxxxxxxxxx");
const HOLDER = fix("rHaderxxxxxxxxxxxxxxxxxxxxxxxxxxxA"), NOPE = fix("rNapexxxxxxxxxxxxxxxxxxxxxxxxxxxxB");
const GROUP = "-1004311652019";

// ---------- fake ledger ----------
const nfts = { [HOLDER]: [{ Issuer: NFTI, NFTokenTaxon: 0, NFTokenID: "P1" }], [NOPE]: [] };
const txs = []; let n = 0;
const pay = (from, memo) => txs.unshift({ tx: { TransactionType: "Payment", Account: from, Destination: PROJECT, hash: "H" + ++n, date: Math.floor(Date.now() / 1000) - 946684800, Memos: [{ Memo: { MemoData: Buffer.from(memo).toString("hex") } }] }, meta: { TransactionResult: "tesSUCCESS" }, validated: true });
const ledger = createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const { method, params: [p] } = JSON.parse(raw); const out = r => res.end(JSON.stringify({ result: r }));
  if (method === "account_nfts") return out({ account_nfts: nfts[p.account] || [] });
  if (method === "account_lines") return out({ lines: [] });
  if (method === "account_tx") return out({ transactions: txs });
});
await new Promise(r => ledger.listen(4411, r));

// ---------- fake Telegram ----------
const calls = []; const queue = []; const statusOf = {}; let linkN = 0;
const telegram = createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const method = req.url.split("/").pop(); const p = raw ? JSON.parse(raw) : {};
  calls.push({ method, p });
  const ok = result => res.end(JSON.stringify({ ok: true, result }));
  if (method === "createChatInviteLink") return ok({ invite_link: "https://t.me/+fake" + ++linkN, member_limit: p.member_limit });
  if (method === "getChatMember") return ok({ status: statusOf[p.user_id] || "left" });
  if (method === "getUpdates") { const u = queue.splice(0); if (!u.length) await new Promise(r => setTimeout(r, 200)); return ok(u); }
  return ok(true); // revoke, ban, unban, sendMessage
});
await new Promise(r => telegram.listen(4412, r));

const srv = spawn(process.execPath, ["--no-warnings", "server.js"], {
  env: { ...process.env, PORT: "4422", DB_PATH: ":memory:", XRPL_RPC: "http://127.0.0.1:4411/", PROJECT_WALLET: PROJECT,
         NFT_ISSUER: NFTI, NFT_TAXON: "0", TOKEN_ISSUER: TOKI, MIN_NFTS: "1", RESCAN_MINUTES: "0",
         TG_BOT_TOKEN: "123:fake", TG_GROUP_ID: GROUP, TG_API: "http://127.0.0.1:4412", TG_SWEEP_MINUTES: "0.02" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise(r => srv.stdout.on("data", d => String(d).includes("backend on") && r()));

let ip = 0;
const api = async (path, body) => {
  const r = await fetch("http://127.0.0.1:4422" + path, body ? { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.1.0." + (++ip) }, body: JSON.stringify(body) } : {});
  return { status: r.status, body: await r.json() };
};
const wait = ms => new Promise(r => setTimeout(r, ms));
let passed = 0; const t = async (name, fn) => { await fn(); passed++; console.log("  ✓", name); };

try {
  const m = (await api("/api/verify/start", { address: HOLDER })).body.memo; pay(HOLDER, m);
  const key = (await api("/api/verify/check", { address: HOLDER, memo: m })).body.key;

  await t("health shows telegram on", async () => assert.equal((await api("/api/health")).body.telegram, true));

  let link;
  await t("holder gets a one-time invite link (1 use, 15 min)", async () => {
    const r = await api("/api/tg/invite", { key });
    assert.equal(r.status, 200); link = r.body.link; assert.match(link, /t\.me\/\+fake/);
    const c = calls.find(c => c.method === "createChatInviteLink");
    assert.equal(c.p.member_limit, 1); assert.equal(c.p.chat_id, GROUP);
    assert.ok(c.p.expire_date - Date.now() / 1000 <= 15 * 60 + 2);
  });

  await t("bad key can't get an invite", async () => {
    assert.equal((await api("/api/tg/invite", { key: "ZZZZZZZZ" })).status, 401);
  });

  await t("joining with the link links that Telegram account to the wallet, link revoked", async () => {
    queue.push({ update_id: 1, chat_member: { chat: { id: Number(GROUP) }, from: { id: 777 },
      old_chat_member: { status: "left", user: { id: 777 } }, new_chat_member: { status: "member", user: { id: 777, username: "surfer777" } },
      invite_link: { invite_link: link } } });
    statusOf[777] = "member";
    await wait(900);
    assert.ok(calls.some(c => c.method === "revokeChatInviteLink" && c.p.invite_link === link));
  });

  await t("same wallet asking again → 'already in', no second seat", async () => {
    const r = await api("/api/tg/invite", { key });
    assert.equal(r.status, 409); assert.equal(r.body.reason, "already_in"); assert.equal(r.body.username, "surfer777");
  });

  await t("wallet sells below the bar → removed from the group automatically + told why", async () => {
    nfts[HOLDER] = [];
    await wait(2500); // sweep runs every ~1.2s in tests
    assert.ok(calls.some(c => c.method === "banChatMember" && c.p.user_id === 777), "ban");
    assert.ok(calls.some(c => c.method === "unbanChatMember" && c.p.user_id === 777), "unban so they can return later");
    assert.ok(calls.some(c => c.method === "sendMessage" && c.p.chat_id === 777), "dm");
  });

  await t("below the bar → can't get a new invite", async () => {
    assert.equal((await api("/api/tg/invite", { key })).status, 403);
  });

  await t("buys back in, left the group → can get a fresh invite", async () => {
    nfts[HOLDER] = [{ Issuer: NFTI, NFTokenTaxon: 0, NFTokenID: "P1" }];
    statusOf[777] = "left";
    const r = await api("/api/tg/invite", { key });
    assert.equal(r.status, 200); assert.notEqual(r.body.link, link);
  });

  console.log(`\nAll ${passed} telegram tests passed.`);
} catch (e) {
  console.error("\n✗ FAILED:", e.message); process.exitCode = 1;
} finally {
  srv.kill(); ledger.close(); telegram.close(); setTimeout(() => process.exit(), 100);
}
