const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3100;
const WALLET = process.env.WALLET || "0x938fb8985feb092a47d61e72a50dd0738e0da768";
const WALLET_LOW = WALLET.toLowerCase();
const DATA_DIR = path.join(__dirname, "..");

// Proxy setup: only use undici ProxyAgent if PROXY_URL is set (e.g. local dev)
// On Render / cloud, leave PROXY_URL empty to fetch directly
if (process.env.PROXY_URL) {
  console.log("Using proxy:", process.env.PROXY_URL);
  const { setGlobalDispatcher, ProxyAgent } = require("undici");
  setGlobalDispatcher(new ProxyAgent(process.env.PROXY_URL));
} else {
  console.log("No proxy configured, fetching directly");
}

const CACHE_FILE = path.join(DATA_DIR, "dashboard_cache.json");

// ===== Data Fetching =====
async function apiGet(url) {
  const resp = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${url}`);
  return resp.json();
}

async function fetchAllData() {
  const [positions, activity, value, trades] = await Promise.all([
    apiGet(`https://data-api.polymarket.com/positions?user=${WALLET_LOW}&limit=200`).catch(() => []),
    apiGet(`https://data-api.polymarket.com/activity?user=${WALLET_LOW}&limit=200`).catch(() => []),
    apiGet(`https://data-api.polymarket.com/value?user=${WALLET_LOW}`).catch(() => []),
    apiGet(`https://data-api.polymarket.com/trades?user=${WALLET_LOW}&limit=200`).catch(() => []),
  ]);

  // Build markets from activity
  const markets = {};
  const sortedActivity = Array.isArray(activity) ? [...activity].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)) : [];

  for (const a of sortedActivity) {
    const key = a.conditionId;
    if (!key) continue;
    if (!markets[key]) markets[key] = { title: a.title, slug: a.slug, conditionId: key, buys: [], sells: [], redeem: null };

    if (a.type === "REDEEM") {
      const redeemSize = parseFloat(a.size);
      if (!markets[key].redeem || redeemSize > 0) {
        markets[key].redeem = { size: redeemSize, usdc: parseFloat(a.usdcSize), timestamp: a.timestamp };
      }
    } else if (a.type === "TRADE") {
      const entry = { size: parseFloat(a.size), price: parseFloat(a.price), usdc: parseFloat(a.usdcSize), timestamp: a.timestamp, outcome: a.outcome, side: a.side };
      if (a.side === "BUY") markets[key].buys.push(entry);
      else markets[key].sells.push(entry);
    }
  }

  const marketResults = [];
  for (const [key, mkt] of Object.entries(markets)) {
    const totalBuyCost = mkt.buys.reduce((s, t) => s + t.usdc, 0);
    const totalSellRevenue = mkt.sells.reduce((s, t) => s + t.usdc, 0);
    const hasRedeem = mkt.redeem !== null && mkt.redeem.usdc > 0;
    const totalBuySize = mkt.buys.reduce((s, t) => s + t.size, 0);
    const totalSellSize = mkt.sells.reduce((s, t) => s + t.size, 0);
    const fullySold = totalSellSize >= totalBuySize * 0.99;

    let status, realizedPnL;
    if (hasRedeem) {
      status = "WON";
      realizedPnL = totalSellRevenue + mkt.redeem.usdc - totalBuyCost;
    } else if (fullySold) {
      status = "SOLD";
      realizedPnL = totalSellRevenue - totalBuyCost;
    } else {
      status = "HOLDING";
      realizedPnL = null;
    }

    const firstBuy = mkt.buys[0];
    const allActions = [...mkt.buys, ...mkt.sells, ...(mkt.redeem ? [mkt.redeem] : [])].sort((a, b) => a.timestamp - b.timestamp);
    const holdHours = allActions.length > 1 ? ((allActions[allActions.length - 1].timestamp - allActions[0].timestamp) / 3600) : 0;

    const tradeDetails = mkt.buys.map(b => ({
      size: b.size,
      price: b.price,
      usdc: b.usdc,
      impliedProb: (b.price * 100).toFixed(1),
      impliedOdds: b.price > 0 ? (1 / b.price - 1).toFixed(2) : null,
      time: new Date(b.timestamp * 1000).toISOString(),
    }));

    const avgBuyPrice = totalBuySize > 0 ? totalBuyCost / totalBuySize : 0;

    marketResults.push({
      title: mkt.title,
      outcome: mkt.buys[0]?.outcome || "?",
      status,
      cost: totalBuyCost,
      sellRevenue: totalSellRevenue,
      redeemRevenue: hasRedeem ? mkt.redeem.usdc : 0,
      pnl: realizedPnL,
      pnlPct: realizedPnL !== null && totalBuyCost > 0 ? (realizedPnL / totalBuyCost) * 100 : null,
      holdHours: parseFloat(holdHours.toFixed(1)),
      startTime: firstBuy ? new Date(firstBuy.timestamp * 1000).toISOString() : null,
      buyCount: mkt.buys.length,
      sellCount: mkt.sells.length,
      avgBuyPrice: parseFloat(avgBuyPrice.toFixed(4)),
      impliedProb: parseFloat((avgBuyPrice * 100).toFixed(1)),
      impliedOdds: avgBuyPrice > 0 ? parseFloat((1 / avgBuyPrice - 1).toFixed(2)) : null,
      tradeDetails,
    });
  }

  const statusOrder = { WON: 0, SOLD: 1, HOLDING: 2 };
  marketResults.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  const wonMarkets = marketResults.filter(r => r.status === "WON");
  const soldMarkets = marketResults.filter(r => r.status === "SOLD");
  const holdMarkets = marketResults.filter(r => r.status === "HOLDING");
  const resolvedMarkets = [...wonMarkets, ...soldMarkets];

  const totalCost = resolvedMarkets.reduce((s, r) => s + r.cost, 0);
  const totalRevenue = resolvedMarkets.reduce((s, r) => s + r.sellRevenue + r.redeemRevenue, 0);
  const tradingPnL = totalRevenue - totalCost;

  const posArray = Array.isArray(positions) ? positions : [];

  // Build daily P&L from activity
  const dailyPnL = {};
  for (const a of sortedActivity) {
    const date = new Date((a.timestamp || 0) * 1000).toISOString().split("T")[0];
    if (!dailyPnL[date]) dailyPnL[date] = { out: 0, in: 0, trades: 0, redeems: 0 };
    if (a.type === "TRADE" && a.side === "BUY") { dailyPnL[date].out += parseFloat(a.usdcSize); dailyPnL[date].trades++; }
    else if (a.type === "TRADE" && a.side === "SELL") { dailyPnL[date].in += parseFloat(a.usdcSize); dailyPnL[date].trades++; }
    else if (a.type === "REDEEM") { dailyPnL[date].in += parseFloat(a.usdcSize); dailyPnL[date].redeems++; }
  }

  const data = {
    lastUpdated: new Date().toISOString(),
    wallet: WALLET,
    pseudonym: "Early-Probability",
    summary: {
      totalMarkets: marketResults.length,
      wonCount: wonMarkets.length,
      soldCount: soldMarkets.length,
      holdCount: holdMarkets.length,
      totalCost,
      totalRevenue,
      tradingPnL,
      tradingPnLPct: totalCost > 0 ? (tradingPnL / totalCost) * 100 : 0,
      winRate: resolvedMarkets.length > 0 ? (wonMarkets.length / resolvedMarkets.length) * 100 : 0,
      accountValue: Array.isArray(value) && value.length > 0 ? value[0].value : null,
      activePositions: posArray.length,
    },
    markets: marketResults,
    positions: posArray.map(p => ({
      title: p.title,
      outcome: p.outcome,
      size: parseFloat(p.size || p.amount || 0),
      avgPrice: parseFloat(p.avgPrice || 0),
      curPrice: parseFloat(p.curPrice || 0),
      cashPnl: parseFloat(p.cashPnl || 0),
      percentPnl: parseFloat(p.percentPnl || 0),
      redeemable: p.redeemable || false,
      currentValue: parseFloat(p.currentValue || 0),
    })),
    dailyPnL: Object.entries(dailyPnL).map(([date, d]) => ({
      date,
      out: d.out,
      in: d.in,
      net: d.in - d.out,
      trades: d.trades,
      redeems: d.redeems,
    })).sort((a, b) => a.date.localeCompare(b.date)),
  };

  return data;
}

// ===== API Routes =====
let latestData = null;
let lastFetchTime = 0;
const FETCH_INTERVAL = 2 * 60 * 1000;

async function getData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && latestData && now - lastFetchTime < FETCH_INTERVAL) {
    return latestData;
  }
  try {
    latestData = await fetchAllData();
    lastFetchTime = now;
    return latestData;
  } catch (e) {
    console.error("Fetch error:", e.message);
    if (latestData) return latestData;
    return { error: e.message, lastUpdated: new Date().toISOString() };
  }
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/data", async (req, res) => {
  const force = req.query.refresh === "true";
  const data = await getData(force);
  res.json(data);
});

app.get("/api/refresh", async (req, res) => {
  try {
    const data = await fetchAllData();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    lastFetch: new Date(lastFetchTime).toISOString(),
    cacheAge: Date.now() - lastFetchTime,
  });
});

// ===== Start =====
async function start() {
  console.log("Dashboard starting on port " + PORT);
  console.log("Wallet:", WALLET_LOW);
  console.log("Fetching initial data...");
  try {
    latestData = await fetchAllData();
    lastFetchTime = Date.now();
    console.log("Initial data loaded successfully");
  } catch (e) {
    console.error("Initial fetch failed:", e.message);
  }
  console.log(`Dashboard ready on port ${PORT}`);
  app.listen(PORT);
}

start();
