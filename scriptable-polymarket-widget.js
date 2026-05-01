// Polymarket Dashboard Widget for Scriptable
// 1. Copy this file into Scriptable.
// 2. Replace DASHBOARD_URL with your Render dashboard URL if needed.
// 3. Add a Scriptable widget and choose this script. Large size is recommended.

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
  widget.setPadding(13, 13, 13, 13);

  const summary = data.summary || {};
  addHeader(widget, data.lastUpdated, data.refreshing);
  addSummary(widget, summary);
  widget.addSpacer(9);
  addWallets(widget, data.wallets || []);
  widget.addSpacer(9);
  addPositions(widget, data.positions || []);

  return widget;
}

function addHeader(widget, lastUpdated, refreshing) {
  const row = widget.addStack();
  row.layoutHorizontally();

  const title = row.addText("PM 钱包概览");
  title.font = Font.semiboldSystemFont(15);
  title.textColor = Color.white();

  row.addSpacer();

  const status = row.addText(`${refreshing ? "刷新中 " : "更新 "}${formatUpdated(lastUpdated)}`);
  status.font = Font.mediumSystemFont(10);
  status.textColor = new Color("#9fb3d9");
}

function addSummary(widget, summary) {
  const today = Number(summary.todayPnl || 0);
  const headline = widget.addText(`今日盈亏 ${money(today, true)}`);
  headline.font = Font.boldSystemFont(25);
  headline.textColor = pnlColor(today);
  headline.minimumScaleFactor = 0.65;

  const grid = widget.addStack();
  grid.layoutHorizontally();
  addMetric(grid, "账户余额", money(summary.totalBalance), new Color("#dbeafe"));
  addMetric(grid, "持仓价值", money(summary.openValue), new Color("#93c5fd"));
  addMetric(grid, "总盈亏", money(summary.netPnl, true), pnlColor(summary.netPnl));
}

function addMetric(parent, label, value, color) {
  const box = parent.addStack();
  box.layoutVertically();
  box.size = new Size(96, 31);

  const labelText = box.addText(label);
  labelText.font = Font.mediumSystemFont(9);
  labelText.textColor = new Color("#8fa6cc");
  labelText.lineLimit = 1;

  const valueText = box.addText(value);
  valueText.font = Font.semiboldSystemFont(12);
  valueText.textColor = color;
  valueText.lineLimit = 1;
  valueText.minimumScaleFactor = 0.65;

  parent.addSpacer(5);
}

function addWallets(widget, wallets) {
  addSectionTitle(widget, "钱包明细");
  addWalletHeader(widget);

  for (const wallet of wallets.slice(0, 5)) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    addCell(row, wallet.name || wallet.shortAddr || "钱包", 76, Color.white(), false);
    addCell(row, money(wallet.balance), 58, new Color("#dbeafe"), true);
    addCell(row, money(wallet.todayPnl, true), 58, pnlColor(wallet.todayPnl), true);
    addCell(row, money(wallet.openValue), 58, new Color("#93c5fd"), true);
    addCell(row, money(wallet.totalPnl || 0, true), 58, pnlColor(wallet.totalPnl || 0), true);
  }
}

function addWalletHeader(widget) {
  const row = widget.addStack();
  row.layoutHorizontally();
  addCell(row, "钱包", 76, new Color("#7fa4ff"), false, 9);
  addCell(row, "余额", 58, new Color("#7fa4ff"), true, 9);
  addCell(row, "今日", 58, new Color("#7fa4ff"), true, 9);
  addCell(row, "持仓", 58, new Color("#7fa4ff"), true, 9);
  addCell(row, "总盈亏", 58, new Color("#7fa4ff"), true, 9);
}

function addCell(row, text, width, color, rightAlign, fontSize = 10) {
  const cell = row.addStack();
  cell.size = new Size(width, 14);
  if (rightAlign) cell.addSpacer();

  const label = cell.addText(String(text));
  label.font = Font.mediumSystemFont(fontSize);
  label.textColor = color;
  label.lineLimit = 1;
  label.minimumScaleFactor = 0.55;
}

function addPositions(widget, positions) {
  addSectionTitle(widget, "当前持仓");

  if (positions.length === 0) {
    const empty = widget.addText("暂无当前持仓");
    empty.font = Font.mediumSystemFont(11);
    empty.textColor = new Color("#9fb3d9");
    return;
  }

  for (const position of positions.slice(0, 3)) {
    const market = widget.addText(`${shortMarket(position.market)} / ${position.side}`);
    market.font = Font.mediumSystemFont(10);
    market.textColor = Color.white();
    market.lineLimit = 1;

    const pnl = Number(position.pnl || 0);
    const detail = widget.addText(`份额 ${num(position.shares)} | 价值 ${money(position.value)} | 盈亏 ${money(pnl, true)}`);
    detail.font = Font.mediumSystemFont(9);
    detail.textColor = pnlColor(pnl);
    detail.lineLimit = 1;
  }
}

function addSectionTitle(widget, text) {
  const title = widget.addText(text);
  title.font = Font.semiboldSystemFont(11);
  title.textColor = new Color("#7fa4ff");
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

function pnlColor(value) {
  return Number(value || 0) >= 0 ? new Color("#27e0a3") : new Color("#ff5d73");
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
  return String(name || "市场")
    .replace(/^Will /, "")
    .replace(/\?$/, "")
    .slice(0, 32);
}

function formatUpdated(value) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  const h = `${date.getHours()}`.padStart(2, "0");
  const m = `${date.getMinutes()}`.padStart(2, "0");
  return `${h}:${m}`;
}
