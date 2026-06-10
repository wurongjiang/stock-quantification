const INDEXES = {
  sh000001: '上证指数',
  sh000300: '沪深300',
  sh000905: '中证500',
  sh000688: '科创50',
  sh513120: '创新药ETF',
  sh513160: '港股科技',
  sh518880: '黄金ETF',
  sz159941: '纳指ETF',
  sh515020: '银行',
  sh510880: '红利ETF',
 };

const HISTORY_START_DATE = '2022-01-01';
const HISTORY_LIMIT = 2000;
const MINUTE_HISTORY_LIMIT = 1600;
const MINUTE_HISTORY_MAX_LIMIT = 1600;
const PERIOD_KEYS = {
  day: ['day', 'qfqday'],
  week: ['week', 'qfqweek']
};
const MINUTE_PERIODS = new Set(['m5', 'm15', 'm30', 'm60']);
const historyCache = new Map();
const minuteHistoryCache = new Map();
const realtimeCache = new Map();

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchIndexHistory(symbol, period = 'day') {
  if (!INDEXES[symbol]) {
    throw new Error(`Unsupported index symbol: ${symbol}`);
  }

  if (!PERIOD_KEYS[period]) {
    throw new Error(`Unsupported history period: ${period}`);
  }

  const cacheKey = `${symbol}:${period}`;
  if (historyCache.has(cacheKey)) {
    return historyCache.get(cacheKey);
  }

  const historyPromise = requestIndexHistory(symbol, period);
  historyCache.set(cacheKey, historyPromise);
  return historyPromise;
}

async function fetchIndexMinuteHistory(symbol, period = 'm30', limit = MINUTE_HISTORY_LIMIT, options = {}) {
  if (!INDEXES[symbol]) {
    throw new Error(`Unsupported index symbol: ${symbol}`);
  }

  if (!MINUTE_PERIODS.has(period)) {
    throw new Error(`Unsupported minute period: ${period}`);
  }

  const forceRefresh = options && options.forceRefresh === true;
  const cacheKey = `${symbol}:${period}:${limit}`;
  if (!forceRefresh && minuteHistoryCache.has(cacheKey)) {
    return minuteHistoryCache.get(cacheKey);
  }

  const historyPromise = requestIndexMinuteHistory(symbol, period, limit);
  minuteHistoryCache.set(cacheKey, historyPromise);
  try {
    return await historyPromise;
  } catch (error) {
    if (minuteHistoryCache.get(cacheKey) === historyPromise) {
      minuteHistoryCache.delete(cacheKey);
    }
    throw error;
  }
}

async function fetchRealtimeQuote(symbol) {
  if (!INDEXES[symbol]) {
    throw new Error(`Unsupported index symbol: ${symbol}`);
  }

  const cached = realtimeCache.get(symbol);
  if (cached && Date.now() - cached.cachedAt < 15000) {
    return cached.value;
  }

  const quotePromise = requestRealtimeQuote(symbol);
  realtimeCache.set(symbol, {
    cachedAt: Date.now(),
    value: quotePromise
  });
  return quotePromise;
}

function formatMinuteDate(value) {
  const text = String(value || '');
  if (!/^\d{12}$/.test(text)) {
    return text;
  }
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}`;
}

async function requestIndexHistory(symbol, period) {
  const apiUrl = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${period},,,${HISTORY_LIMIT},qfq`;
  const response = await fetch(apiUrl, {
    headers: {
      Accept: 'application/json,text/plain,*/*'
    }
  });

  if (!response.ok) {
    throw new Error(`Tencent API responded with ${response.status}`);
  }

  const payload = await response.json();
  const root = payload && payload.data && payload.data[symbol];
  const [rawKey, adjustedKey] = PERIOD_KEYS[period];
  const rows =
    root && Array.isArray(root[rawKey])
      ? root[rawKey]
      : root && Array.isArray(root[adjustedKey])
        ? root[adjustedKey]
        : null;

  if (!rows || rows.length === 0) {
    throw new Error(`Tencent API did not return ${period} data for ${symbol}.`);
  }

  return rows
    .filter((row) => row[0] >= HISTORY_START_DATE)
    .map((row) => ({
      date: row[0],
      open: parseNumber(row[1]),
      close: parseNumber(row[2]),
      high: parseNumber(row[3]),
      low: parseNumber(row[4]),
      volume: parseNumber(row[5])
    }));
}

function periodToScale(period) {
  const scaleMap = {
    'm5': 5,
    'm15': 15,
    'm30': 30,
    'm60': 60
  };
  return scaleMap[period] || 30;
}

async function requestIndexMinuteHistory(symbol, period, limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || MINUTE_HISTORY_LIMIT, MINUTE_HISTORY_MAX_LIMIT));
  const scale = periodToScale(period);
  
  // 先尝试通过本地代理获取新浪分钟数据
  const proxyUrl = `/api/sina-kline?symbol=${encodeURIComponent(symbol)}&scale=${scale}&datalen=${safeLimit}`;
  
  try {
    const response = await fetch(proxyUrl, {
      headers: {
        Accept: 'application/json,text/plain,*/*'
      }
    });

    if (response.ok) {
      const rows = await response.json();
      if (rows && Array.isArray(rows) && rows.length > 0) {
        return rows.map((row) => ({
          date: row.day || row.date || '',
          open: parseNumber(row.open),
          close: parseNumber(row.close),
          high: parseNumber(row.high),
          low: parseNumber(row.low),
          volume: parseNumber(row.volume)
        }));
      }
    }
  } catch (proxyError) {
    console.warn('代理请求失败，尝试直接获取数据:', proxyError.message);
  }
  
  // 备用方案：直接使用腾讯API获取分钟数据
  const tencentUrl = `https://qt.gtimg.cn/q=${symbol}`;
  try {
    const response = await fetch(tencentUrl, {
      headers: {
        Accept: 'application/json,text/plain,*/*'
      }
    });
    
    if (response.ok) {
      const text = await response.text();
      // 腾讯实时行情格式：v_sz000001="1~平安银行~000001~..."
      const match = text.match(/v_[\w]+="([^"]+)"/);
      if (match) {
        const data = match[1].split('~');
        const price = parseNumber(data[3]);
        if (price) {
          // 如果能获取到实时数据，生成一个简单的K线数据
          const now = new Date();
          const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          return [{
            date: timeStr,
            open: price,
            close: price,
            high: price,
            low: price,
            volume: 0
          }];
        }
      }
    }
  } catch (tencentError) {
    console.warn('腾讯API请求失败:', tencentError.message);
  }
  
  // 最终备用：使用日线数据作为降级方案
  console.warn('分钟数据获取失败，使用日线数据降级');
  const dailyData = await requestIndexHistory(symbol, 'day');
  return dailyData;
}

async function requestRealtimeQuote(symbol) {
  const apiUrl = `/api/quote?symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(apiUrl, {
    headers: {
      Accept: 'application/json,text/plain,*/*'
    }
  });

  if (!response.ok) {
    throw new Error(`Realtime quote API responded with ${response.status}`);
  }

  const payload = await response.json();
  const price = parseNumber(payload.price);

  if (price === null) {
    throw new Error(`Realtime quote API did not return a price for ${symbol}.`);
  }

  return {
    symbol,
    name: payload.name || INDEXES[symbol],
    price,
    date: payload.date || null,
    time: payload.time || null
  }
}

// 清除分钟历史缓存（用于强制刷新数据）
function clearMinuteHistoryCache () {
  minuteHistoryCache.clear()
  console.log('分钟历史缓存已清除')
}

export {
  INDEXES,
  fetchIndexHistory,
  fetchIndexMinuteHistory,
  fetchRealtimeQuote,
  clearMinuteHistoryCache
}
