'use strict'

const https = require('https')
const chalk = require('chalk')

/**
 * HTTPS GET，返回字符串
 */
function httpGet (url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.qq.com/', ...headers } }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => resolve(raw))
    }).on('error', reject)
  })
}

/**
 * 通用指数/股票日 K 数据获取（腾讯财经公开接口）
 *
 * @param {string} symbol   - 标的代码，如 'sh000001'、'sh000300'
 * @param {string} name     - 显示名称，如 '沪深300'
 * @param {string} startDate - 起始日期，格式 'YYYY-MM-DD'
 * @param {string} endDate   - 终止日期，格式 'YYYY-MM-DD'
 * @param {number} limit    - 最多返回条数，默认 2000
 * @returns {Promise<Array>} 每条：{ date, open, close, high, low, volume }，按日期升序
 */
async function fetchIndexData (symbol, name, startDate, endDate, limit = 2000) {
  const url =
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${limit},qfq`

  console.log(`  正在获取 ${url}`)

  let raw
  try {
    raw = await httpGet(url)
  } catch (err) {
    throw new Error(`数据获取失败 [${symbol}]: ${err.message}`)
  }

  let json
  try {
    json = JSON.parse(raw.replace(/^kline_dayqfq=/, ''))
  } catch (e) {
    throw new Error(`JSON 解析失败 [${symbol}]: ` + raw.slice(0, 200))
  }

  const stockData = json?.data?.[symbol]
  const klines = stockData?.qfqday || stockData?.day

  if (!klines || klines.length === 0) {
    throw new Error(`未获取到 K 线 [${symbol}]，接口返回：` + JSON.stringify(json).slice(0, 200))
  }

  const data = klines.map((arr) => ({
    date: arr[0],
    open: parseFloat(arr[1]),
    close: parseFloat(arr[2]),
    high: parseFloat(arr[3]),
    low: parseFloat(arr[4]),
    volume: parseFloat(arr[5]),
  }))

  data.sort((a, b) => (a.date > b.date ? 1 : -1))
  console.log(`  ✓ ${name}：${data.length} 条  (${data[0].date} → ${data[data.length - 1].date})`)
  return data
}

/**
 * 获取上证指数近3年日 K（向前兼容）
 */
async function fetchShangHaiIndex () {
  const end = new Date()
  const start = new Date()
  start.setFullYear(start.getFullYear() - 3)

  const toDate = (d) => d.toISOString().split('T')[0]

  console.log(`\n正在获取数据（腾讯财经公开接口）...`)
  console.log(`标的: 上证指数 (sh000001)`)
  console.log(`区间: ${toDate(start)} → ${toDate(end)}\n`)

  const data = await fetchIndexData('sh000001', '上证指数', toDate(start), toDate(end))
  console.log(`成功获取 ${data.length} 条交易日数据（${data[0].date} → ${data[data.length - 1].date}）`)
  return data
}

/**
 * 获取指数分时数据（新浪财经接口，获取最近五天）
 * 
 * @param {string} symbol - 标的代码，如 'sh000001'
 * @returns {Promise<Object>} 分时数据
 */
async function fetchMinuteData (symbol) {
  // 新浪财经接口，获取最近五天的分时数据
  // 转换代码格式：sh000001 -> sh000001
  const sinaSymbol = symbol
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${sinaSymbol}&scale=5&datalen=240`

  console.log(`  正在获取分时数据 ${url}`)

  let raw
  try {
    raw = await httpGet(url)
  } catch (err) {
    throw new Error(`分时数据获取失败 [${symbol}]: ${err.message}`)
  }

  let json
  try {
    json = JSON.parse(raw)
  } catch (e) {
    throw new Error(`JSON 解析失败 [${symbol}]: ` + raw.slice(0, 200))
  }

  if (!json || json.length === 0) {
    throw new Error(`未获取到分时数据 [${symbol}]，接口返回：` + JSON.stringify(json).slice(0, 200))
  }

  // 处理分时数据
  const processedData = json.map(item => {
    return {
      time: item.day, // 新浪接口返回的时间格式为 "2024-03-18 10:00"
      price: parseFloat(item.close),
      volume: parseFloat(item.volume),
      amount: parseFloat(item.amount) || 0
    }
  })

  // 按时间正序排列（新浪接口返回的已经是正序）
  // processedData.sort((a, b) => new Date(a.time) - new Date(b.time))

  console.log(`  ✓ ${symbol} 分时数据：${processedData.length} 条`)
  return processedData
}

/**
 * 获取A股市场实时涨跌数数据（腾讯财经公开接口）
 * 
 * @returns {Promise<Object>} 涨跌数数据
 */
async function fetchMarketData () {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/hsmarket/get?_var=market_1639387200&param=sz,a`

  console.log(`  正在获取A股市场涨跌数数据 ${url}`)

  let raw
  try {
    raw = await httpGet(url)
  } catch (err) {
    throw new Error(`市场数据获取失败: ${err.message}`)
  }

  let json
  try {
    json = JSON.parse(raw.replace(/^market_\d+=/, ''))
  } catch (e) {
    throw new Error(`JSON 解析失败: ` + raw.slice(0, 200))
  }

  const marketData = json?.data
  if (!marketData) {
    throw new Error(`未获取到市场数据，接口返回：` + JSON.stringify(json).slice(0, 200))
  }

  // 提取涨跌数数据
  const data = {
    up: marketData?.hs?.up || 0,
    down: marketData?.hs?.down || 0,
    flat: marketData?.hs?.flat || 0,
    total: marketData?.hs?.total || 0
  }

  console.log(`  ✓ A股市场涨跌数：上涨${data.up}家，下跌${data.down}家，平盘${data.flat}家，总计${data.total}家`)
  return data
}

/**
 * 获取指数最新交易量并与前一日比较（腾讯财经公开接口）
 * 
 * @param {string} symbol - 标的代码，如 'sh000001'
 * @returns {Promise<Object>} 交易量数据
 */
async function fetchVolumeData (symbol) {
  const endDate = new Date().toISOString().split('T')[0]
  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  try {
    const data = await fetchIndexData(symbol, '指数', startDate, endDate, 10)

    if (data.length >= 2) {
      const latest = data[data.length - 1]
      const previous = data[data.length - 2]

      const volumeChange = latest.volume - previous.volume
      const volumeChangePercent = previous.volume > 0 ? (volumeChange / previous.volume * 100) : 0

      return {
        latestVolume: latest.volume,
        previousVolume: previous.volume,
        volumeChange,
        volumeChangePercent
      }
    }

    return null
  } catch (err) {
    console.error(chalk.red(`  ✗ 交易量数据获取失败 [${symbol}]: ${err.message}`))
    return null
  }
}

/**
 * 获取指数30分钟K线数据（腾讯财经公开接口）
 *
 * @param {string} symbol   - 标的代码，如 'sh000001'、'sh000300'
 * @param {string} name     - 显示名称，如 '沪深300'
 * @param {number} limit    - 最多返回条数，默认 2000（约5个月）
 * @returns {Promise<Array>} 每条：{ date, open, close, high, low, volume }，按日期升序
 */
async function fetch30MinKlineData (symbol, name, limit = 1200) {
  const url =
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get` +
    `?_var=kline_30m&param=${symbol},30m,,${limit},qfq`

  console.log(`  正在获取 ${url}`)

  let raw
  try {
    raw = await httpGet(url)
  } catch (err) {
    throw new Error(`30分钟K线数据获取失败 [${symbol}]: ${err.message}`)
  }

  let json
  try {
    json = JSON.parse(raw.replace(/^kline_30m=/, ''))
  } catch (e) {
    throw new Error(`JSON 解析失败 [${symbol}]: ` + raw.slice(0, 200))
  }

  const stockData = json?.data?.[symbol]
  const klines = stockData?.qfq30m || stockData?.m30

  if (!klines || klines.length === 0) {
    throw new Error(`未获取到30分钟K线 [${symbol}]，接口返回：` + JSON.stringify(json).slice(0, 200))
  }

  const data = klines.map((arr) => ({
    date: arr[0],
    open: parseFloat(arr[1]),
    close: parseFloat(arr[2]),
    high: parseFloat(arr[3]),
    low: parseFloat(arr[4]),
    volume: parseFloat(arr[5]),
  }))

  data.sort((a, b) => (a.date > b.date ? 1 : -1))
  console.log(`  ✓ ${name} 30分钟K线：${data.length} 条  (${data[0].date} → ${data[data.length - 1].date})`)
  return data
}

/**
 * 获取指数30分钟K线数据（Mairui API）
 *
 * @param {string} symbol   - 标的代码，如 'sh000001'、'sh000300'
 * @param {string} name     - 显示名称，如 '沪深300'
 * @returns {Promise<Array>} 每条：{ date, open, close, high, low, volume }，按日期升序
 */
async function fetchMairui30MinData (symbol, name) {
  // 转换标的代码格式，从 sh000001 转换为 000001.SZ
  let mairuiSymbol
  if (symbol.startsWith('sh')) {
    mairuiSymbol = `${symbol.slice(2)}.SH`
  } else if (symbol.startsWith('sz')) {
    mairuiSymbol = `${symbol.slice(2)}.SZ`
  } else {
    throw new Error(`无效的标的代码: ${symbol}`)
  }

  // 计算日期范围，获取最近5个月的数据
  const endDate = new Date()
  const startDate = new Date()
  startDate.setMonth(startDate.getMonth() - 5)

  const formatDate = (date) => {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}${month}${day}`
  }

  const st = formatDate(startDate)
  const et = formatDate(endDate)
  const license = '89EC4107-B853-4D47-A451-A365CBE1CEA6' || '586C88AE-3866-46C6-84E8-8DB9F059B416'

  const url = `https://api.mairuiapi.com/hsindex/history/${mairuiSymbol}/30/${license}?st=${st}&et=${et}`

  console.log(`  正在获取 ${url}`)

  let raw
  try {
    raw = await httpGet(url)
  } catch (err) {
    throw new Error(`30分钟K线数据获取失败 [${symbol}]: ${err.message}`)
  }

  let json
  try {
    json = JSON.parse(raw)
  } catch (e) {
    throw new Error(`JSON 解析失败 [${symbol}]: ` + raw.slice(0, 200))
  }

  // 检查返回的数据格式
  let klines
  if (Array.isArray(json)) {
    // API直接返回了数组
    klines = json
  } else {
    // API返回了包含data字段的对象
    klines = json?.data
  }

  if (!klines || klines.length === 0) {
    throw new Error(`未获取到30分钟K线 [${symbol}]，接口返回：` + JSON.stringify(json).slice(0, 200))
  }

  // 处理数据
  const data = klines.map((item) => ({
    date: item.t || item.datetime,
    open: parseFloat(item.o || item.open),
    close: parseFloat(item.c || item.close),
    high: parseFloat(item.h || item.high),
    low: parseFloat(item.l || item.low),
    volume: parseFloat(item.v || item.volume)
  }))

  data.sort((a, b) => (a.date > b.date ? 1 : -1))

  // 调试：打印数据范围和价格范围
  if (data.length > 0) {
    const prices = data.map(d => d.close)
    const minPrice = Math.min(...prices)
    const maxPrice = Math.max(...prices)
    console.log(`  调试：${name} 30分钟K线价格范围：${minPrice.toFixed(2)} - ${maxPrice.toFixed(2)}`)
    console.log(`  调试：${name} 30分钟K线前5条数据：`, data.slice(0, 5))
  }

  console.log(`  ✓ ${name} 30分钟K线：${data.length} 条  (${data[0].date} → ${data[data.length - 1].date})`)
  return data
}

module.exports = { fetchShangHaiIndex, fetchIndexData, fetchMinuteData, fetch30MinKlineData, fetchMairui30MinData, fetchMarketData, fetchVolumeData }
