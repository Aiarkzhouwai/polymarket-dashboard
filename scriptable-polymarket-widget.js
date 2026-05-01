// Polymarket Dashboard Widget for Scriptable
// 1. Copy this file into Scriptable.
// 2. Replace DASHBOARD_URL with your Render dashboard URL.
// 3. Add a Scriptable widget to your iOS home screen and choose this script.

const DASHBOARD_URL = "https://polymarket-dashboard-iqi0.onrender.com";
const SUMMARY_URL = `${DASHBOARD_URL.replace(/\/$/, "")}/api/mobile-summary?topN=6`;

main();

async function main() {
  const data = await loadSummary();
  const widget = await createWidget(data);

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentLarge();
  }
  Script.complete();
}

async function loadSummary() {
  const req = new Request(SUMMARY_URL);
  req.timeoutInterval = 15;
  return await req.loadJSON();
}

async function createWidget(data) {
  const widget = new ListWidget();
  widget.url = DASHBOARD_URL;
  widget.backgroundGradient = makeGradient();
  widget.setPadding(14, 14, 14, 14);

  const summary = data.summary || {};
  addHeader(widget, data.lastUpdated, data.refreshing);
  addSummary(widget, summary);
  widget.addSpacer(10);
  addWallets(widget, data.wallets || []);
  widget.addSpacer(10);
  addPositions(widget, data.positions || []);

  return widget;
}

function addHeader(widget, lastUpdated, refreshing) {
  const row = widget.addStack();
  row.layoutHorizontally();

  const title = row.addText("Polymarket");
  title.font = Font.semiboldSystemFont(15);
  title.textColor = Color.white();

  row.addSpacer();

  const updated = formatUpdated(lastUpdated);
  const status = row.addText(`${refreshing ? "↻ " : ""}${updated}`);
  status.font = Font.mediumSystemFont(10);
  status.textColor = new Color("#9fb3d9");
}

function addSummary(widget, summary) {
  const pnl = Number(summary.todayPnl || 0);
  const line = widget.addText(`${money(pnl, true)} today`);
  line.font = Font.boldSystemFont(28);
  line.textColor = pnl >= 0 ? new Color("#27e0a3") : new Color("#ff5d73");
  line.minimumScaleFactor = 0.7;

  const sub = widget.addText(`Balance ${money(summary.totalBalance)} · Open ${money(summary.openValue)} · Net ${money(summary.netPnl, true)}`);
  sub.font = Font.mediumSystemFont(11);
  sub.textColor = new Color("#c9d7f2");
  sub.minimumScaleFactor = 0.8;
}

function addWallets(widget, wallets) {
  const title = widget.addText("Wallets");
  title.font = Font.semiboldSystemFont(11);
  title.textColor = new Color("#7fa4ff");

  for (const wallet of wallets.slice(0, 5)) {
    const row = widget.addStack();
    row.layoutHorizontally();

    const name = row.addText(wallet.name || wallet.shortAddr || "Wallet");
    name.font = Font.mediumSystemFont(11);
    name.textColor = Color.white();
    name.lineLimit = 1;

    row.addSpacer();

    const pnl = Number(wallet.todayPnl || 0);
    const value = row.addText(`${money(pnl, true)}  ${money(wallet.balance)}`);
    value.font = Font.mediumSystemFont(11);
    value.textColor = pnl >= 0 ? new Color("#27e0a3") : new Color("#ff5d73");
    value.minimumScaleFactor = 0.7;
  }
}

function addPositions(widget, positions) {
  const title = widget.addText("Top Positions");
  title.font = Font.semiboldSystemFont(11);
  title.textColor = new Color("#7fa4ff");

  if (positions.length === 0) {
    const empty = widget.addText("No open positions");
    empty.font = Font.mediumSystemFont(11);
    empty.textColor = new Color("#9fb3d9");
    return;
  }

  for (const position of positions.slice(0, 4)) {
    const market = widget.addText(`${shortMarket(position.market)} · ${position.side}`);
    market.font = Font.mediumSystemFont(10);
    market.textColor = Color.white();
    market.lineLimit = 1;

    const pnl = Number(position.pnl || 0);
    const detail = widget.addText(`${num(position.shares)} sh · ${money(position.value)} value · ${money(pnl, true)}`);
    detail.font = Font.mediumSystemFont(10);
    detail.textColor = pnl >= 0 ? new Color("#27e0a3") : new Color("#ff5d73");
    detail.lineLimit = 1;
  }
}

function makeGradient() {
  const gradient = new LinearGradient();
  gradient.colors = [
    new Color("#07111f"),
    new Color("#0d1b33"),
    new Color("#13284a"),
  ];
  gradient.locations = [0, 0.55, 1];
  return gradient;
}

function money(value, signed = false) {
  const numValue = Number(value || 0);
  const sign = signed && numValue > 0 ? "+" : "";
  const abs = Math.abs(numValue);
  const digits = abs >= 1000 ? 0 : 2;
  return `${sign}$${numValue.toFixed(digits)}`;
}

function num(value) {
  const numValue = Number(value || 0);
  return numValue >= 1000 ? numValue.toFixed(0) : numValue.toFixed(2);
}

function shortMarket(name) {
  return String(name || "Market")
    .replace(/^Will /, "")
    .replace(/\?$/, "")
    .slice(0, 34);
}

function formatUpdated(value) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  const h = `${date.getHours()}`.padStart(2, "0");
  const m = `${date.getMinutes()}`.padStart(2, "0");
  return `${h}:${m}`;
}
