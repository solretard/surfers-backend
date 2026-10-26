// Tiny XRPL JSON-RPC client using the built-in fetch. No libraries needed.
import { config } from "./config.js";

const RIPPLE_EPOCH = 946684800; // seconds between 1970-01-01 and 2000-01-01

async function rpc(method, params) {
  let lastErr;
  for (const url of config.rpcUrls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params: [params] }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const r = body.result;
      if (!r) throw new Error("Empty response");
      if (r.status === "error" || r.error) {
        // A wallet that doesn't exist yet is not a server failure.
        if (r.error === "actNotFound") return { notFound: true };
        throw new Error(r.error_message || r.error || "XRPL error");
      }
      return r;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`XRPL request failed (${method}): ${lastErr?.message}`);
}

// "SURF" -> 40-char hex currency code; 3-letter codes and hex codes stay as they are.
export function currencyCode(code) {
  if (/^[0-9A-Fa-f]{40}$/.test(code)) return code.toUpperCase();
  if (code.length === 3) return code.toUpperCase();
  const hex = Buffer.from(code, "ascii").toString("hex").toUpperCase();
  return hex.padEnd(40, "0");
}

export function decodeMemo(hex) {
  try { return Buffer.from(hex || "", "hex").toString("utf8").trim(); } catch { return ""; }
}

// Number of Surfers NFTs held by an address.
export async function countNfts(address) {
  let count = 0, marker;
  for (let page = 0; page < 50; page++) {
    const r = await rpc("account_nfts", { account: address, limit: 400, ...(marker ? { marker } : {}) });
    if (r.notFound) return 0;
    for (const n of r.account_nfts || []) {
      if (n.Issuer !== config.nftIssuer) continue;
      if (config.nftTaxon !== null && n.NFTokenTaxon !== config.nftTaxon) continue;
      count++;
    }
    marker = r.marker;
    if (!marker) break;
  }
  return count;
}

// $SURF balance held by an address.
export async function tokenBalance(address) {
  const want = currencyCode(config.tokenCurrency);
  let marker;
  for (let page = 0; page < 20; page++) {
    const r = await rpc("account_lines", {
      account: address, peer: config.tokenIssuer, limit: 400, ...(marker ? { marker } : {}),
    });
    if (r.notFound) return 0;
    for (const line of r.lines || []) {
      if (line.account === config.tokenIssuer && currencyCode(line.currency) === want) {
        const bal = Number(line.balance);
        return bal > 0 ? bal : 0;
      }
    }
    marker = r.marker;
    if (!marker) break;
  }
  return 0;
}

export async function scanHoldings(address) {
  const [nfts, tokens] = await Promise.all([countNfts(address), tokenBalance(address)]);
  const qualified = nfts >= config.minNfts || tokens >= config.minTokens;
  return { nfts, tokens, qualified };
}

// Find a validated payment FROM `from` TO the project wallet carrying `memo`,
// sent after `sinceMs`. Skips hashes in `usedHashes`. Returns the tx hash or null.
export async function findProofPayment(from, memo, sinceMs, isUsed) {
  let marker;
  for (let page = 0; page < 5; page++) {
    const r = await rpc("account_tx", {
      account: config.projectWallet, ledger_index_min: -1, ledger_index_max: -1,
      limit: 200, forward: false, ...(marker ? { marker } : {}),
    });
    if (r.notFound) return null;
    for (const t of r.transactions || []) {
      const tx = t.tx || t.tx_json || {};
      const hash = tx.hash || t.hash;
      const meta = t.meta || {};
      const whenMs = tx.date != null ? (tx.date + RIPPLE_EPOCH) * 1000
                   : t.close_time_iso ? Date.parse(t.close_time_iso) : 0;
      if (whenMs && whenMs < sinceMs - 60_000) return null; // older than the challenge: stop looking
      if (!t.validated) continue;
      if (tx.TransactionType !== "Payment") continue;
      if (tx.Account !== from || tx.Destination !== config.projectWallet) continue;
      if (meta.TransactionResult !== "tesSUCCESS") continue;
      const memos = (tx.Memos || []).map(m => decodeMemo(m.Memo?.MemoData));
      if (!memos.some(m => m.toUpperCase() === memo.toUpperCase())) continue;
      if (isUsed(hash)) continue;
      return hash;
    }
    marker = r.marker;
    if (!marker) break;
  }
  return null;
}
