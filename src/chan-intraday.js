import { INDEXES, fetchIndexMinuteHistory } from './tencentDataSource.js';
import NotificationService from '../lib/notificationService.js';
import {
  normalizeContainment,
  findFractals,
  buildStrokes,
  enrichStrokesWithStrength,
  buildSegments,
  buildCenters,
  buildSignals
} from './chan.js';

const DEFAULT_SYMBOL = 'sh000001';
const DEFAULT_PERIOD = 'm30';
const INITIAL_CASH = 1000000;
const MAX_CENTER_AREAS = 8;
// 显示所有股票，不排除任何标的
const INTRADAY_INDEXES = INDEXES;
const MONITOR_PERIODS = ['m15', 'm30'];
const MONITOR_PERIOD_SET = new Set(MONITOR_PERIODS);
const MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const NOTIFY_ENABLED_KEY = 'fearGreed.intradayNotifyEnabled';
const SEEN_SIGNAL_KEY = 'fearGreed.intradaySeenSignals';
const LIVE_SIGNAL_LOG_KEY = 'fearGreed.intradayLiveSignalLog';
const MAX_SEEN_SIGNAL_KEYS = 2500;
const MAX_LIVE_SIGNAL_RECORDS = 5000;
const RECENT_SIGNAL_CAPTURE_BARS = 2;
const PERIOD_OPTIONS = [
  { value: 'm30', label: '30分钟', limit: 1600 },
  { value: 'm60', label: '60分钟', limit: 1600 },
  { value: 'm15', label: '15分钟', limit: 1600 },
  { value: 'm5', label: '5分钟', limit: 1600 }
];

NotificationService.setConfig({ strategyName: '分钟缠论' });

const numberFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

let chartInstance = null;
let periodPayload = {};
let currentSymbol = DEFAULT_SYMBOL;
let currentPeriod = DEFAULT_PERIOD;
let isSwitching = false;
let notifyEnabled = false;
let monitorTimerId = null;
let monitorRefreshInProgress = false;
let seenSignalKeys = new Set();
let baselineKeys = new Set();
let liveSignalRecords = [];
let signalNavigationBound = false;

function formatNumber(value) {
  if (value === null || !Number.isFinite(value)) {
    return '--';
  }
  return numberFormatter.format(value);
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

function round(value, digits = 2) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function parseDateTime(value) {
  return new Date(`${String(value).replace(' ', 'T')}+08:00`);
}

function minutesBetween(startDate, endDate) {
  const start = parseDateTime(startDate);
  const end = parseDateTime(endDate);
  const diff = end - start;
  if (!Number.isFinite(diff)) {
    return null;
  }
  return Math.max(0, Math.round(diff / 60000));
}

function formatDuration(minutes) {
  if (minutes === null) {
    return '--';
  }
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  if (minutes < 1440) {
    return `${round(minutes / 60, 1)} 小时`;
  }
  return `${round(minutes / 1440, 1)} 天`;
}

function periodLabel(period = currentPeriod) {
  const option = PERIOD_OPTIONS.find((item) => item.value === period);
  return option ? option.label : period;
}

function isMonitoredPeriod(period) {
  return MONITOR_PERIOD_SET.has(period);
}

function symbolName(symbol = currentSymbol) {
  return INTRADAY_INDEXES[symbol] || INDEXES[symbol] || symbol;
}

function cacheKey(symbol, period) {
  return `${symbol}:${period}`;
}

function getStoredNotifyEnabled() {
  try {
    return localStorage.getItem(NOTIFY_ENABLED_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function setStoredNotifyEnabled(value) {
  try {
    localStorage.setItem(NOTIFY_ENABLED_KEY, value ? '1' : '0');
  } catch (error) {
    // The current in-memory state still controls this page session.
  }
}

function loadSeenSignalKeys() {
  try {
    const raw = localStorage.getItem(SEEN_SIGNAL_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    seenSignalKeys = new Set(Array.isArray(parsed) ? parsed : []);
  } catch (error) {
    seenSignalKeys = new Set();
  }
}

function saveSeenSignalKeys() {
  const keys = Array.from(seenSignalKeys).slice(-MAX_SEEN_SIGNAL_KEYS);
  seenSignalKeys = new Set(keys);
  try {
    localStorage.setItem(SEEN_SIGNAL_KEY, JSON.stringify(keys));
  } catch (error) {
    // Ignore storage failures; in-memory de-duping still works for this page session.
  }
}

function signalKey(symbol, period, signal) {
  return [
    symbol,
    period,
    signal.type,
    signal.signalName,
    signal.structureDate,
    signal.executeDate
  ].join(':');
}

function getTradableSignals(data) {
  return data.signals.filter((signal) => signal.type === 'buy' || signal.type === 'sell');
}

function markBaselineSignals(data) {
  const { symbol, period } = data.meta;
  getTradableSignals(data).forEach((signal) => {
    seenSignalKeys.add(signalKey(symbol, period, signal));
  });
  baselineKeys.add(cacheKey(symbol, period));
}

function loadLiveSignalRecords() {
  try {
    const raw = localStorage.getItem(LIVE_SIGNAL_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    liveSignalRecords = Array.isArray(parsed) ? parsed.filter((record) => record && record.id) : [];
  } catch (error) {
    liveSignalRecords = [];
  }
}

function saveLiveSignalRecords() {
  liveSignalRecords = liveSignalRecords.slice(-MAX_LIVE_SIGNAL_RECORDS);
  try {
    localStorage.setItem(LIVE_SIGNAL_LOG_KEY, JSON.stringify(liveSignalRecords));
  } catch (error) {
    // The in-memory ledger still protects this page session if browser storage is full.
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[char];
  });
}

function formatLogTime(value) {
  if (!value) {
    return '--';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function liveSignalId(symbol, period, signal) {
  return signalKey(symbol, period, signal);
}

function createLiveSignalRecord(data, signal, source = 'monitor') {
  const { symbol, name, period } = data.meta;
  const now = new Date().toISOString();
  return {
    id: liveSignalId(symbol, period, signal),
    symbol,
    name,
    period,
    type: signal.type,
    action: signal.action,
    signalName: signal.signalName,
    structureDate: signal.structureDate,
    confirmDate: signal.confirmDate,
    executeDate: signal.executeDate,
    executePrice: signal.executePrice,
    structurePrice: signal.structurePrice,
    referenceText: signal.referenceText || '',
    description: signal.description || '',
    centerId: signal.centerId || null,
    centerLow: signal.centerLow || null,
    centerHigh: signal.centerHigh || null,
    centerStatus: signal.centerStatus || null,
    source,
    createdAt: now,
    lastSeenAt: now,
    firstMissingAt: null,
    lastCheckedAt: now,
    status: 'recorded',
    statusLabel: '已记录',
    remedyText: '等待下一轮分钟 K 验证信号是否稳定',
    lastNotifiedStatus: null,
    latestDate: null,
    latestClose: null
  };
}

function upsertLiveSignalRecord(data, signal, { source = 'monitor' } = {}) {
  const id = liveSignalId(data.meta.symbol, data.meta.period, signal);
  const existing = liveSignalRecords.find((record) => record.id === id);
  const now = new Date().toISOString();

  if (existing) {
    existing.lastSeenAt = now;
    existing.firstMissingAt = null;
    existing.name = data.meta.name;
    existing.referenceText = signal.referenceText || existing.referenceText || '';
    existing.description = signal.description || existing.description || '';
    return false;
  }

  liveSignalRecords.push(createLiveSignalRecord(data, signal, source));
  return true;
}

function captureRecentLiveSignals(data, { source = 'view' } = {}) {
  if (!data.rows.length) {
    return 0;
  }

  const recentDates = new Set(
    data.rows.slice(-RECENT_SIGNAL_CAPTURE_BARS).map((row) => row.date)
  );
  let createdCount = 0;

  getTradableSignals(data).forEach((signal) => {
    if (!recentDates.has(signal.executeDate)) {
      return;
    }
    if (upsertLiveSignalRecord(data, signal, { source })) {
      createdCount += 1;
    }
  });

  if (createdCount > 0) {
    saveLiveSignalRecords();
  }

  return createdCount;
}

function isLiveRecordForData(record, data) {
  return record.symbol === data.meta.symbol && record.period === data.meta.period;
}

function currentSignalExists(record, data) {
  return getTradableSignals(data).some(
    (signal) => liveSignalId(data.meta.symbol, data.meta.period, signal) === record.id
  );
}

function findOppositeSignal(record, data) {
  return getTradableSignals(data)
    .filter((signal) => signal.type !== record.type && signal.executeDate > record.executeDate)
    .sort((a, b) => b.executeDate.localeCompare(a.executeDate))[0] || null;
}

function rowsFromSignal(data, record) {
  return data.rows.filter((row) => row.date >= record.executeDate);
}

function isStructureBroken(record, data) {
  const structurePrice = Number(record.structurePrice);
  if (!Number.isFinite(structurePrice)) {
    return false;
  }

  const rows = rowsFromSignal(data, record);
  if (record.type === 'buy') {
    return rows.some((row) => Number.isFinite(row.low) && row.low < structurePrice);
  }
  return rows.some((row) => Number.isFinite(row.high) && row.high > structurePrice);
}

function liveStatusClass(status) {
  const classMap = {
    active: 'live-active',
    repainted: 'live-repainted',
    broken: 'live-broken',
    opposite: 'live-opposite',
    recorded: 'live-recorded'
  };
  return classMap[status] || 'live-recorded';
}

function evaluateLiveSignalRecord(record, data) {
  const latest = data.rows[data.rows.length - 1];
  const now = new Date().toISOString();
  const exists = currentSignalExists(record, data);
  const oppositeSignal = findOppositeSignal(record, data);
  const structureBroken = isStructureBroken(record, data);
  let status = 'active';
  let statusLabel = '有效跟踪';
  let remedyText =
    record.type === 'buy'
      ? '买点仍在当前结构内，继续用结构低点做防守线'
      : '卖点仍在当前结构内，继续用结构高点判断是否需要补回';

  if (oppositeSignal) {
    status = 'opposite';
    statusLabel = record.type === 'buy' ? '反向卖点' : '反向买点';
    remedyText =
      record.type === 'buy'
        ? `${oppositeSignal.executeDate} 出现 ${oppositeSignal.signalName}，优先退出或至少降仓`
        : `${oppositeSignal.executeDate} 出现 ${oppositeSignal.signalName}，重新评估补回`;
  } else if (structureBroken) {
    status = 'broken';
    statusLabel = record.type === 'buy' ? '跌破结构' : '突破结构';
    remedyText =
      record.type === 'buy'
        ? `已跌破买点结构位 ${formatNumber(record.structurePrice)}，按补救规则止损或降仓`
        : `已突破卖点结构位 ${formatNumber(record.structurePrice)}，卖点失效，考虑补回`;
  } else if (!exists) {
    status = 'repainted';
    statusLabel = '已重绘';
    remedyText =
      record.type === 'buy'
        ? '买点已从当前重算结构中消失，保留记录并收紧到结构低点防守'
        : '卖点已从当前重算结构中消失，保留记录并观察是否重新站回结构高点';
  }

  if (exists) {
    record.lastSeenAt = now;
    record.firstMissingAt = null;
  } else if (!record.firstMissingAt) {
    record.firstMissingAt = now;
  }

  record.status = status;
  record.statusLabel = statusLabel;
  record.remedyText = remedyText;
  record.lastCheckedAt = now;
  record.latestDate = latest ? latest.date : null;
  record.latestClose = latest ? latest.close : null;
  record.signalPresent = exists;

  return record;
}

function shouldNotifyLiveStatus(status) {
  return status === 'repainted' || status === 'broken' || status === 'opposite';
}

function sendLiveSignalRemedyNotification(data, record) {
  if (!notifyEnabled) {
    return;
  }

  const message = [
    `### ${record.name || data.meta.name} ${periodLabel(record.period)} ${record.statusLabel}`,
    `- 原信号：${record.signalName} ${record.action}`,
    `- 成交时间：${record.executeDate}`,
    `- 提示价格：${formatNumber(record.executePrice)}`,
    `- 最新价格：${formatNumber(record.latestClose)}`,
    `- 补救：${record.remedyText}`
  ].join('\n');

  NotificationService.addNotification(message, `remedy:${record.status}`, `${record.id}:${record.status}`);
}

function updateLiveSignalRecordsForData(data, { notify = false } = {}) {
  let changedCount = 0;

  liveSignalRecords.forEach((record) => {
    if (!isLiveRecordForData(record, data)) {
      return;
    }

    const previousStatus = record.status;
    evaluateLiveSignalRecord(record, data);
    if (
      notify &&
      previousStatus &&
      previousStatus !== record.status &&
      shouldNotifyLiveStatus(record.status)
    ) {
      changedCount += 1;
      if (notifyEnabled && record.lastNotifiedStatus !== record.status) {
        sendLiveSignalRemedyNotification(data, record);
        record.lastNotifiedStatus = record.status;
      }
    }
  });

  saveLiveSignalRecords();
  return changedCount;
}

function liveRecordsForData(data) {
  return liveSignalRecords
    .filter((record) => isLiveRecordForData(record, data))
    .slice()
    .sort(
      (a, b) =>
        b.executeDate.localeCompare(a.executeDate) ||
        String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    );
}

function formatClock(date = new Date()) {
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatCenterRange(center) {
  if (!center) {
    return '--';
  }
  return `${formatNumber(center.low)} - ${formatNumber(center.high)}`;
}

function getPeriodConfig(period) {
  return PERIOD_OPTIONS.find((item) => item.value === period) || PERIOD_OPTIONS[0];
}

function signalIdentity(signal) {
  return [
    signal.signalName,
    signal.structureDate,
    signal.confirmDate,
    signal.executeDate
  ].join(':');
}

function createStrokePreview(rows, strokes) {
  if (!rows.length || !strokes.length) {
    return null;
  }

  const latestStroke = strokes[strokes.length - 1];
  const rowsAfterStroke = rows.filter((row) => row.date > latestStroke.endDate);
  if (!rowsAfterStroke.length) {
    return null;
  }

  const isUp = latestStroke.direction === 'up';
  const sameDirectionRow = isUp
    ? findExtremeRow(rowsAfterStroke, 'high', (price, bestPrice) => price > bestPrice)
    : findExtremeRow(rowsAfterStroke, 'low', (price, bestPrice) => price < bestPrice);
  const sameDirectionPrice = sameDirectionRow ? (isUp ? sameDirectionRow.high : sameDirectionRow.low) : null;
  const extendsLatestStroke = Number.isFinite(sameDirectionPrice) && (
    isUp ? sameDirectionPrice > latestStroke.endPrice : sameDirectionPrice < latestStroke.endPrice
  );

  if (extendsLatestStroke) {
    return {
      ...latestStroke,
      endDate: sameDirectionRow.date,
      confirmDate: sameDirectionRow.date,
      endPrice: sameDirectionPrice,
      low: Math.min(latestStroke.startPrice, sameDirectionPrice),
      high: Math.max(latestStroke.startPrice, sameDirectionPrice),
      changePct: round((sameDirectionPrice / latestStroke.startPrice - 1) * 100),
      preview: true,
      previewKind: 'extension',
      previewLineStartDate: latestStroke.endDate,
      previewLineStartPrice: latestStroke.endPrice
    };
  }

  const reverseRow = isUp
    ? findExtremeRow(rowsAfterStroke, 'low', (price, bestPrice) => price < bestPrice)
    : findExtremeRow(rowsAfterStroke, 'high', (price, bestPrice) => price > bestPrice);
  const reversePrice = reverseRow ? (isUp ? reverseRow.low : reverseRow.high) : null;
  if (!Number.isFinite(reversePrice)) {
    return null;
  }

  const direction = isUp ? 'down' : 'up';
  return {
    id: latestStroke.id + 1,
    direction,
    startDate: latestStroke.endDate,
    endDate: reverseRow.date,
    confirmDate: reverseRow.date,
    startIndex: latestStroke.endIndex,
    endIndex: latestStroke.endIndex + rowsAfterStroke.indexOf(reverseRow) + 1,
    startPrice: latestStroke.endPrice,
    endPrice: reversePrice,
    low: Math.min(latestStroke.endPrice, reversePrice),
    high: Math.max(latestStroke.endPrice, reversePrice),
    changePct: round((reversePrice / latestStroke.endPrice - 1) * 100),
    preview: true,
    previewKind: 'reverse',
    previewLineStartDate: latestStroke.endDate,
    previewLineStartPrice: latestStroke.endPrice
  };
}

function buildPreviewLayer(rows, strokes, centers, signals) {
  const previewStroke = createStrokePreview(rows, strokes);
  if (!previewStroke) {
    return {
      stroke: null,
      strokes,
      centers,
      signals: []
    };
  }

  const rawPreviewStrokes = previewStroke.previewKind === 'extension'
    ? strokes.slice(0, -1).concat(previewStroke)
    : strokes.concat(previewStroke);
  const previewStrokes = enrichStrokesWithStrength(rawPreviewStrokes, rows);
  const previewCenters = buildCenters(previewStrokes);
  const officialSignalKeys = new Set(signals.map(signalIdentity));
  const previewSignals = buildSignals(previewStrokes, rows, previewCenters)
    .filter((signal) => signal.structureDate === previewStroke.endDate)
    .filter((signal) => !officialSignalKeys.has(signalIdentity(signal)))
    .map((signal) => ({
      ...signal,
      preview: true,
      signalName: `预判${signal.signalName}`,
      originalSignalName: signal.signalName,
      description: `预判：${signal.description}`
    }));

  const enrichedPreviewStroke = previewStrokes.find((stroke) => stroke.preview) || previewStroke;

  return {
    stroke: enrichedPreviewStroke,
    strokes: previewStrokes,
    centers: previewCenters,
    signals: previewSignals
  };
}

function calculateAnalysis(rows) {
  const cleanRows = rows.filter(
    (row) =>
      Number.isFinite(row.open) &&
      Number.isFinite(row.close) &&
      Number.isFinite(row.high) &&
      Number.isFinite(row.low)
  );
  const bars = normalizeContainment(cleanRows);
  const fractals = findFractals(bars);
  const strokes = buildStrokes(fractals, cleanRows);
  const segments = buildSegments(strokes);
  const centers = buildCenters(strokes);
  const signals = buildSignals(strokes, cleanRows, centers);
  const previewLayer = buildPreviewLayer(cleanRows, strokes, centers, signals);

  return {
    rows: cleanRows,
    bars,
    fractals,
    strokes,
    segments,
    centers,
    signals,
    previewStrokes: previewLayer.strokes,
    previewCenters: previewLayer.centers,
    previewSignals: previewLayer.signals,
    previewStroke: previewLayer.stroke,
    tradeResult: buildTradeRecords(signals, cleanRows)
  };
}

function buildTradeRecords(signals, rows) {
  let cash = INITIAL_CASH;
  let shares = 0;
  let holding = false;
  let buySignal = null;
  let completedTrades = 0;
  let winningTrades = 0;
  const records = [];
  let totalReturnPct = 0;

  signals.forEach((signal) => {
    if (signal.type === 'buy' && !holding) {
      shares = cash / signal.executePrice;
      cash = 0;
      holding = true;
      buySignal = signal;
      records.push({
        ...signal,
        profitPct: null,
        holdingMinutes: null
      });
      return;
    }

    if (signal.type === 'sell' && holding) {
      cash = shares * signal.executePrice;
      shares = 0;
      holding = false;
      completedTrades += 1;
      const tradeProfitPct = (signal.executePrice / buySignal.executePrice - 1) * 100;
      totalReturnPct += tradeProfitPct;
      if (signal.executePrice > buySignal.executePrice) {
        winningTrades += 1;
      }
      records.push({
        ...signal,
        profitPct: tradeProfitPct,
        holdingMinutes: minutesBetween(buySignal.executeDate, signal.executeDate)
      });
      buySignal = null;
    }
  });

  const latest = rows[rows.length - 1];
  const finalValue = latest ? cash + shares * latest.close : INITIAL_CASH;

  return {
    records,
    summary: {
      finalValue,
      profit: finalValue - INITIAL_CASH,
      returnPct: totalReturnPct,
      holding,
      operationCount: records.length,
      winRatePct: completedTrades ? (winningTrades / completedTrades) * 100 : null
    }
  };
}

function renderSymbolSwitcher() {
  const switcher = document.getElementById('intraday-symbol-switcher');
  if (!switcher) {
    return;
  }

  switcher.innerHTML = '';
  Object.entries(INTRADAY_INDEXES).forEach(([symbol, name]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `index-pill${symbol === currentSymbol ? ' active' : ''}`;
    button.dataset.symbol = symbol;
    button.innerHTML = `
      <strong>${name}</strong>
      <span>${symbol}</span>
    `;
    button.addEventListener('click', () => showSymbol(symbol));
    switcher.appendChild(button);
  });
}

function renderPeriodSwitcher() {
  const switcher = document.getElementById('intraday-period-switcher');
  switcher.innerHTML = '';

  PERIOD_OPTIONS.forEach((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `period-pill${option.value === currentPeriod ? ' active' : ''}`;
    button.dataset.period = option.value;
    button.textContent = option.label;
    button.addEventListener('click', () => showPeriod(option.value));
    switcher.appendChild(button);
  });
}

function updateActiveSymbol(symbol) {
  document.querySelectorAll('#intraday-symbol-switcher .index-pill').forEach((button) => {
    button.classList.toggle('active', button.dataset.symbol === symbol);
  });
}

function updateActivePeriod(period) {
  document.querySelectorAll('.period-pill').forEach((button) => {
    button.classList.toggle('active', button.dataset.period === period);
  });
}

function setNotifyText(state, detail) {
  setText('intraday-notify-state', state);
  setText('intraday-notify-detail', detail);
}

function updateNotifyControls(detail = null) {
  const button = document.getElementById('intraday-notify-toggle');
  if (!button) {
    return;
  }

  button.disabled = false;
  button.classList.toggle('off', !notifyEnabled);
  button.textContent = notifyEnabled ? '暂停微信提醒' : '开启微信提醒';
  setNotifyText(
    notifyEnabled ? '微信提醒中' : '刷新中',
    detail || (notifyEnabled ? '每 5 分钟刷新 15/30 分钟，有新信号会微信推送' : '每 5 分钟刷新，微信提醒未开启')
  );
}

async function toggleNotifications() {
  if (notifyEnabled) {
    notifyEnabled = false;
    setStoredNotifyEnabled(false);
    updateNotifyControls('继续每 5 分钟刷新，仅暂停微信提醒');
    return;
  }

  notifyEnabled = true;
  setStoredNotifyEnabled(true);
  startMonitorTimer();
  updateNotifyControls('微信提醒已开启，等待下一轮刷新');
}

function initNotificationControls() {
  const button = document.getElementById('intraday-notify-toggle');
  if (!button) {
    return;
  }

  button.addEventListener('click', toggleNotifications);
  notifyEnabled = getStoredNotifyEnabled();
  updateNotifyControls();
}

function buildStrokeLineData(strokes) {
  if (!strokes.length) {
    return [];
  }

  const first = strokes[0];
  return [[first.startDate, first.startPrice]].concat(
    strokes.map((stroke) => [stroke.endDate, stroke.endPrice])
  );
}

function findExtremeRow(rows, priceKey, compare) {
  return rows.reduce((best, row) => {
    const price = row[priceKey];
    if (!Number.isFinite(price)) {
      return best;
    }
    if (!best || compare(price, best[priceKey])) {
      return row;
    }
    return best;
  }, null);
}

function buildTemporaryStrokeLineData(previewStroke) {
  if (!previewStroke) {
    return [];
  }

  return [
    [previewStroke.previewLineStartDate || previewStroke.startDate, previewStroke.previewLineStartPrice || previewStroke.startPrice],
    [previewStroke.endDate, previewStroke.endPrice]
  ];
}

function buildSegmentLineData(segments) {
  if (!segments.length) {
    return [];
  }

  const first = segments[0];
  return [[first.startDate, first.startPrice]].concat(
    segments.map((segment) => [segment.endDate, segment.endPrice])
  );
}

function buildCenterAreas(centers) {
  return centers.slice(-MAX_CENTER_AREAS).map((center) => [
    {
      name: `中枢 ${center.id} ${center.phaseLabel || '形成中'}`,
      xAxis: center.startDate,
      yAxis: center.low
    },
    {
      xAxis: center.endDate,
      yAxis: center.high
    }
  ]);
}

function buildSignalScatter(signals, signalName) {
  return signals
    .filter((signal) => signal.signalName === signalName)
    .map((signal) => ({
      name: signal.signalName,
      value: [signal.executeDate, signal.executePrice],
      signal
    }));
}

function buildPreviewSignalScatter(signals) {
  return signals.map((signal) => ({
    name: signal.signalName,
    value: [signal.executeDate, signal.executePrice],
    signal
  }));
}

function buildOption(data) {
  const { rows, strokes, segments, centers, signals, previewSignals = [], previewStroke, meta } = data;
  const name = meta.name;
  const dates = rows.map((row) => row.date);
  const candles = rows.map((row) => [row.open, row.close, row.low, row.high]);
  const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#687789';
  const priceColor = getComputedStyle(document.documentElement).getPropertyValue('--price').trim() || '#2563eb';
  const splitColor = 'rgba(104, 119, 137, 0.16)';

  return {
    animation: true,
    backgroundColor: 'transparent',
    grid: { left: 70, right: 70, top: 54, bottom: 78 },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        label: { backgroundColor: '#3d4854' }
      },
      backgroundColor: 'rgba(30, 35, 41, 0.92)',
      borderWidth: 0,
      textStyle: { color: '#fdf8f1' },
      formatter(params) {
        const items = Array.isArray(params) ? params : [params];
        const axisDate = items[0] && (items[0].axisValue || (items[0].value && items[0].value[0]));
        const row = rows.find((item) => item.date === axisDate);
        if (!row) {
          return '';
        }
        const daySignals = signals.filter((signal) => signal.executeDate === row.date);
        const dayPreviewSignals = previewSignals.filter((signal) => signal.executeDate === row.date);
        return [
          `<div style="margin-bottom:6px;font-weight:600;">${row.date}</div>`,
          `${name} 开: ${formatNumber(row.open)} 高: ${formatNumber(row.high)}`,
          `低: ${formatNumber(row.low)} 收: ${formatNumber(row.close)}`,
          daySignals.length
            ? `<div style="margin-top:6px;color:#ffd7a8;">信号: ${daySignals
                .map((signal) => `${signal.signalName} ${signal.action}`)
                .join(' / ')}</div>`
            : '',
          dayPreviewSignals.length
            ? `<div style="margin-top:6px;color:#fbbf24;">预判: ${dayPreviewSignals
                .map((signal) => `${signal.signalName} ${signal.action}`)
                .join(' / ')}</div>`
            : ''
        ]
          .filter(Boolean)
          .join('<br>');
      }
    },
    toolbox: {
      right: 18,
      top: 10,
      feature: {
        dataZoom: { yAxisIndex: 'none' },
        restore: {},
        saveAsImage: { name: `${meta.symbol}-chan-${currentPeriod}` }
      },
      iconStyle: { borderColor: mutedColor }
    },
    legend: {
      top: 12,
      left: 22,
      textStyle: { color: mutedColor },
      data: [name, '笔', '临时笔', '线段', '一买', '一卖', '二买', '二卖', '底背驰', '顶背驰', '预判信号']
    },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: true,
      axisLine: { lineStyle: { color: splitColor } },
      axisLabel: { color: mutedColor, hideOverlap: true },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: {
        color: mutedColor,
        formatter(value) {
          return value.toFixed(0);
        }
      },
      splitLine: { lineStyle: { color: splitColor, type: 'dashed' } }
    },
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      {
        type: 'slider',
        height: 24,
        bottom: 18,
        borderColor: 'rgba(104, 119, 137, 0.24)',
        backgroundColor: '#f8fafc',
        fillerColor: 'rgba(37, 99, 235, 0.14)',
        handleStyle: { color: priceColor }
      }
    ],
    series: [
      {
        name,
        type: 'candlestick',
        data: candles,
        itemStyle: {
          color: '#dc2626',
          color0: '#059669',
          borderColor: '#dc2626',
          borderColor0: '#059669'
        },
        markArea: {
          silent: true,
          label: {
            color: mutedColor,
            fontSize: 11
          },
          itemStyle: {
            color: 'rgba(217, 119, 6, 0.11)',
            borderColor: 'rgba(217, 119, 6, 0.28)',
            borderWidth: 1
          },
          data: buildCenterAreas(centers)
        }
      },
      {
        name: '笔',
        type: 'line',
        data: buildStrokeLineData(strokes),
        showSymbol: true,
        symbolSize: 6,
        smooth: false,
        lineStyle: { width: 2, color: '#0d9488' },
        itemStyle: { color: '#0d9488' }
      },
      {
        name: '临时笔',
        type: 'line',
        data: buildTemporaryStrokeLineData(previewStroke),
        showSymbol: true,
        symbolSize: 6,
        smooth: false,
        lineStyle: { width: 2, color: '#f59e0b', type: 'dashed' },
        itemStyle: { color: '#f59e0b' },
        z: 5
      },
      {
        name: '线段',
        type: 'line',
        data: buildSegmentLineData(segments),
        showSymbol: true,
        symbolSize: 7,
        smooth: false,
        lineStyle: { width: 3, color: '#7c3aed' },
        itemStyle: { color: '#7c3aed' },
        z: 4
      },
      {
        name: '一买',
        type: 'scatter',
        data: buildSignalScatter(signals, '一买'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#2563eb',
          borderColor: '#bfdbfe',
          borderWidth: 2,
          shadowBlur: 4,
          shadowColor: 'rgba(15, 23, 42, 0.24)'
        }
      },
      {
        name: '一卖',
        type: 'scatter',
        data: buildSignalScatter(signals, '一卖'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#d97706',
          borderColor: '#fed7aa',
          borderWidth: 2,
          shadowBlur: 4,
          shadowColor: 'rgba(15, 23, 42, 0.24)'
        }
      },
      {
        name: '二买',
        type: 'scatter',
        data: buildSignalScatter(signals, '二买'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#7c3aed',
          borderColor: '#ddd6fe',
          borderWidth: 2,
          shadowBlur: 4,
          shadowColor: 'rgba(15, 23, 42, 0.24)'
        }
      },
      {
        name: '二卖',
        type: 'scatter',
        data: buildSignalScatter(signals, '二卖'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#c026d3',
          borderColor: '#f5d0fe',
          borderWidth: 2,
          shadowBlur: 4,
          shadowColor: 'rgba(15, 23, 42, 0.24)'
        }
      },
      {
        name: '底背驰',
        type: 'scatter',
        data: buildSignalScatter(signals, '底背驰'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#0284c7',
          borderColor: '#bae6fd',
          borderWidth: 2,
          shadowBlur: 4,
          shadowColor: 'rgba(15, 23, 42, 0.24)'
        }
      },
      {
        name: '顶背驰',
        type: 'scatter',
        data: buildSignalScatter(signals, '顶背驰'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#334155',
          borderColor: '#cbd5e1',
          borderWidth: 2,
          shadowBlur: 4,
          shadowColor: 'rgba(15, 23, 42, 0.24)'
        }
      },
      {
        name: '预判信号',
        type: 'scatter',
        data: buildPreviewSignalScatter(previewSignals),
        symbol: 'diamond',
        symbolSize: 13,
        itemStyle: {
          color: '#f59e0b',
          borderColor: '#fef3c7',
          borderWidth: 2,
          shadowBlur: 4,
          shadowColor: 'rgba(15, 23, 42, 0.22)'
        }
      }
    ]
  };
}

function renderChart(data) {
  const chartDom = document.getElementById('chart');
  if (!chartInstance) {
    chartInstance = echarts.init(chartDom, null, { renderer: 'canvas' });
    window.addEventListener('resize', () => chartInstance && chartInstance.resize());
  }

  chartInstance.setOption(buildOption(data), true);
}

function renderBacktestSummary(summary) {
  const profitClass = summary.profit >= 0 ? 'positive' : 'negative';

  setText('initial-cash', formatNumber(INITIAL_CASH));
  setText('final-value', formatNumber(summary.finalValue));
  setText('total-profit', formatNumber(summary.profit));
  setText('total-return', `${formatNumber(summary.returnPct)}%`);
  setText('operation-count', `${summary.operationCount} 次`);
  setText('win-rate', summary.winRatePct === null ? '--' : `${formatNumber(summary.winRatePct)}%`);
  setText('position-status', summary.holding ? '持仓中' : '空仓');

  document.getElementById('total-profit').className = profitClass;
  document.getElementById('total-return').className = profitClass;
}

function renderTradeTable(records) {
  const tableBody = document.getElementById('trade-list');
  const emptyText = document.getElementById('trade-empty');
  tableBody.innerHTML = '';
  emptyText.hidden = records.length > 0;

  records
    .slice()
    .sort((a, b) => b.executeDate.localeCompare(a.executeDate))
    .forEach((record) => {
    const tr = document.createElement('tr');
    const isBuy = record.type === 'buy';
    const profitClass =
      record.profitPct === null ? '' : record.profitPct >= 0 ? 'positive' : 'negative';

    tr.innerHTML = `
      <td>${record.structureDate}</td>
      <td>${record.confirmDate}</td>
      <td>${record.executeDate}</td>
      <td><span class="trade-badge ${isBuy ? 'buy' : 'sell'}">${record.action}</span></td>
      <td>${record.signalName}</td>
      <td>${formatNumber(record.executePrice)}</td>
      <td>${record.referenceText || '--'}</td>
      <td class="${profitClass}">${record.profitPct === null ? '--' : `${formatNumber(record.profitPct)}%`}</td>
      <td>${formatDuration(record.holdingMinutes)}</td>
    `;
    tableBody.appendChild(tr);
  });
}

function renderLiveSignalLedger(data) {
  const tableBody = document.getElementById('live-signal-list');
  const emptyText = document.getElementById('live-signal-empty');
  if (!tableBody || !emptyText) {
    return;
  }

  const records = liveRecordsForData(data);
  const activeCount = records.filter((record) => record.status === 'active').length;
  const rescueCount = records.filter((record) =>
    record.status === 'repainted' || record.status === 'broken' || record.status === 'opposite'
  ).length;
  const latestCheckedAt = records
    .map((record) => record.lastCheckedAt)
    .filter(Boolean)
    .sort()
    .pop();

  setText('live-record-count', `${records.length} 条`);
  setText('live-active-count', `${activeCount} 条`);
  setText('live-rescue-count', `${rescueCount} 条`);
  setText('live-ledger-updated', latestCheckedAt ? formatLogTime(latestCheckedAt) : '--');

  tableBody.innerHTML = '';
  emptyText.hidden = records.length > 0;

  records.forEach((record) => {
    const tr = document.createElement('tr');
    const isBuy = record.type === 'buy';
    tr.innerHTML = `
      <td>${escapeHtml(formatLogTime(record.createdAt))}</td>
      <td>${escapeHtml(record.executeDate || '--')}</td>
      <td><span class="trade-badge ${isBuy ? 'buy' : 'sell'}">${escapeHtml(record.action || '--')}</span></td>
      <td>${escapeHtml(record.signalName || '--')}</td>
      <td>${formatNumber(record.executePrice)}</td>
      <td>${formatNumber(record.structurePrice)}</td>
      <td><span class="status-badge ${liveStatusClass(record.status)}">${escapeHtml(record.statusLabel || '--')}</span></td>
      <td class="live-remedy">${escapeHtml(record.remedyText || '--')}</td>
    `;
    tableBody.appendChild(tr);
  });
}

function centerForStroke(stroke, centers) {
  return [...centers]
    .reverse()
    .find((center) => stroke.id - 1 >= center.strokeStartIndex && stroke.id - 1 <= center.strokeEndIndex);
}

function renderStrokeTable(strokes, centers) {
  const tableBody = document.getElementById('stroke-list');
  tableBody.innerHTML = '';

  strokes.slice(-18).forEach((stroke) => {
    const tr = document.createElement('tr');
    const isUp = stroke.direction === 'up';
    const center = centerForStroke(stroke, centers);
    tr.innerHTML = `
      <td><span class="trade-badge ${isUp ? 'buy' : 'sell'}">${isUp ? '上行' : '下行'}</span></td>
      <td>${stroke.startDate}</td>
      <td>${stroke.endDate}</td>
      <td>${formatNumber(stroke.startPrice)}</td>
      <td>${formatNumber(stroke.endPrice)}</td>
      <td class="${stroke.changePct >= 0 ? 'positive' : 'negative'}">${formatNumber(stroke.changePct)}%</td>
      <td>${center ? `中枢 ${center.id} ${center.phaseLabel || '形成中'}` : '--'}</td>
    `;
    tableBody.appendChild(tr);
  });
}

function renderSummary(data) {
  const { rows, fractals, strokes, segments, centers, signals, previewSignals = [], previewStroke, tradeResult, meta } = data;
  const name = meta.name;
  const label = periodLabel(meta.period);
  const latest = rows[rows.length - 1];
  const latestStroke = strokes[strokes.length - 1];
  const latestSegment = segments[segments.length - 1];
  const latestCenter = centers[centers.length - 1];
  const latestSignal = signals[signals.length - 1];
  const firstSignalCount = signals.filter((signal) => signal.signalName === '一买' || signal.signalName === '一卖').length;
  const divergenceCount = signals.filter((signal) => signal.signalName.includes('背驰')).length;
  const accent = tradeResult.summary.holding ? '#059669' : latestSignal && latestSignal.type === 'sell' ? '#dc2626' : '#2563eb';
  const previewStrokeText = previewStroke
    ? `；临时${previewStroke.direction === 'up' ? '上行' : '下行'}到 ${previewStroke.endDate}，${formatNumber(previewStroke.changePct)}%`
    : '';

  setText('page-title', `${name}${label}缠论`);
  setText('badge-symbol', `Tencent 数据源 / ${name} / ${label}K`);
  setText('intraday-symbol-chip', name);
  setText('chan-signal', tradeResult.summary.holding ? '持仓中' : '空仓等待');
  setText(
    'chan-zone',
    latestSignal ? `最近信号：${latestSignal.executeDate} ${latestSignal.signalName}` : '等待二买或二卖'
  );
  setText('latest-close', formatNumber(latest.close));
  setText('latest-date', latest.date);
  setText('range-label', `${rows[0].date} 到 ${latest.date}`);
  setText('period-value', label);
  setText('period-meta', `${rows.length} 根分钟 K`);
  setText('latest-stroke', latestStroke ? (latestStroke.direction === 'up' ? '上行笔' : '下行笔') : '--');
  setText(
    'latest-stroke-meta',
    latestStroke
      ? `${latestStroke.startDate} 到 ${latestStroke.endDate}，${formatNumber(latestStroke.changePct)}%；线段 ${latestSegment ? latestSegment.id : '--'}${previewStrokeText}`
      : '暂无有效笔'
  );
  setText('latest-center', latestCenter ? formatCenterRange(latestCenter) : '--');
  setText(
    'latest-center-meta',
    latestCenter ? `${latestCenter.startDate} 到 ${latestCenter.endDate}，${latestCenter.phaseLabel || '形成中'}` : '暂无有效中枢'
  );
  setText('structure-count', `${strokes.length} 笔 / ${segments.length} 线段 / ${centers.length} 中枢`);
  setText(
    'structure-meta',
    `分型 ${fractals.length} 个，一买/一卖 ${firstSignalCount} 个，背驰 ${divergenceCount} 个，预判 ${previewSignals.length} 个，包含处理后 ${data.bars.length} 根 K`
  );
  setText('latest-trade-signal', latestSignal ? latestSignal.signalName : '--');
  setText(
    'latest-trade-meta',
    latestSignal ? `${latestSignal.executeDate} ${latestSignal.description}` : '还没有可执行信号'
  );

  document.documentElement.style.setProperty('--score-accent', accent);
  document.documentElement.style.setProperty('--score-progress', tradeResult.summary.holding ? '72%' : '38%');
  document.getElementById('chan-zone').style.color = accent;
  document.title = `${name}${label}缠论`;
}

function render(data) {
  const errorBox = document.getElementById('error');
  if (!data.rows.length) {
    errorBox.hidden = false;
    errorBox.textContent = '当前标的 / 周期没有可用分钟 K 数据。';
    return;
  }

  errorBox.hidden = true;
  setText('chart-heading', `${data.meta.name}${periodLabel(data.meta.period)}K缠论结构`);
  setText('chart-subtitle', '一买/一卖要求中枢离开后的背驰；二买/二卖看回踩/反抽不破；背驰用同向笔价格创新与 MACD 单位力度转弱判断。');
  setText('legend-price', `${data.meta.name}分钟K`);
  const chartDom = document.getElementById('chart');
  if (chartDom) {
    chartDom.setAttribute('aria-label', `${data.meta.name}分钟 K 缠论结构图表`);
  }
  captureRecentLiveSignals(data, { source: 'view' });
  updateLiveSignalRecordsForData(data, { notify: false });
  renderSummary(data);
  renderLiveSignalLedger(data);
  renderBacktestSummary(data.tradeResult.summary);
  renderTradeTable(data.tradeResult.records);
  renderStrokeTable(data.strokes, data.centers);
  renderChart(data);
}

function sendSignalNotification(data, signal, key) {
  if (!notifyEnabled) {
    return;
  }

  const { symbol, name, period } = data.meta;
  const actionLabel = signal.type === 'buy' ? '买点' : '卖点';
  const message = [
    `### ${name} ${periodLabel(period)} ${signal.signalName}`,
    `- 标的：${name} (${symbol})`,
    `- 周期：${periodLabel(period)}`,
    `- 类型：${actionLabel}`,
    `- 成交时间：${signal.executeDate}`,
    `- 成交价格：${formatNumber(signal.executePrice)}`,
    signal.structureDate ? `- 结构时间：${signal.structureDate}` : null,
    signal.description ? `- 说明：${signal.description}` : null
  ]
    .filter(Boolean)
    .join('\n');

  NotificationService.addNotification(message, signal.type, key);
}

function notifyNewSignals(data) {
  const { symbol, period } = data.meta;
  let count = 0;

  getTradableSignals(data).forEach((signal) => {
    const key = signalKey(symbol, period, signal);
    if (seenSignalKeys.has(key)) {
      return;
    }

    seenSignalKeys.add(key);
    upsertLiveSignalRecord(data, signal, { source: 'monitor' });
    count += 1;
    sendSignalNotification(data, signal, key);
  });

  return count;
}

async function preloadMonitoredData({ forceRefresh = false, notify = false } = {}) {
  const combinations = Object.keys(INTRADAY_INDEXES).flatMap((symbol) =>
    MONITOR_PERIODS.map((period) => [symbol, period])
  );
  const results = await Promise.allSettled(
    combinations.map(([symbol, period]) => loadPeriod(symbol, period, { forceRefresh }))
  );
  let updatedCount = 0;
  let failedCount = 0;
  let newSignalCount = 0;
  let remedySignalCount = 0;
  let pushFailedCount = 0;

  results.forEach((result, index) => {
    const [symbol, period] = combinations[index];
    const key = cacheKey(symbol, period);
    if (result.status !== 'fulfilled') {
      failedCount += 1;
      return;
    }

    updatedCount += 1;
    if (!baselineKeys.has(key)) {
      markBaselineSignals(result.value);
      updateLiveSignalRecordsForData(result.value, { notify: false });
      return;
    }

    if (notify) {
      newSignalCount += notifyNewSignals(result.value);
    }
    remedySignalCount += updateLiveSignalRecordsForData(result.value, { notify });
  });

  if (notify && notifyEnabled && newSignalCount + remedySignalCount > 0) {
    const pushResult = await NotificationService.sendAllNotifications();
    pushFailedCount = pushResult.failedCount || 0;
  }

  saveSeenSignalKeys();
  return { updatedCount, failedCount, newSignalCount, remedySignalCount, pushFailedCount };
}

async function refreshMonitoredData({ notify = true } = {}) {
  if (monitorRefreshInProgress) {
    return;
  }

  monitorRefreshInProgress = true;
  updateNotifyControls('正在刷新 15/30 分钟');
  try {
    const result = await preloadMonitoredData({ forceRefresh: true, notify });
    const currentData = periodPayload[cacheKey(currentSymbol, currentPeriod)];
    if (isMonitoredPeriod(currentPeriod) && currentData && document.getElementById('chart')) {
      render(currentData);
    }
    const pushText = result.pushFailedCount ? `，推送失败 ${result.pushFailedCount} 个` : '';
    updateNotifyControls(
      `最近刷新 ${formatClock()}，新信号 ${result.newSignalCount} 个，补救 ${result.remedySignalCount} 个，失败 ${result.failedCount} 个${pushText}`
    );
  } finally {
    monitorRefreshInProgress = false;
  }
}

function startMonitorTimer() {
  stopMonitorTimer();
  monitorTimerId = window.setInterval(() => {
    refreshMonitoredData({ notify: true });
  }, MONITOR_INTERVAL_MS);
}

function stopMonitorTimer() {
  if (monitorTimerId) {
    window.clearInterval(monitorTimerId);
    monitorTimerId = null;
  }
}

function openSignalFromNotification(symbol, period) {
  if (!document.getElementById('intraday-symbol-switcher')) {
    window.dispatchEvent(
      new CustomEvent('app:navigate-tab', {
        detail: {
          tabId: 'sh-chan-intraday',
          eventName: 'intradayChan:openSignal',
          payload: { symbol, period }
        }
      })
    );
    return;
  }

  showSymbolPeriod(symbol, period);
}

async function loadPeriod(symbol, period, { forceRefresh = false } = {}) {
  const key = cacheKey(symbol, period);
  if (!forceRefresh && periodPayload[key]) {
    return periodPayload[key];
  }

  const config = getPeriodConfig(period);
  const rows = await fetchIndexMinuteHistory(symbol, period, config.limit, { forceRefresh });
  const data = {
    ...calculateAnalysis(rows),
    meta: { symbol, name: symbolName(symbol), period }
  };
  periodPayload[key] = data;
  return data;
}

async function showSymbolPeriod(symbol, period) {
  if (isSwitching) {
    return;
  }

  isSwitching = true;
  currentSymbol = symbol;
  currentPeriod = period;
  updateActiveSymbol(symbol);
  updateActivePeriod(period);
  setText('chan-zone', `正在加载 ${symbolName(symbol)} ${periodLabel(period)}K...`);

  try {
    const data = await loadPeriod(symbol, period);
    render(data);
  } catch (error) {
    const errorBox = document.getElementById('error');
    errorBox.hidden = false;
    errorBox.textContent = `加载失败：${error.message}`;
  } finally {
    isSwitching = false;
  }
}

async function showPeriod(period) {
  await showSymbolPeriod(currentSymbol, period);
}

async function showSymbol(symbol) {
  await showSymbolPeriod(symbol, currentPeriod);
}

function bindSignalNavigation() {
  if (signalNavigationBound) {
    return;
  }

  window.addEventListener('intradayChan:openSignal', (event) => {
    const detail = event.detail || {};
    if (!detail.symbol || !detail.period) {
      return;
    }
    showSymbolPeriod(detail.symbol, detail.period);
  });
  signalNavigationBound = true;
}

async function init() {
  stopMonitorTimer();
  chartInstance = null;
  periodPayload = {};
  baselineKeys = new Set();
  currentSymbol = DEFAULT_SYMBOL;
  currentPeriod = DEFAULT_PERIOD;
  monitorRefreshInProgress = false;
  loadSeenSignalKeys();
  loadLiveSignalRecords();
  bindSignalNavigation();
  renderSymbolSwitcher();
  renderPeriodSwitcher();
  setNotifyText('加载中', '正在预加载 15/30 分钟');
  setText('chan-zone', '正在预加载 15/30 分钟数据...');
  const preloadResult = await preloadMonitoredData({ forceRefresh: false, notify: false });
  initNotificationControls();
  updateNotifyControls(
    `已加载 ${preloadResult.updatedCount} 组，失败 ${preloadResult.failedCount} 组`
  );
  startMonitorTimer();
  await showPeriod(currentPeriod);
}

export { init };
