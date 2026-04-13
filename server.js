const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3100;
const DATA_DIR = path.join(__dirname, "..");
const CACHE_FILE = path.join(DATA_DIR, "dashboard_cache.json");

// ===== Wallet Configuration =====
const LEGACY_WALLET = process.env.WALLET || "";
const WALLETS_STR = process.env.WALLETS || "";
const WALLET_ALIASES = process.env.WALLET_ALIASES || ""; // e.g. "0xabc=蒙多,0xdef=小明"

function parseWallets() {
  const list = WALLETS_STR
    ? WALLETS_STR.split(",").map(w => w.trim().toLowerCase()).filter(Boolean)
    : LEGACY_WALLET
      ? [LEGACY_WALLET.toLowerCase()]
      : [];
  return [...new Set(list)];
}

function parseAliases() {
  const map = {};
  if (WALLET_ALIASES) {
    for (const pair of WALLET_ALIASES.split(",")) {
      const [addr, name] = pair.split("=").map(s => s.trim());
      if (addr && name) map[addr.toLowerCase()] = name;
    }
  }
  return map;
}

const WALLETS = parseWallets();
const ALIASES = parseAliases();
console.log("Tracking wallets:", WALLETS.length, WALLETS.map(w => w.slice(0, 8) + "..."));

// Proxy setup
if (process.env.PROXY_URL) {
  console.log("Using proxy:", process.env.PROXY_URL);
  const { setGlobalDispatcher, ProxyAgent } = require("undici");
  setGlobalDispatcher(new ProxyAgent(process.env.PROXY_URL));
}

// ===== API Helpers =====
async function apiGet(url) {
  const resp = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${url}`);
  return resp.json();
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ===== Per-Wallet Data Fetching =====
async function fetchWalletData(wallet) {
  const [positions, activity, value] = await Promise.all([
    apiGet(`https://data-api.polymarket.com/positions?user=${wallet}&limit=500`).catch(() => []),
    apiGet(`https://data-api.polymarket.com/activity?user=${wallet}&limit=500`).catch(() => []),
    apiGet(`https://data-api.polymarket.com/value?user=${wallet}`).catch(() => []),
  ]);

  const sortedActivity = Array.isArray(activity) ? [...activity].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)) : [];

  // Extract pseudonym from activity
  let pseudonym = null;
  for (const a of sortedActivity) {
    if (a.pseudonym) { pseudonym = a.pseudonym; break; }
  }

  // Build markets grouped by conditionId with outcome sub-grouping
  const rawMarkets = {};
  for (const a of sortedActivity) {
    const key = a.conditionId;
    if (!key) continue;
    if (!rawMarkets[key]) rawMarkets[key] = { title: a.title, slug: a.slug, conditionId: key, eventSlug: a.eventSlug, outcomes: {} };
    if (a.type === "REDEEM") {
      const ok = a.outcome || "_unknown";
      if (!rawMarkets[key].outcomes[ok]) rawMarkets[key].outcomes[ok] = { buys: [], sells: [], redeems: [] };
      rawMarkets[key].outcomes[ok].redeems.push({ size: parseFloat(a.size), usdc: parseFloat(a.usdcSize), timestamp: a.timestamp, txHash: a.transactionHash, outcome: a.outcome });
    } else if (a.type === "TRADE") {
      const ok = a.outcome || "_unknown";
      if (!rawMarkets[key].outcomes[ok]) rawMarkets[key].outcomes[ok] = { buys: [], sells: [], redeems: [] };
      const entry = { size: parseFloat(a.size), price: parseFloat(a.price), usdc: parseFloat(a.usdcSize), timestamp: a.timestamp, outcome: a.outcome, side: a.side, txHash: a.transactionHash };
      if (a.side === "BUY") rawMarkets[key].outcomes[ok].buys.push(entry);
      else rawMarkets[key].outcomes[ok].sells.push(entry);
    }
  }

  // Aggregate per market
  const marketResults = [];
  for (const [key, raw] of Object.entries(rawMarkets)) {
    let totalBuyCost = 0, totalBuySize = 0, totalSellRevenue = 0, totalSellSize = 0, totalRedeemRevenue = 0;
    const outcomeBreakdown = {};
    const allBuys = [], allSells = [], allRedeems = [];

    for (const [ok, od] of Object.entries(raw.outcomes)) {
      const oBuyCost = od.buys.reduce((s, t) => s + t.usdc, 0);
      const oBuySize = od.buys.reduce((s, t) => s + t.size, 0);
      const oSellRev = od.sells.reduce((s, t) => s + t.usdc, 0);
      const oSellSize = od.sells.reduce((s, t) => s + t.size, 0);
      const oRedeemRev = od.redeems.reduce((s, t) => s + t.usdc, 0);
      totalBuyCost += oBuyCost; totalBuySize += oBuySize;
      totalSellRevenue += oSellRev; totalSellSize += oSellSize;
      totalRedeemRevenue += oRedeemRev;
      allBuys.push(...od.buys); allSells.push(...od.sells); allRedeems.push(...od.redeems);
      outcomeBreakdown[ok] = {
        outcome: ok, buyCost: oBuyCost, buySize: oBuySize,
        sellRevenue: oSellRev, sellSize: oSellSize, redeemRevenue: oRedeemRev,
        buyCount: od.buys.length, sellCount: od.sells.length, redeemCount: od.redeems.length,
        avgBuyPrice: oBuySize > 0 ? oBuyCost / oBuySize : 0,
        net: oSellRev + oRedeemRev - oBuyCost,
      };
    }

    const hasRedeem = totalRedeemRevenue > 0;
    const fullySold = totalSellSize >= totalBuySize * 0.99;
    let status, realizedPnL;
    if (hasRedeem) { status = "WON"; realizedPnL = totalSellRevenue + totalRedeemRevenue - totalBuyCost; }
    else if (fullySold) { status = "SOLD"; realizedPnL = totalSellRevenue - totalBuyCost; }
    else { status = "HOLDING"; realizedPnL = null; }

    const allActions = [...allBuys, ...allSells, ...allRedeems].sort((a, b) => a.timestamp - b.timestamp);
    const holdHours = allActions.length > 1 ? ((allActions[allActions.length - 1].timestamp - allActions[0].timestamp) / 3600) : 0;
    const primaryOutcome = Object.entries(outcomeBreakdown).sort((a, b) => b[1].buyCost - a[1].buyCost)[0]?.[0] || "?";
    const avgBuyPrice = totalBuySize > 0 ? totalBuyCost / totalBuySize : 0;

    marketResults.push({
      title: raw.title, slug: raw.slug, conditionId: key,
      outcome: primaryOutcome,
      outcomeCount: Object.keys(outcomeBreakdown).length,
      multiOutcome: Object.keys(outcomeBreakdown).length > 1,
      status, cost: totalBuyCost, sellRevenue: totalSellRevenue, redeemRevenue: totalRedeemRevenue,
      pnl: realizedPnL,
      pnlPct: realizedPnL !== null && totalBuyCost > 0 ? (realizedPnL / totalBuyCost) * 100 : null,
      holdHours: parseFloat(holdHours.toFixed(1)),
      startTime: allBuys[0] ? new Date(allBuys[0].timestamp * 1000).toISOString() : null,
      buyCount: allBuys.length, sellCount: allSells.length, redeemCount: allRedeems.length,
      avgBuyPrice: parseFloat(avgBuyPrice.toFixed(4)),
      impliedProb: parseFloat((avgBuyPrice * 100).toFixed(1)),
      impliedOdds: avgBuyPrice > 0 ? parseFloat((1 / avgBuyPrice - 1).toFixed(2)) : null,
      outcomeBreakdown,
      trades: allActions.map(t => ({
        type: t.side === "BUY" ? "BUY" : t.side === "SELL" ? "SELL" : "REDEEM",
        outcome: t.outcome || primaryOutcome,
        size: parseFloat((t.size || 0).toFixed(2)),
        price: parseFloat((t.price || 0).toFixed(4)),
        usdc: parseFloat((t.usdc || 0).toFixed(2)),
        time: fmtTime(t.timestamp), timestamp: t.timestamp,
        txHash: t.txHash || null,
      })),
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

  // Daily P&L
  const dailyPnL = {};
  for (const a of sortedActivity) {
    const date = new Date((a.timestamp || 0) * 1000).toISOString().split("T")[0];
    if (!dailyPnL[date]) dailyPnL[date] = { out: 0, in: 0, trades: 0, redeems: 0 };
    if (a.type === "TRADE" && a.side === "BUY") { dailyPnL[date].out += parseFloat(a.usdcSize); dailyPnL[date].trades++; }
    else if (a.type === "TRADE" && a.side === "SELL") { dailyPnL[date].in += parseFloat(a.usdcSize); dailyPnL[date].trades++; }
    else if (a.type === "REDEEM") { dailyPnL[date].in += parseFloat(a.usdcSize); dailyPnL[date].redeems++; }
  }

  return {
    wallet,
    shortAddr: wallet.slice(0, 6) + "..." + wallet.slice(-4),
    pseudonym,
    displayName: ALIASES[wallet] || pseudonym || wallet.slice(0, 8) + "...",
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
      title: p.title, outcome: p.outcome,
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
}

// ===== Fetch All Wallets =====
async function fetchAllData() {
  if (WALLETS.length === 0) throw new Error("No wallets configured. Set WALLETS env var.");

  const results = {};
  // Fetch wallets sequentially with small delay to avoid rate limits
  for (let i = 0; i < WALLETS.length; i++) {
    const w = WALLETS[i];
    console.log(`Fetching wallet ${i + 1}/${WALLETS.length}: ${w.slice(0, 8)}...`);
    try {
      results[w] = await fetchWalletData(w);
      console.log(`  → ${results[w].displayName}: ${results[w].summary.totalMarkets} markets`);
    } catch (err) {
      console.error(`  → Error: ${err.message}`);
      results[w] = { wallet: w, shortAddr: w.slice(0, 6) + "..." + w.slice(-4), pseudonym: null, displayName: w.slice(0, 8) + "...", error: err.message, summary: { totalMarkets: 0, wonCount: 0, soldCount: 0, holdCount: 0, totalCost: 0, totalRevenue: 0, tradingPnL: 0, tradingPnLPct: 0, winRate: 0, accountValue: null, activePositions: 0 }, markets: [], positions: [], dailyPnL: [] };
    }
    // Small delay between wallets to avoid rate limiting
    if (i < WALLETS.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  // Build combined summary
  let combinedCost = 0, combinedRevenue = 0, combinedWon = 0, combinedSold = 0, combinedHold = 0, combinedMarkets = 0;
  const combinedDaily = {};
  const walletSummaries = {};

  for (const [addr, wd] of Object.entries(results)) {
    if (wd.error) continue;
    const s = wd.summary;
    combinedCost += s.totalCost;
    combinedRevenue += s.totalRevenue;
    combinedWon += s.wonCount;
    combinedSold += s.soldCount;
    combinedHold += s.holdCount;
    combinedMarkets += s.totalMarkets;

    walletSummaries[addr] = {
      wallet: addr,
      shortAddr: wd.shortAddr,
      displayName: wd.displayName,
      pseudonym: wd.pseudonym,
      pnl: s.tradingPnL,
      pnlPct: s.tradingPnLPct,
      cost: s.totalCost,
      revenue: s.totalRevenue,
      markets: s.totalMarkets,
      wonCount: s.wonCount,
      soldCount: s.soldCount,
      holdCount: s.holdCount,
      winRate: s.winRate,
      activePositions: s.activePositions,
    };

    // Merge daily P&L
    for (const d of wd.dailyPnL) {
      if (!combinedDaily[d.date]) combinedDaily[d.date] = { out: 0, in: 0, trades: 0, redeems: 0 };
      combinedDaily[d.date].out += d.out;
      combinedDaily[d.date].in += d.in;
      combinedDaily[d.date].trades += d.trades;
      combinedDaily[d.date].redeems += d.redeems;
    }
  }

  const combinedPnL = combinedRevenue - combinedCost;
  const resolvedCount = combinedWon + combinedSold;

  const data = {
    lastUpdated: new Date().toISOString(),
    wallets: WALLETS,
    walletSummaries: Object.values(walletSummaries),
    combined: {
      summary: {
        totalMarkets: combinedMarkets,
        wonCount: combinedWon,
        soldCount: combinedSold,
        holdCount: combinedHold,
        totalCost: combinedCost,
        totalRevenue: combinedRevenue,
        tradingPnL: combinedPnL,
        tradingPnLPct: combinedCost > 0 ? (combinedPnL / combinedCost) * 100 : 0,
        winRate: resolvedCount > 0 ? (combinedWon / resolvedCount) * 100 : 0,
        walletCount: WALLETS.length,
      },
      dailyPnL: Object.entries(combinedDaily).map(([date, d]) => ({
        date, out: d.out, in: d.in, net: d.in - d.out, trades: d.trades, redeems: d.redeems,
      })).sort((a, b) => a.date.localeCompare(b.date)),
    },
    data: results, // per-wallet full data, keyed by address
  };

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
  res.json(await getData(force));
});

app.get("/api/refresh", async (req, res) => {
  try { res.json({ success: true, ...await fetchAllData() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", wallets: WALLETS.length, lastFetch: new Date(lastFetchTime).toISOString() });
});

// ===== Trade Notification =====
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const LOOKBACK_MINUTES = parseInt(process.env.LOOKBACK_MINUTES || "10");
const NOTIFY_INTERVAL_MS = parseInt(process.env.NOTIFY_INTERVAL_MS || "300000");
const NOTIFY_STATE_FILE = path.join(DATA_DIR, "notify_state.json");

function loadNotifyState() {
  try { return JSON.parse(fs.readFileSync(NOTIFY_STATE_FILE, "utf-8")); }
  catch { return { lastSentTimestamps: {} }; }
}

function saveNotifyState(state) {
  fs.writeFileSync(NOTIFY_STATE_FILE, JSON.stringify(state, null, 2));
}

async function runNotification() {
  if (!WEBHOOK_URL || WALLETS.length === 0) return;
  try {
    console.log("[notify] Checking all wallets...");
    let allLines = [];

    for (const wallet of WALLETS) {
      const shortAddr = wallet.slice(0, 6) + "..." + wallet.slice(-4);
      const alias = ALIASES[wallet] || null;

      // Fetch recent activity for trades, and current positions for sell ratio calculation
      const [recentActivity, positions] = await Promise.all([
        apiGet(`https://data-api.polymarket.com/activity?user=${wallet}&limit=200`).catch(() => []),
        apiGet(`https://data-api.polymarket.com/positions?user=${wallet}&limit=500`).catch(() => []),
      ]);
      const pseudonym = recentActivity.find(a => a.pseudonym)?.pseudonym;
      const label = alias || pseudonym || shortAddr;

      // Build map: current position size per title+outcome (positions API shows post-trade state)
      const positionMap = {};
      if (Array.isArray(positions)) {
        for (const p of positions) {
          const key = `${p.title}_${p.outcome}`;
          positionMap[key] = parseFloat(p.size || p.amount || 0);
        }
      }

      const now = Math.floor(Date.now() / 1000);
      const cutoff = now - LOOKBACK_MINUTES * 60;
      const trades = (Array.isArray(recentActivity) ? recentActivity : [])
        .filter(a => (a.type === "TRADE" || a.type === "REDEEM") && (a.timestamp || 0) >= cutoff)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      if (trades.length === 0) continue;

      // Merge consecutive trades with same title + outcome + side + unitCost (rounded to 2 decimals, diff < 0.01)
      const merged = [];
      for (const t of trades) {
        const unitCost = parseFloat(t.size || 0) > 0
          ? parseFloat(t.usdcSize || 0) / parseFloat(t.size || 0)
          : 0;
        const unitCostKey = unitCost.toFixed(2);
        const key = `${t.title}_${t.outcome}_${t.side || "REDEEM"}_${unitCostKey}`;
        const last = merged[merged.length - 1];
        if (last && last._mergeKey === key) {
          const oldSize = parseFloat(last.size);
          const oldUsdc = parseFloat(last.usdc);
          const addSize = parseFloat(t.size || 0);
          const addUsdc = parseFloat(t.usdcSize || 0);
          const newSize = oldSize + addSize;
          const newUsdc = oldUsdc + addUsdc;
          last.size = newSize.toFixed(1);
          last.usdc = newUsdc.toFixed(2);
          last.unitCost = newSize > 0 ? (newUsdc / newSize).toFixed(4) : "0.0000";
          last.count = (last.count || 1) + 1;
        } else {
          merged.push({
            _mergeKey: key,
            title: t.title, outcome: t.outcome,
            side: t.side || "REDEEM", type: t.type,
            size: parseFloat(t.size || 0).toFixed(1),
            unitCost: unitCost.toFixed(4),
            usdc: parseFloat(t.usdcSize || 0).toFixed(2),
            time: fmtTime(t.timestamp),
            count: 1,
          });
        }
      }

      for (const m of merged) {
        const type = m.type === "REDEEM" ? "赎回" : m.side === "BUY" ? "买入" : "卖出";
        const emoji = m.type === "REDEEM" ? "🏆" : m.side === "BUY" ? "🟢" : "🔴";
        const countStr = m.count > 1 ? ` ×${m.count}` : "";
        const unitCostStr = `单价 $${m.unitCost}`;
        let line = `${emoji} [${label}] **${m.title || "?"}** · ${m.outcome || "?"}\n${type} ${m.size}份${countStr} · $${m.usdc} · ${unitCostStr} · ${m.time}`;

        // For sells: show ratio of sold shares vs pre-sell holdings (current position + sold amount)
        if (m.side === "SELL") {
          const posKey = `${m.title}_${m.outcome}`;
          const currentSize = positionMap[posKey] || 0;
          const soldSize = parseFloat(m.size);
          const preSellSize = currentSize + soldSize;
          if (preSellSize > 0) {
            const ratio = (soldSize / preSellSize * 100).toFixed(1);
            line += ` · 卖出${ratio}%`;
          }
        }

        allLines.push(line);
      }
    }

    if (allLines.length === 0) { console.log("[notify] No trades found."); return; }

    const header = `📊 蒙多的 Polymarket 交易播报（${WALLETS.length}个钱包 · 近${LOOKBACK_MINUTES}分钟）`;
    const payload = {
      msg_type: "interactive",
      card: {
        header: { title: { tag: "plain_text", content: header }, template: "blue" },
        elements: [{ tag: "div", text: { tag: "lark_md", content: allLines.join("\n\n") } }],
      },
    };

    const resp = await fetch(WEBHOOK_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
    const result = await resp.json();
    if (result.code !== 0) throw new Error(`Webhook: ${JSON.stringify(result)}`);
    console.log(`[notify] Sent: ${allLines.length} trades`);
  } catch (err) {
    console.error("[notify] Error:", err.message);
  }
}

// ===== Start =====
async function start() {
  console.log("Dashboard starting on port " + PORT);
  console.log("Wallets:", WALLETS.length);
  console.log("Fetching initial data...");
  try {
    latestData = await fetchAllData();
    lastFetchTime = Date.now();
    const s = latestData.combined.summary;
    console.log(`Loaded: ${s.walletCount} wallets, ${s.totalMarkets} markets, P&L: $${s.tradingPnL.toFixed(2)}`);
  } catch (e) {
    console.error("Initial fetch failed:", e.message, e.stack);
  }
  app.listen(PORT);
  console.log(`Dashboard ready on http://localhost:${PORT}`);

  if (WEBHOOK_URL) {
    console.log(`Notification: every ${NOTIFY_INTERVAL_MS / 1000}s`);
    runNotification();
    setInterval(runNotification, NOTIFY_INTERVAL_MS);
  }
}

start();
