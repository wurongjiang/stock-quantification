const INDEX_NAMES = {
  sh000001: '上证指数',
  sh000300: '沪深300',
  sh000905: '中证500',
  sh000688: '科创50',
  sh510880: '红利ETF',
  sh513120: '创新药ETF',
  sh513160: '港股科技',
  sh518880: '黄金ETF',
  sz159941: '纳指ETF',
  sh513310: '中韩',
  sh513090: '证券',
  sh515020: '银行',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTencentTimestamp(value) {
  if (!/^\d{14}$/.test(value || '')) {
    return { date: null, time: null };
  }

  return {
    date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
    time: `${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}`,
  };
}

function parseTencentQuote(text, symbol) {
  const match = text.match(/v_[^=]+="([^"]*)"/);
  if (!match) {
    throw new Error('Tencent quote response format changed');
  }

  const fields = match[1].split('~');
  const price = parseNumber(fields[3]);

  if (price === null) {
    throw new Error('Tencent quote response did not include a valid price');
  }

  const timestamp = fields.find((field) => /^\d{14}$/.test(field));
  const { date, time } = formatTencentTimestamp(timestamp);

  return {
    symbol,
    name: INDEX_NAMES[symbol] || fields[1] || symbol,
    price,
    date,
    time,
  };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  const symbol = event.queryStringParameters?.symbol || 'sh000001';
  const url = `https://qt.gtimg.cn/q=${encodeURIComponent(symbol)}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/plain,*/*',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://finance.qq.com/',
      },
    });

    if (!response.ok) {
      throw new Error(`Tencent quote API responded with ${response.status}`);
    }

    const text = await response.text();
    const payload = parseTencentQuote(text, symbol);

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        error: 'Failed to fetch Tencent quote',
        message: error.message,
      }),
    };
  }
}
