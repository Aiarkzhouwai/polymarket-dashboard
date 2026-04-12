const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3100;
const WALLET = process.env.WALLET || "0x938fb8985feb092a47d61e72a50dd0738e0da768";
const WALLET_LOW = WALLET.toLowerCase();
const DATA_DIR = path.join(__dirname, "..");
const CACHE_FILE = path.join(DATA_DIR, "dashboard_cache.json");

// Proxy setup
if (process.env.PROXY_URL) {
  console.log("Using proxy:", process.env.PROXY_URL);
  const { setGlobalDispatcher, ProxyAgent } = require("undici");
  setGlobalDispatcher(new ProxyAgent(process.env.PROXY_URL));
} else {
  console.log("No proxy configured, fetching directly");
}

// ===== Data Fetching =====
async function apiGet(url) {
  const resp = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${url}`);
  return resp.json();
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

async function fetchAllData() {
  const [positions, activity, value, trades] = await Promise.all([
    apiGet(`https://data-api.polymarket.com/positions?user=${WALLET_LOW}&limit=500`).catch(() => []),
    apiGet(`https://data-api.polymarket.com/activity?user=${WALLET_LOW}&limit=500`).catch(() => []),
    apiGet(`https://data-api.polymarket.com/value?user=${WALLET_LOW}`).catch(() => []),
    apiGet(`https://data-api.polymarket.com/trades?user=${WALLET_LOW}&limit=500`).catch(() => []),
  ]);

  const sortedActivity = Array.isArray(activity) ? [...activity].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)) : [];

  // ===== Phase 1: Group raw activity by conditionId =====
  const rawMarkets = {};
  for (const a of sortedActivity) {
    const key = a.conditionId;
    if (!key) continue;
    if (!rawMarkets[key]) rawMarkets[key] = { title: a.title, slug: a.slug, conditionId: key, eventSlug: a.eventSlug, outcomes: {} };

    if (a.type === "REDEEM") {
      const ok = a.outcome || "_unknown";
      if (!rawMarkets[key].outcomes[ok]) rawMarkets[key].outcomes[ok] = { buys: [], sells: [], redeems: [] };
      rawMarkets[key].outcomes[ok].redeems.push({
        size: parseFloat(a.size),
        usdc: parseFloat(a.usdcSize),
        timestamp: a.timestamp,
        txHash: a.transactionHash,
        outcome: a.outcome,
      });
    } else if (a.type === "TRADE") {
      const ok = a.outcome || "_unknown";
      if (!rawMarkets[key].outcomes[ok]) rawMarkets[key].outcomes[ok] = { buys: [], sells: [], redeems: [] };
      const entry = {
        size: parseFloat(a.size),
        price: parseFloat(a.price),
        usdc: parseFloat(a.usdcSize),
        timestamp: a.timestamp,
        outcome: a.outcome,
        side: a.side,
        txHash: a.transactionHash,
      };
      if (a.side === "BUY") rawMarkets[key].outcomes[ok].buys.push(entry);
      else rawMarkets[key].outcomes[ok].sells.push(entry);
    }
  }

  // ===== Phase 2: Build per-market summary with outcome breakdown =====
  const marketResults = [];

  for (const [key, raw] of Object.entries(rawMarkets)) {
    const outcomeNames = Object.keys(raw.outcomes).filter(k => k !== "_unknown");

    // Aggregate across ALL outcomes for this market
    let totalBuyCost = 0, totalBuySize = 0, totalSellRevenue = 0, totalSellSize = 0;
    let totalRedeemRevenue = 0;
    let allBuys = [], allSells = [], allRedeems = [];

    const outcomeBreakdown = {};

    for (const [ok, od] of Object.entries(raw.outcomes)) {
      const oBuyCost = od.buys.reduce((s, t) => s + t.usdc, 0);
      const oBuySize = od.buys.reduce((s, t) => s + t.size, 0);
      const oSellRev = od.sells.reduce((s, t) => s + t.usdc, 0);
      const oSellSize = od.sells.reduce((s, t) => s + t.size, 0);
      const oRedeemRev = od.redeems.reduce((s, t) => s + t.usdc, 0);

      totalBuyCost += oBuyCost;
      totalBuySize += oBuySize;
      totalSellRevenue += oSellRev;
      totalSellSize += oSellSize;
      totalRedeemRevenue += oRedeemRev;

      allBuys.push(...od.buys);
      allSells.push(...od.sells);
      allRedeems.push(...od.redeems);

      outcomeBreakdown[ok] = {
        outcome: ok,
        buyCost: oBuyCost,
        buySize: oBuySize,
        sellRevenue: oSellRev,
        sellSize: oSellSize,
        redeemRevenue: oRedeemRev,
        buyCount: od.buys.length,
        sellCount: od.sells.length,
        redeemCount: od.redeems.length,
        avgBuyPrice: oBuySize > 0 ? oBuyCost / oBuySize : 0,
        net: oSellRev + oRedeemRev - oBuyCost,
      };
    }

    // Determine status
    const hasRedeem = totalRedeemRevenue > 0;
    const fullySold = totalSellSize >= totalBuySize * 0.99;

    let status, realizedPnL;
    if (hasRedeem) {
      status = "WON";
      realizedPnL = totalSellRevenue + totalRedeemRevenue - totalBuyCost;
    } else if (fullySold) {
      status = "SOLD";
      realizedPnL = totalSellRevenue - totalBuyCost;
    } else {
      status = "HOLDING";
      realizedPnL = null;
    }

    // Hold time
    const allActions = [...allBuys, ...allSells, ...allRedeems].sort((a, b) => a.timestamp - b.timestamp);
    const holdHours = allActions.length > 1 ? ((allActions[allActions.length - 1].timestamp - allActions[0].timestamp) / 3600) : 0;

    // Primary outcome = the one with highest buy cost
    const primaryOutcome = Object.entries(outcomeBreakdown)
      .sort((a, b) => b[1].buyCost - a[1].buyCost)[0]?.[0] || "?";
    const outcomeCount = Object.keys(outcomeBreakdown).length;
    const multiOutcome = outcomeCount > 1;

    // All trades sorted by time
    const allTrades = allActions.map(t => ({
      type: t.side === "BUY" ? "BUY" : t.side === "SELL" ? "SELL" : "REDEEM",
      outcome: t.outcome || primaryOutcome,
      size: parseFloat((t.size || 0).toFixed(2)),
      price: parseFloat((t.price || 0).toFixed(4)),
      usdc: parseFloat((t.usdc || 0).toFixed(2)),
      time: fmtTime(t.timestamp),
      timestamp: t.timestamp,
      txHash: t.txHash || null,
    }));

    const avgBuyPrice = totalBuySize > 0 ? totalBuyCost / totalBuySize : 0;

    marketResults.push({
      title: raw.title,
      slug: raw.slug,
      conditionId: key,
      outcome: primaryOutcome,
      outcomeCount,
      multiOutcome,
      status,
      cost: totalBuyCost,
      sellRevenue: totalSellRevenue,
      redeemRevenue: totalRedeemRevenue,
      pnl: realizedPnL,
      pnlPct: realizedPnL !== null && totalBuyCost > 0 ? (realizedPnL / totalBuyCost) * 100 : null,
      holdHours: parseFloat(holdHours.toFixed(1)),
      startTime: allBuys[0] ? new Date(allBuys[0].timestamp * 1000).toISOString() : null,
      buyCount: allBuys.length,
      sellCount: allSells.length,
      redeemCount: allRedeems.length,
      avgBuyPrice: parseFloat(avgBuyPrice.toFixed(4)),
      impliedProb: parseFloat((avgBuyPrice * 100).toFixed(1)),
      impliedOdds: avgBuyPrice > 0 ? parseFloat((1 / avgBuyPrice - 1).toFixed(2)) : null,
      outcomeBreakdown,
      trades: allTrades,
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

  // Daily P&L from activity
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
    pseudonym: "EasyEasyMoney",
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
      date, out: d.out, in: d.in, net: d.in - d.out, trades: d.trades, redeems: d.redeems,
    })).sort((a, b) => a.date.localeCompare(b.date)),
  };

  // Save cache
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));

  return data;
}

// ===== API Routes =====
let latestData = null;
let lastFetchTime = 0;
const FETCH_INTERVAL = 2 * 60 * 1000;

async function getData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && latestData && now - lastFetchTime < FETCH_INTERVAL) return latestData;
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
  try { res.json({ success: true, ...await fetchAllData() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", lastFetch: new Date(lastFetchTime).toISOString(), cacheAge: Date.now() - lastFetchTime });
});

// ===== Trade Notification =====
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const LOOKBACK_MINUTES = parseInt(process.env.LOOKBACK_MINUTES || "10");
const FALLBACK_COUNT = parseInt(process.env.FALLBACK_COUNT || "5");
const NOTIFY_INTERVAL_MS = parseInt(process.env.NOTIFY_INTERVAL_MS || "300000"); // 5min default
const NOTIFY_STATE_FILE = path.join(DATA_DIR, "notify_state.json");

function loadNotifyState() {
  try { return JSON.parse(fs.readFileSync(NOTIFY_STATE_FILE, "utf-8")); }
  catch { return { lastSentTimestamps: {} }; }
}

function saveNotifyState(state) {
  fs.writeFileSync(NOTIFY_STATE_FILE, JSON.stringify(state, null, 2));
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

async function runNotification() {
  if (!WEBHOOK_URL) return;
  try {
    console.log("[notify] Fetching trades...");
    const activity = await apiGet(`https://data-api.polymarket.com/activity?user=${WALLET_LOW}&limit=100`);
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - LOOKBACK_MINUTES * 60;

    const recent = activity
      .filter(a => (a.type === "TRADE" || a.type === "REDEEM") && (a.timestamp || 0) >= cutoff)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    let trades, mode;
    if (recent.length === 0) {
      const all = activity
        .filter(a => a.type === "TRADE" || a.type === "REDEEM")
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      trades = all.slice(0, FALLBACK_COUNT);
      mode = "fallback";
    } else {
      trades = recent;
      mode = "recent";
    }

    if (trades.length === 0) { console.log("[notify] No trades found."); return; }

    // Dedup
    const state = loadNotifyState();
    const newTrades = trades.filter(t => {
      const key = `${t.timestamp}_${t.side || "REDEEM"}_${parseFloat(t.usdcSize || 0).toFixed(2)}`;
      return !state.lastSentTimestamps[key];
    });
    if (newTrades.length === 0) { console.log("[notify] All already notified."); return; }

    const sendTrades = mode === "fallback" ? trades : newTrades;
    const header = mode === "recent"
      ? `📊 蒙多的 Polymarket 交易播报（近${LOOKBACK_MINUTES}分钟）`
      : `📊 蒙多的 Polymarket 最近交易（无新交易，展示最近${FALLBACK_COUNT}笔）`;

    let totalBuy = 0, totalSell = 0, totalRedeem = 0;
    const lines = [];
    for (const t of sendTrades) {
      const type = t.type === "REDEEM" ? "赎回" : t.side === "BUY" ? "买入" : "卖出";
      const emoji = t.type === "REDEEM" ? "🏆" : t.side === "BUY" ? "🟢" : "🔴";
      const usdc = parseFloat(t.usdcSize || 0).toFixed(2);
      if (t.type === "TRADE" && t.side === "BUY") totalBuy += parseFloat(t.usdcSize || 0);
      else if (t.type === "TRADE" && t.side === "SELL") totalSell += parseFloat(t.usdcSize || 0);
      else if (t.type === "REDEEM") totalRedeem += parseFloat(t.usdcSize || 0);
      lines.push(`${emoji} **${t.title || "?"}** · ${t.outcome || "?"}\n${type} ${parseFloat(t.size || 0).toFixed(1)}份 · $${usdc} · ${formatTime(t.timestamp)}`);
    }

    let summary = "";
    if (totalBuy > 0 || totalSell > 0 || totalRedeem > 0) {
      const parts = [];
      if (totalBuy > 0) parts.push(`买入 $${totalBuy.toFixed(2)}`);
      if (totalSell > 0) parts.push(`卖出 $${totalSell.toFixed(2)}`);
      if (totalRedeem > 0) parts.push(`赎回 $${totalRedeem.toFixed(2)}`);
      summary = `\n\n💵 ${parts.join(" | ")}`;
    }

    const payload = {
      msg_type: "interactive",
      card: {
        header: { title: { tag: "plain_text", content: header }, template: mode === "recent" ? "blue" : "grey" },
        elements: [{ tag: "div", text: { tag: "lark_md", content: lines.join("\n\n") + summary } }],
      },
    };

    const resp = await fetch(WEBHOOK_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
    const result = await resp.json();
    if (result.code !== 0) throw new Error(`Webhook: ${JSON.stringify(result)}`);

    console.log(`[notify] Sent ${mode}: ${sendTrades.length} trades`);

    for (const t of newTrades) {
      const key = `${t.timestamp}_${t.side || "REDEEM"}_${parseFloat(t.usdcSize || 0).toFixed(2)}`;
      state.lastSentTimestamps[key] = true;
    }
    const keys = Object.keys(state.lastSentTimestamps);
    if (keys.length > 500) state.lastSentTimestamps = Object.fromEntries(keys.slice(-500).map(k => [k, true]));
    saveNotifyState(state);
  } catch (err) {
    console.error("[notify] Error:", err.message);
  }
}

// ===== Start =====
async function start() {
  console.log("Dashboard starting on port " + PORT);
  console.log("Wallet:", WALLET_LOW);
  console.log("Fetching initial data...");
  try {
    latestData = await fetchAllData();
    lastFetchTime = Date.now();
    console.log("Initial data loaded: " + latestData.summary.totalMarkets + " markets");
  } catch (e) {
    console.error("Initial fetch failed:", e.message, e.stack);
  }
  app.listen(PORT);
  console.log(`Dashboard ready on http://localhost:${PORT}`);

  // Start trade notifications
  if (WEBHOOK_URL) {
    console.log(`Notification enabled: every ${NOTIFY_INTERVAL_MS / 1000}s to webhook`);
    runNotification(); // run immediately on start
    setInterval(runNotification, NOTIFY_INTERVAL_MS);
  } else {
    console.log("Notification disabled (no WEBHOOK_URL env var)");
  }
}

start();
