const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3008;

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
  sh515020: '银行',
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

async function handleSinaKline(req, res) {
  const params = new URLSearchParams({
    symbol: req.query.symbol || 'sh000001',
    scale: req.query.scale || '5',
    datalen: req.query.datalen || '300',
  });
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?${params.toString()}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://finance.sina.cn/',
      },
    });
    const text = await response.text();

    res.status(response.status);
    res.type('application/json');
    res.send(text);
  } catch (error) {
    console.error('新浪分钟K线代理失败:', error);
    res.status(502).json({ error: 'Failed to fetch minute data' });
  }
}

async function handleQuote(req, res) {
  const symbol = req.query.symbol || 'sh000001';
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
      throw new Error(`腾讯报价接口返回 ${response.status}`);
    }

    const text = await response.text();
    res.json(parseTencentQuote(text, symbol));
  } catch (error) {
    console.error('腾讯实时报价代理失败:', error);
    res.status(502).json({ error: 'Failed to fetch quote data' });
  }
}

app.get('/api/cn/api/json_v2.php/CN_MarketDataService.getKLineData', handleSinaKline);
app.get('/api/sina-kline', handleSinaKline);
app.get('/api/quote', handleQuote);

// 静态文件服务
app.use(express.static(path.join(__dirname)));

// 主页面路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '10-day-line.html'));
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`可以访问 http://localhost:${PORT}/10-day-line.html 查看页面`);
});
