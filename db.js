import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomInt } from "node:crypto";
import { config } from "./config.js";

if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS challenges (
    address    TEXT PRIMARY KEY,
    memo       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS keys (
    key         TEXT PRIMARY KEY,
    address     TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    last_check  INTEGER,
    last_nfts   INTEGER,
    last_tokens REAL
  );
  CREATE TABLE IF NOT EXISTS used_txs (
    hash    TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    used_at INTEGER NOT NULL
  );
`);

// No 0/O or 1/I so keys are easy to read and type.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rand = n => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

export const newMemo = () => "SURF-" + rand(6);

const q = {
  getChallenge: db.prepare("SELECT * FROM challenges WHERE address = ?"),
  putChallenge: db.prepare(`INSERT INTO challenges (address, memo, created_at, expires_at) VALUES (?, ?, ?, ?)
                            ON CONFLICT(address) DO UPDATE SET memo = excluded.memo,
                            created_at = excluded.created_at, expires_at = excluded.expires_at`),
  delChallenge: db.prepare("DELETE FROM challenges WHERE address = ?"),
  keyByAddress: db.prepare("SELECT * FROM keys WHERE address = ?"),
  keyByKey: db.prepare("SELECT * FROM keys WHERE key = ?"),
  insertKey: db.prepare("INSERT INTO keys (key, address, created_at) VALUES (?, ?, ?)"),
  touchKey: db.prepare("UPDATE keys SET last_check = ?, last_nfts = ?, last_tokens = ? WHERE key = ?"),
  usedTx: db.prepare("SELECT 1 FROM used_txs WHERE hash = ?"),
  useTx: db.prepare("INSERT OR IGNORE INTO used_txs (hash, address, used_at) VALUES (?, ?, ?)"),
  stats: db.prepare("SELECT COUNT(*) AS keys FROM keys"),
};

export const store = {
  getChallenge: a => q.getChallenge.get(a),
  putChallenge: (a, memo, created, expires) => q.putChallenge.run(a, memo, created, expires),
  delChallenge: a => q.delChallenge.run(a),
  keyByAddress: a => q.keyByAddress.get(a),
  keyByKey: k => q.keyByKey.get(k),
  touchKey: (k, nfts, tokens) => q.touchKey.run(Date.now(), nfts, tokens, k),
  isUsedTx: h => !!q.usedTx.get(h),
  useTx: (h, a) => q.useTx.run(h, a, Date.now()),
  keyCount: () => q.stats.get().keys,

  // One key per wallet: return the existing one or create a new 8-character key.
  issueKey(address) {
    const existing = q.keyByAddress.get(address);
    if (existing) return existing.key;
    for (let i = 0; i < 20; i++) {
      const key = rand(8);
      try { q.insertKey.run(key, address, Date.now()); return key; }
      catch (e) { if (!String(e.message).includes("UNIQUE")) throw e; }
    }
    throw new Error("Could not create a key, try again");
  },
};
