# Surfers backend

Checks wallets, hands out keys, and checks keys at the door.
No packages to install: plain Node 22 with built-in SQLite.

## API

| Route | What it does |
|---|---|
| `GET  /api/health` | `{ ok: true, keys: <count> }` |
| `POST /api/verify/start` `{address}` | Gives a memo code (valid 15 min) |
| `POST /api/verify/check` `{address, memo}` | `waiting` → or `qualified` + key → or `not_qualified` |
| `POST /api/enter` `{key}` | Re-scans the key's wallet: `ok: true` or `reason: bad_key / below_bar` |
| `POST /api/me` `{key}` | The player's board: waves, rank, streak, sets, lineup, Swell timer |
| `POST /api/paddle` `{key}` | Daily Paddle Out (+10 × boost, +50 × boost every 7 days in a row) |
| `POST /api/set` `{key, id}` | Claim a Set (`x-follow`, `tg` once; `repost`, `weekly` once per week) |
| `GET /api/admin/payout?swell=1&token=…` | Who gets paid and how much (`&format=csv` for a spreadsheet) |

## Waves settings (Railway → Variables)

```
SWELL_START=2026-10-30T18:00:00Z   # Swell 1 starts (UTC) — 7 PM Lagos
SWELL_DAYS=4                       # payout every 4 days
POOL_PER_SWELL=3000                # $SURF split each Swell
ADMIN_TOKEN=pick-a-long-secret     # protects the payout list
```

Boost: 3+ NFTs = GROM 1.5x. Pro 2x / Legend 3x come from `tiers.json`
(`{"pro":[NFTokenIDs…],"legend":[NFTokenIDs…]}`), added after the mint.

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. Railway → **New Project → Deploy from GitHub repo** → pick it.
3. Click the service → **Volumes → Add Volume**, mount path: `/data`
   (this keeps the keys safe across restarts).
4. **Variables** tab, add:

```
DB_PATH=/data/surfers.db
PROJECT_WALLET=r...        # wallet that receives the 0.000001 XRP proofs
NFT_ISSUER=r...            # issuer of the Surfers NFTs
NFT_TAXON=                 # optional: collection taxon (leave empty to count all from the issuer)
TOKEN_ISSUER=r...          # $SURF issuer
TOKEN_CURRENCY=SURF
MIN_NFTS=3
MIN_TOKENS=10000
ALLOWED_ORIGIN=https://yourdomain.xyz
```

5. **Settings → Networking → Generate Domain**.
6. Open `https://<your-domain>/api/health`. You should see `{"ok":true,"keys":0}`.
7. Put `https://<your-domain>/api` in the website's `assets/config.js`.

## Test locally

```
npm test
```

Runs every flow against a fake ledger (no real XRP needed).
