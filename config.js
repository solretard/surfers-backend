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

  // ----- Waves / Swells -----
  swellStart: Date.parse(process.env.SWELL_START || "2026-10-30T18:00:00Z"), // Swell 1 starts (UTC)
  swellDays: num("SWELL_DAYS", 4),
  poolPerSwell: num("POOL_PER_SWELL", 3000),       // $SURF split each Swell
  adminToken: process.env.ADMIN_TOKEN || "",         // for the payout list
  rescanMinutes: num("RESCAN_MINUTES", 10),          // how often holdings are re-checked while playing
  timeTravel: process.env.ALLOW_TIME_TRAVEL === "1", // tests only

  // Waves per action (before boost)
  paddleWaves: num("PADDLE_WAVES", 10),
  streakBonus: num("STREAK_BONUS", 50),              // every 7 days in a row
  sets: [
    { id: "x-follow", waves: 25,  period: "once" },
    { id: "tg",       waves: 50,  period: "once" },
    { id: "repost",   waves: 25,  period: "weekly" },
    { id: "weekly",   waves: 100, period: "weekly" },
  ],
};

export function checkConfig() {
  const missing = ["projectWallet", "nftIssuer", "tokenIssuer"].filter(k => !config[k]);
  if (missing.length) {
    console.warn(`[config] Not set yet: ${missing.join(", ")}. Scans will fail until you add them.`);
  }
}
