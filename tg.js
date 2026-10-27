// Holders-only Telegram group: one-time invite links, join tracking, auto-removal below the bar.
import { db } from "./db.js";

const TOKEN = process.env.TG_BOT_TOKEN || "";
const GROUP = process.env.TG_GROUP_ID || "";
const API = (process.env.TG_API || "https://api.telegram.org") + "/bot" + TOKEN;
const SWEEP_MIN = Number(process.env.TG_SWEEP_MINUTES || 30);
export const tgEnabled = () => !!(TOKEN && GROUP);

db.exec(`
  CREATE TABLE IF NOT EXISTS tg_invites (
    link       TEXT PRIMARY KEY,
    address    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_by    INTEGER
  );
  CREATE TABLE IF NOT EXISTS tg_members (
    user_id   INTEGER PRIMARY KEY,
    address   TEXT NOT NULL,
    username  TEXT,
    joined_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tg_state (k TEXT PRIMARY KEY, v TEXT);
`);
const q = {
  addInvite: db.prepare("INSERT INTO tg_invites (link, address, created_at) VALUES (?, ?, ?)"),
  invite: db.prepare("SELECT * FROM tg_invites WHERE link = ?"),
  useInvite: db.prepare("UPDATE tg_invites SET used_by = ? WHERE link = ?"),
  memberByAddr: db.prepare("SELECT * FROM tg_members WHERE address = ?"),
  putMember: db.prepare(`INSERT INTO tg_members (user_id, address, username, joined_at) VALUES (?, ?, ?, ?)
                         ON CONFLICT(user_id) DO UPDATE SET address = excluded.address, username = excluded.username`),
  delMember: db.prepare("DELETE FROM tg_members WHERE user_id = ?"),
  members: db.prepare("SELECT * FROM tg_members"),
  getState: db.prepare("SELECT v FROM tg_state WHERE k = ?"),
  setState: db.prepare("INSERT INTO tg_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
};

async function tg(method, params = {}, timeoutMs = 15000) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
  return j.result;
}

// ---------- invite ----------
export async function inviteFor(address) {
  if (!tgEnabled()) return { ok: false, reason: "tg_off" };
  // already in the group with this wallet? don't hand out another seat
  const m = q.memberByAddr.get(address);
  if (m) {
    try {
      const cm = await tg("getChatMember", { chat_id: GROUP, user_id: m.user_id });
      if (["member", "administrator", "creator", "restricted"].includes(cm.status)) return { ok: false, reason: "already_in", username: m.username };
    } catch {}
    q.delMember.run(m.user_id); // they left: free the seat
  }
  const res = await tg("createChatInviteLink", {
    chat_id: GROUP, member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + 15 * 60,
    name: "wallet " + address.slice(0, 6),
  });
  q.addInvite.run(res.invite_link, address, Date.now());
  return { ok: true, link: res.invite_link, expiresIn: 15 * 60 };
}

// ---------- joins: map Telegram user → wallet ----------
export function handleUpdate(u) {
  const cm = u.chat_member;
  if (!cm || String(cm.chat?.id) !== String(GROUP)) return;
  const joined = ["member", "restricted"].includes(cm.new_chat_member?.status) && !["member", "administrator", "creator", "restricted"].includes(cm.old_chat_member?.status);
  const left = ["left", "kicked"].includes(cm.new_chat_member?.status);
  const user = cm.new_chat_member?.user;
  if (!user) return;
  if (joined) {
    const link = cm.invite_link?.invite_link;
    const inv = link ? q.invite.get(link) : null;
    if (inv) {
      q.useInvite.run(user.id, link);
      q.putMember.run(user.id, inv.address, user.username || user.first_name || "", Date.now());
      tg("revokeChatInviteLink", { chat_id: GROUP, invite_link: link }).catch(() => {});
    }
  } else if (left) {
    q.delMember.run(user.id);
  }
}

let polling = false;
export async function pollOnce() {
  const offset = Number(q.getState.get("offset")?.v || 0);
  const updates = await tg("getUpdates", { offset, timeout: 25, allowed_updates: ["chat_member"] }, 35000);
  for (const u of updates) {
    try { handleUpdate(u); } catch (e) { console.error("[tg] update", e.message); }
    q.setState.run("offset", String(u.update_id + 1));
  }
  return updates.length;
}
async function pollLoop() {
  if (polling) return; polling = true;
  while (polling) {
    try { await pollOnce(); }
    catch (e) { console.error("[tg] poll", e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
}

// ---------- sweep: remove members whose wallet dropped below the bar ----------
export async function sweep(scan) {
  let removed = 0;
  for (const m of q.members.all()) {
    try {
      const h = await scan(m.address);
      if (h.qualified) continue;
      await tg("banChatMember", { chat_id: GROUP, user_id: m.user_id, until_date: Math.floor(Date.now() / 1000) + 60 });
      await tg("unbanChatMember", { chat_id: GROUP, user_id: m.user_id, only_if_banned: true }); // removed, can rejoin later
      q.delMember.run(m.user_id);
      removed++;
      tg("sendMessage", { chat_id: m.user_id, text: "You were removed from the Surfers holders chat because your wallet dropped below the bar. Hold 1 Pass or 10,000 $SURF and grab a new invite from the app." }).catch(() => {});
    } catch (e) { console.error("[tg] sweep", m.user_id, e.message); }
  }
  return removed;
}

export function startTelegram(scan) {
  if (!tgEnabled()) { console.log("[tg] off (set TG_BOT_TOKEN and TG_GROUP_ID to turn on)"); return; }
  console.log("[tg] on for group", GROUP);
  pollLoop();
  setInterval(() => sweep(scan).catch(e => console.error("[tg] sweep", e.message)), SWEEP_MIN * 60_000).unref();
}
export const stopTelegram = () => { polling = false; };
