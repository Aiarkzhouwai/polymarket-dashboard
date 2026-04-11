# Polymarket Wallet Dashboard

Real-time dashboard for tracking Polymarket prediction market positions, P&L, and on-chain USDC flows.

## Deploy to Render

1. Push `dashboard/` folder to a GitHub repo
2. Go to [render.com](https://render.com) → **New** → **Web Service**
3. Connect your repo, set:
   - **Root Directory**: `dashboard`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variables** (optional):
     - `WALLET` = your wallet address (default: `0x938fb8985feb092a47d61e72a50dd0738e0da768`)
     - `PROXY_URL` = leave empty (direct fetch on Render)
4. Deploy!

## Local Dev

```bash
cd dashboard
npm install
PROXY_URL=http://127.0.0.1:18081 npm start
```

## Env Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3100 | Server port |
| `WALLET` | `0x938f...da768` | Polymarket wallet to track |
| `PROXY_URL` | (none) | HTTP proxy URL (local dev only) |
