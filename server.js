const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3100;
const SHANGHAI_TZ = "Asia/Shanghai";
const DATA_DIR = __dirname;
const CACHE_FILE = path.join(DATA_DIR, "dashboard_cache.json");

const ACTIVITY_PAGE_LIMIT = 500;
const ACTIVITY_MAX_OFFSET = 10000;
const POSITIONS_PAGE_LIMIT = 500;
const POSITIONS_MAX_OFFSET = 10000;
const CLOSED_PAGE_LIMIT = 50;
const CLOSED_MAX_OFFSET = 5000;
const POLYGON_RPC_URLS = (
  process.env.POLYGON_RPC_URLS
  || process.env.POLYGON_RPC_URL
  || [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org",
    "https://polygon-rpc.com",
    "https://1rpc.io/matic",
  ].join(",")
).split(",").map(url => url.trim()).filter(Boolean);

const POLYGON_USDC = {
  symbol: "USDC",
  address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  decimals: 6,
};
const POLYGON_USDCE = {
  symbol: "USDC.e",
  address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  decimals: 6,
};
const POLYGON_PUSD = {
  symbol: "PUSD",
  address: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  decimals: 6,
};
const POLYMARKET_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const POLYMARKET_EXCHANGES = new Set([
  "0xE111180000d2663C0091e4f400237545B87B996B",
  "0xe2222d279d744050d28e00520010520000310F59",
].map(address => address.toLowerCase()));
const STABLECOIN_ADDRESSES = new Set([
  POLYGON_USDC.address,
  POLYGON_USDCE.address,
  POLYGON_PUSD.address,
].map(address => address.toLowerCase()));
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRANSFER_SINGLE_TOPIC = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const CHAIN_V2_START_BLOCK = Number(process.env.CHAIN_V2_START_BLOCK || 86127000);
const CHAIN_TRADE_LOOKBACK_BLOCKS = process.env.CHAIN_TRADE_LOOKBACK_BLOCKS
  ? Number(process.env.CHAIN_TRADE_LOOKBACK_BLOCKS)
  : 0;
const CHAIN_LOG_CHUNK_BLOCKS = Number(process.env.CHAIN_LOG_CHUNK_BLOCKS || 2000);
const CHAIN_TRADES_ENABLED = process.env.CHAIN_TRADES_ENABLED !== "false";

const marketMetadataCache = new Map();
const blockTimestampCache = new Map();

const EXTERNAL_INFLOW_TYPES = new Set([
  "REWARD",
  "MAKER_REBATE",
  "REFERRAL_REWARD",
  "DEPOSIT",
]);
const EXTERNAL_OUTFLOW_TYPES = new Set([
  "WITHDRAW",
]);
const STRUCTURAL_ACTIVITY_TYPES = new Set([
  "CONVERSION",
  "MERGE",
  "SPLIT",
]);

// ===== Wallet Configuration =====
const LEGACY_WALLET = process.env.WALLET || "";
const WALLETS_STR = process.env.WALLETS || "";
const WALLET_ALIASES = process.env.WALLET_ALIASES || "";

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

// ===== Helpers =====
function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function round(value, digits = 2) {
  return Number(toNumber(value).toFixed(digits));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatShanghaiTimestamp(ts) {
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    timeZone: SHANGHAI_TZ,
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtTime(ts) {
  return formatShanghaiTimestamp(ts);
}

function shanghaiDate(ts) {
  return new Date(ts * 1000).toLocaleDateString("sv-SE", {
    timeZone: SHANGHAI_TZ,
  });
}

function currentShanghaiDate() {
  return new Date().toLocaleDateString("sv-SE", {
    timeZone: SHANGHAI_TZ,
  });
}

function buildDataApiUrl(pathname, params = {}) {
  const url = new URL(`https://data-api.polymarket.com${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function apiGet(url) {
  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${url}`);
  return resp.json();
}

async function rpcCall(method, params) {
  let lastError = null;

  for (const rpcUrl of POLYGON_RPC_URLS) {
    try {
      const resp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (!resp.ok) {
        throw new Error(`RPC ${resp.status}: ${rpcUrl}`);
      }

      const payload = await resp.json();
      if (payload.error) {
        throw new Error(`RPC error: ${payload.error.message || rpcUrl}`);
      }

      return payload.result;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`RPC failed: ${method}`);
}

function encodeBalanceOf(wallet) {
  const normalized = wallet.toLowerCase().replace(/^0x/, "");
  return `0x70a08231000000000000000000000000${normalized}`;
}

function formatTokenAmount(rawHex, decimals) {
  const raw = BigInt(rawHex || "0x0");
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return Number(fractionStr ? `${whole}.${fractionStr}` : whole.toString());
}

function normalizeAddress(address) {
  return String(address || "").toLowerCase();
}

function topicAddress(address) {
  return `0x${normalizeAddress(address).replace(/^0x/, "").padStart(64, "0")}`;
}

function addressFromTopic(topic) {
  return `0x${String(topic || "").slice(-40)}`.toLowerCase();
}

function hexToNumber(hex) {
  return Number(BigInt(hex || "0x0"));
}

function hexQuantity(value) {
  return `0x${Number(value).toString(16)}`;
}

function tokenIdHexToDecimal(tokenIdHex) {
  return BigInt(tokenIdHex).toString();
}

function stableAmount(rawHex) {
  return formatTokenAmount(rawHex, 6);
}

async function blockTimestamp(blockNumberHex) {
  if (blockTimestampCache.has(blockNumberHex)) {
    return blockTimestampCache.get(blockNumberHex);
  }

  const block = await rpcCall("eth_getBlockByNumber", [blockNumberHex, false]);
  const timestamp = hexToNumber(block?.timestamp);
  blockTimestampCache.set(blockNumberHex, timestamp);
  return timestamp;
}

async function fetchMarketMetadataByTokenId(tokenIdHex) {
  const tokenId = tokenIdHexToDecimal(tokenIdHex);
  if (marketMetadataCache.has(tokenId)) {
    return marketMetadataCache.get(tokenId);
  }

  const markets = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  }).then(resp => (resp.ok ? resp.json() : [])).catch(() => []);
  const market = Array.isArray(markets) ? markets[0] : null;
  let metadata = {
    conditionId: `chain:${tokenId}`,
    title: `Unknown Market ${tokenId.slice(0, 8)}...`,
    slug: "",
    eventSlug: "",
    icon: "",
    outcome: "Unknown",
    outcomeIndex: null,
  };

  if (market) {
    let outcomes = [];
    let tokenIds = [];
    try { outcomes = JSON.parse(market.outcomes || "[]"); } catch { outcomes = []; }
    try { tokenIds = JSON.parse(market.clobTokenIds || "[]"); } catch { tokenIds = []; }
    const outcomeIndex = tokenIds.findIndex(id => String(id) === tokenId);

    metadata = {
      conditionId: market.conditionId || market.condition_id || "",
      title: market.question || market.title || "Unknown Market",
      slug: market.slug || "",
      eventSlug: market.eventSlug || market.event_slug || "",
      icon: market.icon || market.image || "",
      outcome: outcomeIndex >= 0 ? normalizeOutcome(outcomes[outcomeIndex]) : "Unknown",
      outcomeIndex: outcomeIndex >= 0 ? outcomeIndex : null,
    };
  }

  marketMetadataCache.set(tokenId, metadata);
  return metadata;
}

async function fetchPolygonStablecoinBalances(wallet) {
  const profile = await apiGet(`https://gamma-api.polymarket.com/public-profile?address=${wallet}`).catch(() => null);
  const candidateAddresses = [...new Set([
    wallet,
    profile?.proxyWallet || null,
  ].filter(Boolean).map(address => address.toLowerCase()))];

  let best = {
    address: wallet.toLowerCase(),
    source: "wallet",
    usdc: 0,
    usdce: 0,
    pusd: 0,
    total: 0,
  };

  for (const address of candidateAddresses) {
    const [usdcRaw, usdceRaw, pusdRaw] = await Promise.all([
      rpcCall("eth_call", [{
        to: POLYGON_USDC.address,
        data: encodeBalanceOf(address),
      }, "latest"]).catch(() => "0x0"),
      rpcCall("eth_call", [{
        to: POLYGON_USDCE.address,
        data: encodeBalanceOf(address),
      }, "latest"]).catch(() => "0x0"),
      rpcCall("eth_call", [{
        to: POLYGON_PUSD.address,
        data: encodeBalanceOf(address),
      }, "latest"]).catch(() => "0x0"),
    ]);

    const usdc = formatTokenAmount(usdcRaw, POLYGON_USDC.decimals);
    const usdce = formatTokenAmount(usdceRaw, POLYGON_USDCE.decimals);
    const pusd = formatTokenAmount(pusdRaw, POLYGON_PUSD.decimals);
    const total = usdc + usdce + pusd;

    if (total > best.total) {
      best = {
        address,
        source: profile?.proxyWallet && profile.proxyWallet.toLowerCase() === address ? "proxyWallet" : "wallet",
        usdc: round(usdc, 2),
        usdce: round(usdce, 2),
        pusd: round(pusd, 2),
        total: round(total, 2),
      };
    }
  }

  return best;
}

async function fetchPaginated(pathname, baseParams, limit, maxOffset) {
  const items = [];

  for (let offset = 0; offset <= maxOffset; offset += limit) {
    const url = buildDataApiUrl(pathname, { ...baseParams, limit, offset });
    const batch = await apiGet(url).catch(() => []);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < limit) break;
  }

  return items;
}

async function fetchLogsInChunks(filter, fromBlock, toBlock) {
  const logs = [];
  const chunkSize = Math.max(100, CHAIN_LOG_CHUNK_BLOCKS);

  for (let start = fromBlock; start <= toBlock; start += chunkSize + 1) {
    const end = Math.min(start + chunkSize, toBlock);
    const batch = await rpcCall("eth_getLogs", [{
      ...filter,
      fromBlock: hexQuantity(start),
      toBlock: hexQuantity(end),
    }]).catch(() => []);

    if (Array.isArray(batch) && batch.length > 0) {
      logs.push(...batch);
    }
  }

  return logs;
}

function parseTransferSingleLog(log) {
  const words = String(log.data || "0x").slice(2).match(/.{64}/g) || [];
  if (log.topics?.[0] !== TRANSFER_SINGLE_TOPIC || words.length < 2) return null;

  return {
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: hexToNumber(log.logIndex),
    operator: addressFromTopic(log.topics[1]),
    from: addressFromTopic(log.topics[2]),
    to: addressFromTopic(log.topics[3]),
    tokenIdHex: `0x${words[0]}`,
    size: Number(BigInt(`0x${words[1]}`)) / 1e6,
  };
}

function parseStableTransfers(receipt) {
  return (receipt.logs || [])
    .filter(log => log.topics?.[0] === TRANSFER_TOPIC && STABLECOIN_ADDRESSES.has(normalizeAddress(log.address)))
    .map(log => ({
      token: normalizeAddress(log.address),
      from: addressFromTopic(log.topics[1]),
      to: addressFromTopic(log.topics[2]),
      amount: stableAmount(log.data),
    }));
}

async function receiptToChainActivities(wallet, txHash, walletTransfers) {
  const walletAddress = normalizeAddress(wallet);
  const receipt = await rpcCall("eth_getTransactionReceipt", [txHash]).catch(() => null);
  if (!receipt || receipt.status !== "0x1") return [];

  const timestamp = await blockTimestamp(receipt.blockNumber).catch(() => 0);
  const stableTransfers = parseStableTransfers(receipt);
  const stableIn = stableTransfers
    .filter(t => t.to === walletAddress)
    .reduce((sum, t) => sum + t.amount, 0);
  const stableOut = stableTransfers
    .filter(t => t.from === walletAddress)
    .reduce((sum, t) => sum + t.amount, 0);

  const outgoingTokenTransfers = walletTransfers.filter(t => t.from === walletAddress);
  const incomingTokenTransfers = walletTransfers.filter(t => t.to === walletAddress);
  const side = stableOut > stableIn && incomingTokenTransfers.length > 0
    ? "BUY"
    : stableIn > stableOut && outgoingTokenTransfers.length > 0
      ? "SELL"
      : null;
  if (!side) return [];

  const tokenTransfers = side === "BUY" ? incomingTokenTransfers : outgoingTokenTransfers;
  const totalSize = tokenTransfers.reduce((sum, transfer) => sum + transfer.size, 0);
  const usdcTotal = side === "BUY" ? stableOut : stableIn;
  if (totalSize <= 0 || usdcTotal <= 0) return [];

  const transfersByToken = new Map();
  for (const transfer of tokenTransfers) {
    const existing = transfersByToken.get(transfer.tokenIdHex) || { ...transfer, size: 0 };
    existing.size += transfer.size;
    transfersByToken.set(transfer.tokenIdHex, existing);
  }

  const activities = [];
  for (const transfer of transfersByToken.values()) {
    const metadata = await fetchMarketMetadataByTokenId(transfer.tokenIdHex);
    const usdcSize = usdcTotal * (transfer.size / totalSize);
    const size = transfer.size;

    activities.push({
      source: "chain",
      proxyWallet: walletAddress,
      timestamp,
      conditionId: metadata.conditionId,
      type: "TRADE",
      size,
      usdcSize,
      transactionHash: txHash,
      price: size > 0 ? usdcSize / size : 0,
      asset: tokenIdHexToDecimal(transfer.tokenIdHex),
      side,
      outcomeIndex: metadata.outcomeIndex,
      title: metadata.title,
      slug: metadata.slug,
      icon: metadata.icon,
      eventSlug: metadata.eventSlug,
      outcome: metadata.outcome,
    });
  }

  return activities;
}

async function fetchChainTradeActivities(wallet, options = {}) {
  if (!CHAIN_TRADES_ENABLED) return [];

  const walletAddress = normalizeAddress(wallet);
  const latestBlock = hexToNumber(await rpcCall("eth_blockNumber", []));
  const fromBlock = options.fromBlock
    || (options.lookbackBlocks
      ? Math.max(CHAIN_V2_START_BLOCK, latestBlock - options.lookbackBlocks)
      : CHAIN_TRADE_LOOKBACK_BLOCKS > 0
        ? Math.max(CHAIN_V2_START_BLOCK, latestBlock - CHAIN_TRADE_LOOKBACK_BLOCKS)
        : CHAIN_V2_START_BLOCK);
  const toBlock = options.toBlock || latestBlock;
  const walletTopic = topicAddress(walletAddress);
  const baseFilter = {
    address: POLYMARKET_CTF,
    topics: [TRANSFER_SINGLE_TOPIC],
  };

  const [fromLogs, toLogs] = await Promise.all([
    fetchLogsInChunks({ ...baseFilter, topics: [TRANSFER_SINGLE_TOPIC, null, walletTopic] }, fromBlock, toBlock),
    fetchLogsInChunks({ ...baseFilter, topics: [TRANSFER_SINGLE_TOPIC, null, null, walletTopic] }, fromBlock, toBlock),
  ]);

  const grouped = new Map();
  for (const rawLog of [...fromLogs, ...toLogs]) {
    const transfer = parseTransferSingleLog(rawLog);
    if (!transfer) continue;

    const touchesExchange = POLYMARKET_EXCHANGES.has(transfer.operator)
      || POLYMARKET_EXCHANGES.has(transfer.from)
      || POLYMARKET_EXCHANGES.has(transfer.to);
    if (!touchesExchange) continue;

    if (!grouped.has(transfer.txHash)) grouped.set(transfer.txHash, []);
    grouped.get(transfer.txHash).push(transfer);
  }

  if (grouped.size > 0) {
    console.log(`[chain] ${walletAddress.slice(0, 8)} found ${grouped.size} txs from block ${fromBlock}`);
  }

  const activities = [];
  for (const [txHash, transfers] of grouped.entries()) {
    const uniqueTransfers = [...new Map(
      transfers.map(transfer => [`${transfer.logIndex}:${transfer.tokenIdHex}:${transfer.from}:${transfer.to}`, transfer]),
    ).values()];
    activities.push(...await receiptToChainActivities(walletAddress, txHash, uniqueTransfers));
  }

  if (activities.length > 0) {
    console.log(`[chain] ${walletAddress.slice(0, 8)} parsed ${activities.length} trades`);
  }

  return activities.sort((a, b) => toNumber(a.timestamp) - toNumber(b.timestamp));
}

function mergeActivityFeeds(dataApiActivity, chainActivity) {
  const merged = [];
  const seen = new Map();

  for (const event of [...(chainActivity || []), ...(dataApiActivity || [])]) {
    const key = event.transactionHash
      ? [
        event.transactionHash,
        event.asset || "",
        event.side || event.type || "",
      ].join("::")
      : "";
    if (key && seen.has(key)) {
      const existing = seen.get(key);
      if (String(existing.title || "").startsWith("Unknown Market") && event.title) {
        existing.title = event.title;
        existing.conditionId = event.conditionId || existing.conditionId;
        existing.slug = event.slug || existing.slug;
        existing.eventSlug = event.eventSlug || existing.eventSlug;
        existing.icon = event.icon || existing.icon;
      }
      if (existing.outcome === "Unknown" && event.outcome) {
        existing.outcome = event.outcome;
        existing.outcomeIndex = event.outcomeIndex ?? existing.outcomeIndex;
      }
      continue;
    }
    if (key) seen.set(key, event);
    merged.push(event);
  }

  return merged.sort((a, b) => toNumber(a.timestamp) - toNumber(b.timestamp));
}

function normalizeOutcome(outcome, fallback = "Unknown") {
  return (typeof outcome === "string" && outcome.trim()) ? outcome.trim() : fallback;
}

function marketKey(conditionId) {
  return conditionId || "__unknown_market__";
}

function outcomeKey(conditionId, outcome) {
  return `${marketKey(conditionId)}::${normalizeOutcome(outcome)}`;
}

function emptyDailyRow(date) {
  return {
    date,
    buyCost: 0,
    realizedCostBasis: 0,
    realizedPnl: 0,
    sellRevenue: 0,
    redeemRevenue: 0,
    cashBack: 0,
    positionValue: 0,
    externalInflow: 0,
    externalOutflow: 0,
    externalNet: 0,
    tradingNet: 0,
    tradingMtmNet: 0,
    net: 0,
    cashNet: 0,
    trades: 0,
    redeems: 0,
    externalEvents: 0,
  };
}

function ensureDailyRow(map, date) {
  if (!map[date]) map[date] = emptyDailyRow(date);
  return map[date];
}

function emptyTodayStats() {
  return {
    hasActivity: false,
    buyCost: 0,
    realizedCostBasis: 0,
    realizedPnl: 0,
    sellRevenue: 0,
    redeemRevenue: 0,
    cashBack: 0,
    net: 0,
    eventCount: 0,
    lastTimestamp: 0,
  };
}

function classifyActivity(activity) {
  const type = (activity.type || "").toUpperCase();
  const amount = Math.abs(toNumber(activity.usdcSize));

  if (type === "TRADE" && activity.side === "BUY") {
    return { kind: "trade_buy", amount };
  }
  if (type === "TRADE" && activity.side === "SELL") {
    return { kind: "trade_sell", amount };
  }
  if (type === "REDEEM") {
    return { kind: "redeem", amount };
  }
  if (EXTERNAL_INFLOW_TYPES.has(type)) {
    return { kind: "external_in", amount };
  }
  if (EXTERNAL_OUTFLOW_TYPES.has(type)) {
    return { kind: "external_out", amount };
  }
  if (STRUCTURAL_ACTIVITY_TYPES.has(type)) {
    return { kind: "structural", amount };
  }

  if (!activity.conditionId && amount > 0) {
    return { kind: "external_in", amount };
  }

  return { kind: "other", amount };
}

function updateTodayStats(today, activity, classification) {
  today.hasActivity = true;
  today.eventCount += 1;
  today.lastTimestamp = Math.max(today.lastTimestamp, toNumber(activity.timestamp));

  if (classification.kind === "trade_buy") {
    today.buyCost += classification.amount;
  } else if (classification.kind === "trade_sell") {
    today.sellRevenue += classification.amount;
  } else if (classification.kind === "redeem") {
    today.redeemRevenue += classification.amount;
  }

  today.cashBack = today.sellRevenue + today.redeemRevenue;
  today.net = today.cashBack - today.buyCost;
}

function calculateTodayRealizedPnl(buys, sells, redeems, todayKey) {
  const lots = [];
  let realizedCostBasis = 0;
  let realizedProceeds = 0;

  const actions = [
    ...buys.map(trade => ({ ...trade, kind: "BUY" })),
    ...sells.map(trade => ({ ...trade, kind: "SELL" })),
    ...redeems.map(trade => ({ ...trade, kind: "REDEEM" })),
  ].sort((a, b) => toNumber(a.timestamp) - toNumber(b.timestamp));

  for (const action of actions) {
    const size = Math.max(toNumber(action.size), 0);
    const usdc = Math.max(toNumber(action.usdc), 0);
    if (size <= 0 && action.kind !== "REDEEM") continue;

    if (action.kind === "BUY") {
      lots.push({ size, cost: usdc });
      continue;
    }

    let remaining = size;
    let costBasis = 0;
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0];
      const used = Math.min(remaining, lot.size);
      const usedCost = lot.size > 0 ? lot.cost * (used / lot.size) : 0;
      costBasis += usedCost;
      lot.size -= used;
      lot.cost -= usedCost;
      remaining -= used;
      if (lot.size <= 1e-9) lots.shift();
    }

    if (shanghaiDate(toNumber(action.timestamp)) === todayKey) {
      realizedCostBasis += costBasis;
      realizedProceeds += usdc;
    }
  }

  return {
    realizedCostBasis,
    realizedProceeds,
    realizedPnl: realizedProceeds - realizedCostBasis,
  };
}

function buildTradeEntry(activity) {
  return {
    type: activity.type === "REDEEM"
      ? "REDEEM"
      : activity.side === "SELL"
        ? "SELL"
        : "BUY",
    outcome: normalizeOutcome(activity.outcome, "Resolved"),
    size: round(activity.size, 2),
    price: round(activity.price, 4),
    usdc: round(activity.usdcSize, 2),
    time: formatShanghaiTimestamp(toNumber(activity.timestamp)),
    timestamp: toNumber(activity.timestamp),
    txHash: activity.transactionHash || null,
  };
}

function makeMarketSeed(seed = {}) {
  return {
    conditionId: seed.conditionId || "",
    title: seed.title || "Untitled Market",
    slug: seed.slug || "",
    eventSlug: seed.eventSlug || "",
    icon: seed.icon || "",
    outcomes: {},
    lastTradeTimestamp: 0,
  };
}

function makeOutcomeSeed(outcome) {
  return {
    outcome,
    buys: [],
    sells: [],
    redeems: [],
    currentPositions: [],
    closedPositions: [],
    today: emptyTodayStats(),
  };
}

function seedMarket(map, seed = {}) {
  const key = marketKey(seed.conditionId);
  if (!map[key]) map[key] = makeMarketSeed(seed);
  const market = map[key];
  if (!market.title && seed.title) market.title = seed.title;
  if (!market.slug && seed.slug) market.slug = seed.slug;
  if (!market.eventSlug && seed.eventSlug) market.eventSlug = seed.eventSlug;
  if (!market.icon && seed.icon) market.icon = seed.icon;
  return market;
}

function seedOutcome(map, conditionId, rawOutcome, seed = {}) {
  const outcome = normalizeOutcome(rawOutcome, seed.fallbackOutcome || "Unknown");
  const market = seedMarket(map, {
    conditionId,
    title: seed.title,
    slug: seed.slug,
    eventSlug: seed.eventSlug,
    icon: seed.icon,
  });
  if (!market.outcomes[outcome]) {
    market.outcomes[outcome] = makeOutcomeSeed(outcome);
  }
  return market.outcomes[outcome];
}

function aggregateDailyRows(dailyMap) {
  return Object.values(dailyMap)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(row => ({
      ...row,
      buyCost: round(row.buyCost, 2),
      realizedCostBasis: round(row.realizedCostBasis, 2),
      realizedPnl: round(row.realizedPnl, 2),
      sellRevenue: round(row.sellRevenue, 2),
      redeemRevenue: round(row.redeemRevenue, 2),
      cashBack: round(row.cashBack, 2),
      positionValue: round(row.positionValue, 2),
      externalInflow: round(row.externalInflow, 2),
      externalOutflow: round(row.externalOutflow, 2),
      externalNet: round(row.externalNet, 2),
      tradingNet: round(row.tradingNet, 2),
      tradingMtmNet: round(row.tradingMtmNet !== undefined ? row.tradingMtmNet : row.tradingNet, 2),
      cashNet: round(row.cashNet !== undefined ? row.cashNet : row.net, 2),
      net: round(row.net, 2),
    }));
}

function positionMarketValue(position) {
  const currentValue = toNumber(position.currentValue);
  const estimatedValue = toNumber(position.size) * toNumber(position.curPrice);
  return Math.max(currentValue, estimatedValue, 0);
}

function positionEndTime(position) {
  if (!position.endDate) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(position.endDate)) {
    return Date.parse(`${position.endDate}T23:59:59+08:00`);
  }
  return Date.parse(position.endDate);
}

function positionHasFinalValue(position) {
  if (position.redeemable) return true;

  const endTime = positionEndTime(position);
  const ended = Number.isFinite(endTime) && endTime <= Date.now();
  const curPrice = toNumber(position.curPrice);
  return ended && (curPrice === 0 || curPrice === 1);
}

function summarizeMarket(market) {
  const allBuyTrades = [];
  const allSellTrades = [];
  const allRedeemTrades = [];
  const allActions = [];
  const outcomeBreakdown = {};

  let totalBought = 0;
  let totalCost = 0;
  let totalSellRevenue = 0;
  let totalRedeemRevenue = 0;
  let totalCurrentValue = 0;
  let totalRealizedPnl = 0;
  let totalPositionPnl = 0;
  let totalOpenValue = 0;
  let totalClaimableValue = 0;
  let totalOpenCostBasis = 0;
  let buyCount = 0;
  let sellCount = 0;
  let redeemCount = 0;
  let unresolvedPositionCount = 0;
  let resolvedPositionCount = 0;
  let today = emptyTodayStats();
  let earliestBuyTimestamp = 0;
  let primaryOutcome = "Unknown";
  let primaryWeight = -1;

  for (const [name, outcome] of Object.entries(market.outcomes)) {
    const buyCostFromTrades = outcome.buys.reduce((sum, trade) => sum + toNumber(trade.usdc), 0);
    const buySize = outcome.buys.reduce((sum, trade) => sum + toNumber(trade.size), 0);
    const sellRevenue = outcome.sells.reduce((sum, trade) => sum + toNumber(trade.usdc), 0);
    const sellSize = outcome.sells.reduce((sum, trade) => sum + toNumber(trade.size), 0);
    const redeemRevenue = outcome.redeems.reduce((sum, trade) => sum + toNumber(trade.usdc), 0);
    const todayRealized = calculateTodayRealizedPnl(
      outcome.buys,
      outcome.sells,
      outcome.redeems,
      currentShanghaiDate(),
    );

    const currentBought = outcome.currentPositions.reduce((sum, position) => {
      return sum + toNumber(position.initialValue);
    }, 0);
    const closedBought = outcome.closedPositions.reduce((sum, position) => {
      return sum + toNumber(position.totalBought);
    }, 0);
    const bought = buyCostFromTrades > 0
      ? buyCostFromTrades
      : currentBought + closedBought;

    const realizedPnl = outcome.currentPositions.reduce((sum, position) => {
      return sum + toNumber(position.realizedPnl);
    }, 0) + outcome.closedPositions.reduce((sum, position) => {
      return sum + toNumber(position.realizedPnl);
    }, 0);
    const positionPnl = outcome.currentPositions.reduce((sum, position) => {
      return sum + toNumber(position.cashPnl);
    }, 0);

    const finalValuePositions = outcome.currentPositions.filter(positionHasFinalValue);
    const openPositions = outcome.currentPositions.filter(position => !positionHasFinalValue(position));
    const openValue = openPositions.reduce((sum, position) => sum + positionMarketValue(position), 0);
    const claimableValue = finalValuePositions.reduce((sum, position) => sum + positionMarketValue(position), 0);
    const openCostBasis = openPositions.reduce((sum, position) => {
      return sum + toNumber(position.initialValue);
    }, 0);
    const cashBack = sellRevenue + redeemRevenue;
    const totalPnlFromFlows = cashBack + openValue + claimableValue - bought;
    const realizedPnlValue = openPositions.length === 0
      ? totalPnlFromFlows
      : cashBack - bought;
    const positionPnlValue = totalPnlFromFlows - realizedPnlValue;

    totalBought += bought;
    totalCost += bought;
    totalSellRevenue += sellRevenue;
    totalRedeemRevenue += redeemRevenue;
    totalCurrentValue += openValue + claimableValue;
    totalRealizedPnl += realizedPnlValue;
    totalPositionPnl += positionPnlValue;
    totalOpenValue += openValue;
    totalClaimableValue += claimableValue;
    totalOpenCostBasis += openCostBasis;
    buyCount += outcome.buys.length;
    sellCount += outcome.sells.length;
    redeemCount += outcome.redeems.length;
    unresolvedPositionCount += openPositions.length;
    resolvedPositionCount += finalValuePositions.length + outcome.closedPositions.length;

    today.buyCost += outcome.today.buyCost;
    today.realizedCostBasis += todayRealized.realizedCostBasis;
    today.realizedPnl += todayRealized.realizedPnl;
    today.sellRevenue += outcome.today.sellRevenue;
    today.redeemRevenue += outcome.today.redeemRevenue;
    today.cashBack += outcome.today.cashBack;
    today.net += todayRealized.realizedProceeds > 0 ? todayRealized.realizedPnl : outcome.today.net;
    today.eventCount += outcome.today.eventCount;
    today.hasActivity = today.hasActivity || outcome.today.hasActivity;
    today.lastTimestamp = Math.max(today.lastTimestamp, outcome.today.lastTimestamp);

    if (bought > primaryWeight) {
      primaryWeight = bought;
      primaryOutcome = name;
    }

    for (const trade of outcome.buys) {
      allBuyTrades.push(trade);
      allActions.push(trade);
      if (!earliestBuyTimestamp || trade.timestamp < earliestBuyTimestamp) {
        earliestBuyTimestamp = trade.timestamp;
      }
    }
    for (const trade of outcome.sells) {
      allSellTrades.push(trade);
      allActions.push(trade);
    }
    for (const trade of outcome.redeems) {
      allRedeemTrades.push(trade);
      allActions.push(trade);
    }

    outcomeBreakdown[name] = {
      outcome: name,
      buyCost: round(bought, 2),
      buySize: round(buySize, 2),
      sellRevenue: round(sellRevenue, 2),
      sellSize: round(sellSize, 2),
      redeemRevenue: round(redeemRevenue, 2),
      currentValue: round(openValue + claimableValue, 2),
      realizedPnl: round(realizedPnlValue, 2),
      positionPnl: round(positionPnlValue, 2),
      totalPnl: round(totalPnlFromFlows, 2),
      buyCount: outcome.buys.length,
      sellCount: outcome.sells.length,
      redeemCount: outcome.redeems.length,
      avgBuyPrice: buySize > 0 ? round(buyCostFromTrades / buySize, 4) : 0,
      today: {
        ...outcome.today,
        buyCost: round(outcome.today.buyCost, 2),
        realizedCostBasis: round(todayRealized.realizedCostBasis, 2),
        realizedPnl: round(todayRealized.realizedPnl, 2),
        sellRevenue: round(outcome.today.sellRevenue, 2),
        redeemRevenue: round(outcome.today.redeemRevenue, 2),
        cashBack: round(outcome.today.cashBack, 2),
        net: round(todayRealized.realizedProceeds > 0 ? todayRealized.realizedPnl : outcome.today.net, 2),
      },
    };
  }

  const allActionsAsc = [...allActions].sort((a, b) => a.timestamp - b.timestamp);
  const allActionsDesc = [...allActionsAsc].reverse();
  const holdHours = allActionsAsc.length > 1
    ? (allActionsAsc[allActionsAsc.length - 1].timestamp - allActionsAsc[0].timestamp) / 3600
    : 0;

  let status = "HOLDING";
  if (unresolvedPositionCount > 0) {
    status = "HOLDING";
  } else if (resolvedPositionCount > 0 || totalRedeemRevenue > 0) {
    status = totalRealizedPnl + totalPositionPnl >= 0 ? "WON" : "LOST";
  } else if (sellCount > 0 && totalCurrentValue === 0) {
    status = "SOLD";
  }

  const totalPnl = totalSellRevenue + totalRedeemRevenue + totalOpenValue + totalClaimableValue - totalCost;
  const avgBuyPrice = allBuyTrades.length > 0
    ? allBuyTrades.reduce((sum, trade) => sum + toNumber(trade.usdc), 0)
      / Math.max(allBuyTrades.reduce((sum, trade) => sum + toNumber(trade.size), 0), 1)
    : 0;

  return {
    title: market.title,
    slug: market.slug,
    eventSlug: market.eventSlug,
    icon: market.icon,
    conditionId: market.conditionId,
    outcome: primaryOutcome,
    outcomeCount: Object.keys(outcomeBreakdown).length,
    multiOutcome: Object.keys(outcomeBreakdown).length > 1,
    status,
    cost: round(totalCost, 2),
    totalBought: round(totalBought, 2),
    sellRevenue: round(totalSellRevenue, 2),
    redeemRevenue: round(totalRedeemRevenue, 2),
    cashBack: round(totalSellRevenue + totalRedeemRevenue, 2),
    currentValue: round(totalCurrentValue, 2),
    openValue: round(totalOpenValue, 2),
    claimableValue: round(totalClaimableValue, 2),
    openCostBasis: round(totalOpenCostBasis, 2),
    realizedPnl: round(totalRealizedPnl, 2),
    positionPnl: round(totalPositionPnl, 2),
    pnl: round(totalPnl, 2),
    pnlPct: totalCost > 0 ? round((totalPnl / totalCost) * 100, 1) : null,
    holdHours: round(holdHours, 1),
    startTime: earliestBuyTimestamp ? new Date(earliestBuyTimestamp * 1000).toISOString() : null,
    startTimestamp: earliestBuyTimestamp || 0,
    lastTradeTimestamp: market.lastTradeTimestamp || (allActionsDesc[0]?.timestamp || 0),
    buyCount,
    sellCount,
    redeemCount,
    avgBuyPrice: round(avgBuyPrice, 4),
    impliedProb: round(avgBuyPrice * 100, 1),
    impliedOdds: avgBuyPrice > 0 ? round(1 / avgBuyPrice - 1, 2) : null,
    outcomeBreakdown,
    trades: allActionsDesc.map(trade => ({
      type: trade.type,
      outcome: trade.outcome,
      size: round(trade.size, 2),
      price: round(trade.price, 4),
      usdc: round(trade.usdc, 2),
      time: trade.time,
      timestamp: trade.timestamp,
      txHash: trade.txHash || null,
    })),
    today: {
      ...today,
      buyCost: round(today.buyCost, 2),
      realizedCostBasis: round(today.realizedCostBasis, 2),
      realizedPnl: round(today.realizedPnl, 2),
      sellRevenue: round(today.sellRevenue, 2),
      redeemRevenue: round(today.redeemRevenue, 2),
      cashBack: round(today.cashBack, 2),
      net: round(today.net, 2),
    },
  };
}

function sortMarkets(markets) {
  return [...markets].sort((a, b) => {
    if ((b.lastTradeTimestamp || 0) !== (a.lastTradeTimestamp || 0)) {
      return (b.lastTradeTimestamp || 0) - (a.lastTradeTimestamp || 0);
    }
    return (b.pnl || 0) - (a.pnl || 0);
  });
}

// ===== Per-Wallet Data Fetching =====
async function fetchWalletData(wallet) {
  const [positions, closedPositions, dataApiActivity, chainActivity, value, stablecoinBalances] = await Promise.all([
    fetchPaginated(
      "/positions",
      { user: wallet },
      POSITIONS_PAGE_LIMIT,
      POSITIONS_MAX_OFFSET,
    ).catch(() => []),
    fetchPaginated(
      "/closed-positions",
      { user: wallet },
      CLOSED_PAGE_LIMIT,
      CLOSED_MAX_OFFSET,
    ).catch(() => []),
    fetchPaginated(
      "/activity",
      { user: wallet },
      ACTIVITY_PAGE_LIMIT,
      ACTIVITY_MAX_OFFSET,
    ).catch(() => []),
    fetchChainTradeActivities(wallet).catch(err => {
      console.warn(`[chain] ${wallet.slice(0, 8)} trade fetch failed: ${err.message}`);
      return [];
    }),
    apiGet(buildDataApiUrl("/value", { user: wallet })).catch(() => []),
    fetchPolygonStablecoinBalances(wallet).catch(() => ({
      address: wallet.toLowerCase(),
      source: "wallet",
      usdc: 0,
      usdce: 0,
      pusd: 0,
      total: 0,
    })),
  ]);

  const posArray = Array.isArray(positions) ? positions : [];
  const closedArray = Array.isArray(closedPositions) ? closedPositions : [];
  const sortedActivity = mergeActivityFeeds(
    Array.isArray(dataApiActivity) ? dataApiActivity : [],
    Array.isArray(chainActivity) ? chainActivity : [],
  );

  let pseudonym = null;
  for (const event of sortedActivity) {
    if (event.pseudonym) {
      pseudonym = event.pseudonym;
      break;
    }
  }

  const todayKey = currentShanghaiDate();
  const dailyPnLMap = {};
  const rawMarkets = {};

  for (const position of posArray) {
    const market = seedMarket(rawMarkets, {
      conditionId: position.conditionId,
      title: position.title,
      slug: position.slug,
      eventSlug: position.eventSlug,
      icon: position.icon,
    });
    const outcome = seedOutcome(rawMarkets, position.conditionId, position.outcome, {
      title: position.title,
      slug: position.slug,
      eventSlug: position.eventSlug,
      icon: position.icon,
    });
    outcome.currentPositions.push(position);

    const ts = position.endDate ? Math.floor(new Date(position.endDate).getTime() / 1000) : 0;
    market.lastTradeTimestamp = Math.max(market.lastTradeTimestamp, ts);
  }

  for (const position of closedArray) {
    const market = seedMarket(rawMarkets, {
      conditionId: position.conditionId,
      title: position.title,
      slug: position.slug,
      eventSlug: position.eventSlug,
      icon: position.icon,
    });
    const outcome = seedOutcome(rawMarkets, position.conditionId, position.outcome, {
      title: position.title,
      slug: position.slug,
      eventSlug: position.eventSlug,
      icon: position.icon,
    });
    outcome.closedPositions.push(position);
    market.lastTradeTimestamp = Math.max(market.lastTradeTimestamp, toNumber(position.timestamp));
  }

  let tradingOutflow = 0;
  let tradingInflow = 0;
  let redeemRevenue = 0;
  let externalInflow = 0;
  let externalOutflow = 0;

  for (const event of sortedActivity) {
    const ts = toNumber(event.timestamp);
    const dayKey = shanghaiDate(ts);
    const daily = ensureDailyRow(dailyPnLMap, dayKey);
    const classification = classifyActivity(event);

    if (classification.kind === "trade_buy") {
      tradingOutflow += classification.amount;
      daily.buyCost += classification.amount;
      daily.trades += 1;
    } else if (classification.kind === "trade_sell") {
      tradingInflow += classification.amount;
      daily.sellRevenue += classification.amount;
      daily.trades += 1;
    } else if (classification.kind === "redeem") {
      tradingInflow += classification.amount;
      redeemRevenue += classification.amount;
      daily.redeemRevenue += classification.amount;
      daily.redeems += 1;
    } else if (classification.kind === "external_in") {
      externalInflow += classification.amount;
      daily.externalInflow += classification.amount;
      daily.externalEvents += 1;
    } else if (classification.kind === "external_out") {
      externalOutflow += classification.amount;
      daily.externalOutflow += classification.amount;
      daily.externalEvents += 1;
    }

    daily.cashBack = daily.sellRevenue + daily.redeemRevenue;
    daily.externalNet = daily.externalInflow - daily.externalOutflow;
    daily.tradingNet = daily.cashBack - daily.buyCost;
    daily.tradingMtmNet = daily.tradingNet + daily.positionValue;
    daily.cashNet = daily.tradingNet + daily.externalNet;
    daily.net = daily.tradingMtmNet + daily.externalNet;

    if (!event.conditionId || (event.type !== "TRADE" && event.type !== "REDEEM")) {
      continue;
    }

    const fallbackOutcome = event.type === "REDEEM" ? "Resolved" : "Unknown";
    const market = seedMarket(rawMarkets, {
      conditionId: event.conditionId,
      title: event.title,
      slug: event.slug,
      eventSlug: event.eventSlug,
      icon: event.icon,
    });
    const outcome = seedOutcome(rawMarkets, event.conditionId, event.outcome, {
      title: event.title,
      slug: event.slug,
      eventSlug: event.eventSlug,
      icon: event.icon,
      fallbackOutcome,
    });

    const trade = buildTradeEntry(event);
    if (event.type === "REDEEM") {
      outcome.redeems.push(trade);
    } else if (event.side === "BUY") {
      outcome.buys.push(trade);
    } else if (event.side === "SELL") {
      outcome.sells.push(trade);
    }

    market.lastTradeTimestamp = Math.max(market.lastTradeTimestamp, ts);

    if (dayKey === todayKey) {
      updateTodayStats(outcome.today, event, classification);
    }
  }

  const marketResults = sortMarkets(
    Object.values(rawMarkets)
      .filter(market => Object.keys(market.outcomes).length > 0)
      .map(summarizeMarket),
  );
  const todayPositionValue = marketResults
    .filter(market => market.today?.hasActivity)
    .reduce((sum, market) => sum + toNumber(market.currentValue), 0);
  if (dailyPnLMap[todayKey]) {
    const todayRow = dailyPnLMap[todayKey];
    const todayRealizedCostBasis = marketResults
      .filter(market => market.today?.hasActivity)
      .reduce((sum, market) => sum + toNumber(market.today?.realizedCostBasis), 0);
    const todayRealizedPnl = marketResults
      .filter(market => market.today?.hasActivity)
      .reduce((sum, market) => sum + toNumber(market.today?.realizedPnl), 0);
    todayRow.positionValue = todayPositionValue;
    todayRow.realizedCostBasis = todayRealizedCostBasis;
    todayRow.realizedPnl = todayRealizedPnl;
    todayRow.tradingMtmNet = todayRealizedCostBasis > 0
      ? todayRealizedPnl
      : todayRow.tradingNet + todayRow.positionValue;
    todayRow.cashNet = todayRow.tradingNet + todayRow.externalNet;
    todayRow.net = todayRow.tradingMtmNet + todayRow.externalNet;
  }

  const wonMarkets = marketResults.filter(r => r.status === "WON");
  const lostMarkets = marketResults.filter(r => r.status === "LOST");
  const soldMarkets = marketResults.filter(r => r.status === "SOLD");
  const holdMarkets = marketResults.filter(r => r.status === "HOLDING");

  const totalBought = marketResults.reduce((sum, market) => sum + toNumber(market.cost), 0);
  const realizedTradingPnL = marketResults
    .filter(market => market.status !== "HOLDING")
    .reduce((sum, market) => sum + toNumber(market.pnl), 0);
  const positionPnL = marketResults
    .filter(market => market.status === "HOLDING")
    .reduce((sum, market) => sum + toNumber(market.pnl), 0);
  const totalTradingPnL = marketResults.reduce((sum, market) => sum + toNumber(market.pnl), 0);
  const externalNet = externalInflow - externalOutflow;
  const netPnL = totalTradingPnL + externalNet;
  const openPositionValue = marketResults.reduce((sum, market) => sum + toNumber(market.openValue), 0);
  const claimableValue = marketResults.reduce((sum, market) => sum + toNumber(market.claimableValue), 0);
  const openCostBasis = marketResults.reduce((sum, market) => sum + toNumber(market.openCostBasis), 0);
  const openPositions = posArray.filter(position => !positionHasFinalValue(position));

  const dailyPnL = aggregateDailyRows(dailyPnLMap);
  const todaySummary = dailyPnL.find(row => row.date === todayKey) || emptyDailyRow(todayKey);

  return {
    wallet,
    shortAddr: wallet.slice(0, 6) + "..." + wallet.slice(-4),
    pseudonym,
    displayName: ALIASES[wallet] || pseudonym || wallet.slice(0, 8) + "...",
    summary: {
      totalMarkets: marketResults.length,
      wonCount: wonMarkets.length,
      lostCount: lostMarkets.length,
      soldCount: soldMarkets.length,
      holdCount: holdMarkets.length,
      totalBought: round(totalBought, 2),
      totalCost: round(tradingOutflow, 2),
      totalRevenue: round(tradingInflow, 2),
      tradingOutflow: round(tradingOutflow, 2),
      tradingInflow: round(tradingInflow, 2),
      redeemRevenue: round(redeemRevenue, 2),
      realizedTradingPnL: round(realizedTradingPnL, 2),
      positionPnL: round(positionPnL, 2),
      totalTradingPnL: round(totalTradingPnL, 2),
      tradingPnL: round(totalTradingPnL, 2),
      externalInflow: round(externalInflow, 2),
      externalOutflow: round(externalOutflow, 2),
      externalNet: round(externalNet, 2),
      netPnL: round(netPnL, 2),
      tradingPnLPct: totalBought > 0 ? round((totalTradingPnL / totalBought) * 100, 1) : 0,
      netPnLPct: totalBought > 0 ? round((netPnL / totalBought) * 100, 1) : 0,
      winRate: wonMarkets.length + lostMarkets.length > 0
        ? round((wonMarkets.length / (wonMarkets.length + lostMarkets.length)) * 100, 1)
        : 0,
      accountValue: Array.isArray(value) && value.length > 0
        ? toNumber(value[0].value)
        : round(openPositionValue + claimableValue, 2),
      openPositionValue: round(openPositionValue, 2),
      claimableValue: round(claimableValue, 2),
      openCostBasis: round(openCostBasis, 2),
      walletUsdc: stablecoinBalances.usdc,
      walletUsdce: stablecoinBalances.usdce,
      walletPusd: stablecoinBalances.pusd,
      walletStablecoinTotal: stablecoinBalances.total,
      walletStablecoinAddress: stablecoinBalances.address,
      walletStablecoinSource: stablecoinBalances.source,
      activePositions: openPositions.length,
      today: {
        date: todaySummary.date,
        buyCost: round(todaySummary.buyCost, 2),
        realizedCostBasis: round(todaySummary.realizedCostBasis, 2),
        realizedPnl: round(todaySummary.realizedPnl, 2),
        cashBack: round(todaySummary.cashBack, 2),
        positionValue: round(todaySummary.positionValue, 2),
        tradingNet: round(todaySummary.tradingNet, 2),
        tradingMtmNet: round(todaySummary.tradingMtmNet !== undefined ? todaySummary.tradingMtmNet : todaySummary.tradingNet, 2),
        externalNet: round(todaySummary.externalNet, 2),
        cashNet: round(todaySummary.cashNet !== undefined ? todaySummary.cashNet : todaySummary.net, 2),
        net: round(todaySummary.net, 2),
        trades: todaySummary.trades,
        redeems: todaySummary.redeems,
        externalEvents: todaySummary.externalEvents,
      },
    },
    markets: marketResults,
    positions: posArray.map(position => ({
      title: position.title,
      outcome: position.outcome,
      conditionId: position.conditionId,
      size: round(position.size || position.amount, 2),
      avgPrice: round(position.avgPrice, 4),
      curPrice: round(position.curPrice, 4),
      cashPnl: round(position.cashPnl, 2),
      realizedPnl: round(position.realizedPnl, 2),
      percentPnl: round(position.percentPnl, 2),
      redeemable: position.redeemable || false,
      currentValue: round(position.currentValue, 2),
      initialValue: round(position.initialValue, 2),
      totalBought: round(position.totalBought, 2),
    })),
    dailyPnL,
  };
}

// ===== Fetch All Wallets =====
async function fetchAllData() {
  if (WALLETS.length === 0) throw new Error("No wallets configured. Set WALLETS env var.");

  const results = {};

  for (let i = 0; i < WALLETS.length; i += 1) {
    const wallet = WALLETS[i];
    console.log(`Fetching wallet ${i + 1}/${WALLETS.length}: ${wallet.slice(0, 8)}...`);
    try {
      results[wallet] = await fetchWalletData(wallet);
      console.log(`  -> ${results[wallet].displayName}: ${results[wallet].summary.totalMarkets} markets`);
    } catch (err) {
      console.error(`  -> Error: ${err.message}`);
      results[wallet] = {
        wallet,
        shortAddr: wallet.slice(0, 6) + "..." + wallet.slice(-4),
        pseudonym: null,
        displayName: wallet.slice(0, 8) + "...",
        error: err.message,
        summary: {
          totalMarkets: 0,
          wonCount: 0,
          lostCount: 0,
          soldCount: 0,
          holdCount: 0,
          totalBought: 0,
          totalCost: 0,
          totalRevenue: 0,
          tradingOutflow: 0,
          tradingInflow: 0,
          redeemRevenue: 0,
          realizedTradingPnL: 0,
          positionPnL: 0,
          totalTradingPnL: 0,
          tradingPnL: 0,
          externalInflow: 0,
          externalOutflow: 0,
          externalNet: 0,
          netPnL: 0,
          tradingPnLPct: 0,
          netPnLPct: 0,
          winRate: 0,
          accountValue: null,
          openPositionValue: 0,
          claimableValue: 0,
          openCostBasis: 0,
          walletUsdc: 0,
          walletUsdce: 0,
          walletPusd: 0,
          walletStablecoinTotal: 0,
          walletStablecoinAddress: wallet,
          walletStablecoinSource: "wallet",
          activePositions: 0,
          today: {
            date: currentShanghaiDate(),
            buyCost: 0,
            realizedCostBasis: 0,
            realizedPnl: 0,
            cashBack: 0,
            tradingNet: 0,
            tradingMtmNet: 0,
            externalNet: 0,
            cashNet: 0,
            net: 0,
            trades: 0,
            redeems: 0,
            externalEvents: 0,
          },
        },
        markets: [],
        positions: [],
        dailyPnL: [],
      };
    }

    if (i < WALLETS.length - 1) {
      await sleep(500);
    }
  }

  const combinedDaily = {};
  const walletSummaries = [];

  let combinedWon = 0;
  let combinedLost = 0;
  let combinedSold = 0;
  let combinedHold = 0;
  let combinedMarkets = 0;
  let combinedTotalBought = 0;
  let combinedTradingOutflow = 0;
  let combinedTradingInflow = 0;
  let combinedRedeemRevenue = 0;
  let combinedRealizedPnL = 0;
  let combinedPositionPnL = 0;
  let combinedTradingPnL = 0;
  let combinedExternalInflow = 0;
  let combinedExternalOutflow = 0;
  let combinedNetPnL = 0;
  let combinedAccountValue = 0;
  let combinedOpenPositionValue = 0;
  let combinedClaimableValue = 0;
  let combinedActivePositions = 0;
  let combinedWalletUsdc = 0;
  let combinedWalletUsdce = 0;
  let combinedWalletPusd = 0;
  let combinedWalletStablecoinTotal = 0;

  for (const [wallet, walletData] of Object.entries(results)) {
    if (walletData.error) continue;

    const summary = walletData.summary;
    combinedWon += summary.wonCount;
    combinedLost += summary.lostCount;
    combinedSold += summary.soldCount;
    combinedHold += summary.holdCount;
    combinedMarkets += summary.totalMarkets;
    combinedTotalBought += summary.totalBought;
    combinedTradingOutflow += summary.tradingOutflow;
    combinedTradingInflow += summary.tradingInflow;
    combinedRedeemRevenue += summary.redeemRevenue;
    combinedRealizedPnL += summary.realizedTradingPnL;
    combinedPositionPnL += summary.positionPnL;
    combinedTradingPnL += summary.totalTradingPnL;
    combinedExternalInflow += summary.externalInflow;
    combinedExternalOutflow += summary.externalOutflow;
    combinedNetPnL += summary.netPnL;
    combinedAccountValue += toNumber(summary.accountValue);
    combinedOpenPositionValue += summary.openPositionValue;
    combinedClaimableValue += summary.claimableValue;
    combinedActivePositions += summary.activePositions;
    combinedWalletUsdc += summary.walletUsdc;
    combinedWalletUsdce += summary.walletUsdce;
    combinedWalletPusd += summary.walletPusd;
    combinedWalletStablecoinTotal += summary.walletStablecoinTotal;

    walletSummaries.push({
      wallet,
      shortAddr: walletData.shortAddr,
      displayName: walletData.displayName,
      pseudonym: walletData.pseudonym,
      pnl: summary.netPnL,
      tradingPnL: summary.totalTradingPnL,
      pnlPct: summary.netPnLPct,
      cost: summary.totalBought,
      revenue: summary.tradingInflow,
      markets: summary.totalMarkets,
      wonCount: summary.wonCount,
      lostCount: summary.lostCount,
      soldCount: summary.soldCount,
      holdCount: summary.holdCount,
      winRate: summary.winRate,
      activePositions: summary.activePositions,
      todayNet: summary.today.net,
      walletUsdc: summary.walletUsdc,
      walletUsdce: summary.walletUsdce,
      walletPusd: summary.walletPusd,
      walletStablecoinTotal: summary.walletStablecoinTotal,
      walletStablecoinAddress: summary.walletStablecoinAddress,
      walletStablecoinSource: summary.walletStablecoinSource,
    });

    for (const day of walletData.dailyPnL) {
      const row = ensureDailyRow(combinedDaily, day.date);
      row.buyCost += day.buyCost;
      row.realizedCostBasis += day.realizedCostBasis || 0;
      row.realizedPnl += day.realizedPnl || 0;
      row.sellRevenue += day.sellRevenue;
      row.redeemRevenue += day.redeemRevenue;
      row.cashBack += day.cashBack;
      row.positionValue += day.positionValue || 0;
      row.externalInflow += day.externalInflow;
      row.externalOutflow += day.externalOutflow;
      row.externalNet += day.externalNet;
      row.tradingNet += day.tradingNet;
      row.tradingMtmNet += day.tradingMtmNet !== undefined ? day.tradingMtmNet : day.tradingNet;
      row.cashNet += day.cashNet !== undefined ? day.cashNet : day.net;
      row.net += day.net;
      row.trades += day.trades;
      row.redeems += day.redeems;
      row.externalEvents += day.externalEvents;
    }
  }

  walletSummaries.sort((a, b) => b.pnl - a.pnl);
  const combinedDailyRows = aggregateDailyRows(combinedDaily);
  const todayKey = currentShanghaiDate();
  const combinedToday = combinedDailyRows.find(row => row.date === todayKey) || emptyDailyRow(todayKey);

  const data = {
    lastUpdated: new Date().toISOString(),
    wallets: WALLETS,
    walletSummaries,
    combined: {
      summary: {
        totalMarkets: combinedMarkets,
        wonCount: combinedWon,
        lostCount: combinedLost,
        soldCount: combinedSold,
        holdCount: combinedHold,
        totalBought: round(combinedTotalBought, 2),
        totalCost: round(combinedTradingOutflow, 2),
        totalRevenue: round(combinedTradingInflow, 2),
        tradingOutflow: round(combinedTradingOutflow, 2),
        tradingInflow: round(combinedTradingInflow, 2),
        redeemRevenue: round(combinedRedeemRevenue, 2),
        realizedTradingPnL: round(combinedRealizedPnL, 2),
        positionPnL: round(combinedPositionPnL, 2),
        totalTradingPnL: round(combinedTradingPnL, 2),
        tradingPnL: round(combinedTradingPnL, 2),
        externalInflow: round(combinedExternalInflow, 2),
        externalOutflow: round(combinedExternalOutflow, 2),
        externalNet: round(combinedExternalInflow - combinedExternalOutflow, 2),
        netPnL: round(combinedNetPnL, 2),
        tradingPnLPct: combinedTotalBought > 0 ? round((combinedTradingPnL / combinedTotalBought) * 100, 1) : 0,
        netPnLPct: combinedTotalBought > 0 ? round((combinedNetPnL / combinedTotalBought) * 100, 1) : 0,
        winRate: combinedWon + combinedLost > 0
          ? round((combinedWon / (combinedWon + combinedLost)) * 100, 1)
          : 0,
        walletCount: WALLETS.length,
        accountValue: round(combinedAccountValue, 2),
        openPositionValue: round(combinedOpenPositionValue, 2),
        claimableValue: round(combinedClaimableValue, 2),
        walletUsdc: round(combinedWalletUsdc, 2),
        walletUsdce: round(combinedWalletUsdce, 2),
        walletPusd: round(combinedWalletPusd, 2),
        walletStablecoinTotal: round(combinedWalletStablecoinTotal, 2),
        activePositions: combinedActivePositions,
        today: {
          date: combinedToday.date,
          buyCost: round(combinedToday.buyCost, 2),
          realizedCostBasis: round(combinedToday.realizedCostBasis, 2),
          realizedPnl: round(combinedToday.realizedPnl, 2),
          cashBack: round(combinedToday.cashBack, 2),
          positionValue: round(combinedToday.positionValue, 2),
          tradingNet: round(combinedToday.tradingNet, 2),
          tradingMtmNet: round(combinedToday.tradingMtmNet !== undefined ? combinedToday.tradingMtmNet : combinedToday.tradingNet, 2),
          externalNet: round(combinedToday.externalNet, 2),
          cashNet: round(combinedToday.cashNet !== undefined ? combinedToday.cashNet : combinedToday.net, 2),
          net: round(combinedToday.net, 2),
          trades: combinedToday.trades,
          redeems: combinedToday.redeems,
          externalEvents: combinedToday.externalEvents,
        },
      },
      dailyPnL: combinedDailyRows,
    },
    data: results,
  };

  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  return data;
}

// ===== API Routes =====
let latestData = null;
let lastFetchTime = 0;
let refreshPromise = null;
const FETCH_INTERVAL = 2 * 60 * 1000;

function loadCachedData() {
  if (latestData) return latestData;
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    latestData = cached;
    lastFetchTime = cached.lastUpdated ? Date.parse(cached.lastUpdated) || 0 : 0;
    console.log(`Loaded cached dashboard data from ${cached.lastUpdated || "unknown time"}`);
    return latestData;
  } catch {
    return null;
  }
}

function refreshDataInBackground(reason = "background") {
  if (refreshPromise) return refreshPromise;
  console.log(`Refreshing dashboard data (${reason})...`);
  refreshPromise = fetchAllData()
    .then(data => {
      latestData = data;
      lastFetchTime = Date.now();
      const summary = data.combined?.summary;
      if (summary) {
        console.log(`Refreshed: ${summary.walletCount} wallets, ${summary.totalMarkets} markets, net P&L: $${summary.netPnL.toFixed(2)}`);
      }
      return data;
    })
    .catch(err => {
      console.error(`Background refresh failed: ${err.message}`);
      return latestData;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

function buildMobileSummary(data, options = {}) {
  const topN = Math.max(1, Math.min(20, Number(options.topN || 8)));
  const combined = data?.combined?.summary || {};
  const wallets = [];
  const positions = [];

  for (const walletSummary of data?.walletSummaries || []) {
    const walletData = data?.data?.[walletSummary.wallet] || {};
    const summary = walletData.summary || walletSummary;

    wallets.push({
      wallet: walletSummary.wallet,
      name: walletSummary.displayName || walletSummary.shortAddr,
      shortAddr: walletSummary.shortAddr,
      balance: round(summary.walletStablecoinTotal, 2),
      usdc: round(summary.walletUsdc, 2),
      usdce: round(summary.walletUsdce, 2),
      pusd: round(summary.walletPusd, 2),
      todayPnl: round(summary.today?.net, 2),
      todayCashBack: round(summary.today?.cashBack, 2),
      todayBuy: round(summary.today?.buyCost, 2),
      todaySoldCost: round(summary.today?.realizedCostBasis, 2),
      openValue: round(toNumber(summary.openPositionValue) + toNumber(summary.claimableValue), 2),
      markets: summary.totalMarkets || walletSummary.markets || 0,
    });

    for (const market of walletData.markets || []) {
      const value = toNumber(market.openValue) + toNumber(market.claimableValue);
      const isActive = market.status === "HOLDING" || value > 0;
      if (!isActive) continue;

      positions.push({
        wallet: walletSummary.wallet,
        walletName: walletSummary.displayName || walletSummary.shortAddr,
        market: market.title,
        side: market.outcome,
        status: market.status,
        shares: round(Object.values(market.outcomeBreakdown || {})
          .filter(outcome => outcome.outcome === market.outcome)
          .reduce((sum, outcome) => sum + toNumber(outcome.buySize) - toNumber(outcome.sellSize), 0), 2),
        value: round(value, 2),
        pnl: round(market.pnl, 2),
        roi: market.pnlPct,
        lastActivity: market.lastTradeTimestamp,
      });
    }
  }

  positions.sort((a, b) => {
    if (toNumber(b.value) !== toNumber(a.value)) return toNumber(b.value) - toNumber(a.value);
    return Math.abs(toNumber(b.pnl)) - Math.abs(toNumber(a.pnl));
  });

  return {
    lastUpdated: data?.lastUpdated || new Date().toISOString(),
    refreshing: Boolean(refreshPromise) || Boolean(data?.refreshing),
    summary: {
      walletCount: combined.walletCount || wallets.length,
      totalBalance: round(combined.walletStablecoinTotal, 2),
      todayPnl: round(combined.today?.net, 2),
      todayCashBack: round(combined.today?.cashBack, 2),
      todayBuy: round(combined.today?.buyCost, 2),
      todaySoldCost: round(combined.today?.realizedCostBasis, 2),
      openValue: round(toNumber(combined.openPositionValue) + toNumber(combined.claimableValue), 2),
      netPnl: round(combined.netPnL, 2),
    },
    wallets,
    positions: positions.slice(0, topN),
  };
}

async function getData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh) {
    const cached = latestData || loadCachedData();
    if (cached) {
      if (now - lastFetchTime >= FETCH_INTERVAL) {
        refreshDataInBackground("stale cache");
      }
      return {
        ...cached,
        refreshing: Boolean(refreshPromise),
      };
    }
  }

  if (!forceRefresh && latestData && now - lastFetchTime < FETCH_INTERVAL) return latestData;
  try {
    latestData = await refreshDataInBackground(forceRefresh ? "manual" : "cold start");
    return latestData;
  } catch (err) {
    console.error("Fetch error:", err.message);
    if (latestData) return latestData;
    return { error: err.message, lastUpdated: new Date().toISOString() };
  }
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/data", async (req, res) => {
  const force = req.query.refresh === "true";
  res.json(await getData(force));
});

app.get("/api/refresh", async (req, res) => {
  try {
    res.json({ success: true, ...await fetchAllData() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/mobile-summary", async (req, res) => {
  const data = await getData(false);
  if (data.error) {
    res.status(503).json(data);
    return;
  }
  res.json(buildMobileSummary(data, { topN: req.query.topN }));
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    wallets: WALLETS.length,
    lastFetch: new Date(lastFetchTime).toISOString(),
  });
});

// ===== Trade Notification =====
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const LOOKBACK_MINUTES = parseInt(process.env.LOOKBACK_MINUTES || "10", 10);
const NOTIFY_INTERVAL_MS = parseInt(process.env.NOTIFY_INTERVAL_MS || "300000", 10);

function loadNotifyState() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "notify_state.json"), "utf-8")); }
  catch { return { lastSentTimestamps: {} }; }
}

function saveNotifyState(state) {
  fs.writeFileSync(path.join(DATA_DIR, "notify_state.json"), JSON.stringify(state, null, 2));
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
      const notifyLookbackBlocks = Math.max(500, Math.ceil(LOOKBACK_MINUTES * 60 / 2) + 300);
      const [dataApiRecentActivity, chainRecentActivity, positions] = await Promise.all([
        apiGet(`https://data-api.polymarket.com/activity?user=${wallet}&limit=200`).catch(() => []),
        fetchChainTradeActivities(wallet, { lookbackBlocks: notifyLookbackBlocks }).catch(() => []),
        apiGet(`https://data-api.polymarket.com/positions?user=${wallet}&limit=500`).catch(() => []),
      ]);
      const recentActivity = mergeActivityFeeds(
        Array.isArray(dataApiRecentActivity) ? dataApiRecentActivity : [],
        Array.isArray(chainRecentActivity) ? chainRecentActivity : [],
      );
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

  loadCachedData();

  app.listen(PORT);
  console.log(`Dashboard ready on http://localhost:${PORT}`);
  refreshDataInBackground("startup");

  if (WEBHOOK_URL) {
    console.log(`Notification: every ${NOTIFY_INTERVAL_MS / 1000}s`);
    runNotification();
    setInterval(runNotification, NOTIFY_INTERVAL_MS);
  }
}

start();
