// All settings come from environment variables (set them in Railway → Variables).

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export const config = {
  port: num("PORT", 3000),
  dbPath: process.env.DB_PATH || "./surfers.db",

  // XRPL JSON-RPC servers, tried in order.
  rpcUrls: (process.env.XRPL_RPC || "https://xrplcluster.com/,https://s1.ripple.com:51234/")
    .split(",").map(s => s.trim()).filter(Boolean),

  // Wallet that receives the tiny proof payments.
  projectWallet: process.env.PROJECT_WALLET || "",

  // The Surfers NFT collection: issuer account and (optional) taxon.
  nftIssuer: process.env.NFT_ISSUER || "",
  nftTaxon: process.env.NFT_TAXON === undefined || process.env.NFT_TAXON === "" ? null : num("NFT_TAXON", null),

  // The $SURF token: issuer account and currency code (plain "SURF" or the 40-char hex code).
  tokenIssuer: process.env.TOKEN_ISSUER || "",
  tokenCurrency: process.env.TOKEN_CURRENCY || "SURF",

  // The bar.
  minNfts: num("MIN_NFTS", 3),
  minTokens: num("MIN_TOKENS", 10000),

  // How long a memo code stays valid (minutes).
  challengeMinutes: num("CHALLENGE_MINUTES", 15),

  // Which website may call this API (comma-separated). "*" allows any.
  allowedOrigins: (process.env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean),
};

export function checkConfig() {
  const missing = ["projectWallet", "nftIssuer", "tokenIssuer"].filter(k => !config[k]);
  if (missing.length) {
    console.warn(`[config] Not set yet: ${missing.join(", ")}. Scans will fail until you add them.`);
  }
}
