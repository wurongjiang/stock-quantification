'use strict'

/**
 * 多指数恐贪对比
 *
 * 统计4个指数：上证指数、沪深300、中证500、红利低波100（中证红利低波动100）
 * 显示区间：2024-10-10 至今
 * 为保证恐贪值热身期（约120个交易日），数据从 2024-01-01 开始抓取
 */

const chalk = require('chalk')
const Table = require('cli-table3')
const fs = require('fs')
const path = require('path')
const { fetchIndexData, fetchMinuteData } = require('./fetchData')
const { calcFearGreed, getLabel, calcMinuteFearGreed } = require('./fearGreed')

// ─── 配置 ────────────────────────────────────────────────────

const INDICES = [
  { symbol: 'sh000001', name: '上证指数', color: '#58a6ff' },
  { symbol: 'sh000300', name: '沪深300', color: '#3fb950', ignore: true, },
  { symbol: 'sh000905', name: '中证500', color: '#f0883e', ignore: true, },
  { symbol: 'sh513870', name: '纳指', color: '#3eacff', ignore: true, },
   { symbol: 'sh510880', name: '红利', color: '#3eacff', ignore: true, },
  { symbol: 'sz159363', name: '人工智能', color: '#3eacff', ignore: true, },
  { symbol: 'sh588200', name: '科创50', color: '#7af0f4', ignore: true, },
  { symbol: 'sh513310', name: '中韩半导体', color: '#7af0f4', ignore: true, },
  { symbol: 'sh518680', name: '金', color: '#7af0f4', ignore: true, },
  { symbol: 'sh513160', name: '港科技30', color: '#7af0f4', ignore: true, },

]

const FETCH_FROM = '2024-01-01'   // 含热身期（约200个交易日 > 120日暖身要求）
const DISPLAY_FROM = '2024-12-31'   // 用户关心的展示起始日


// ─── 主流程 ──────────────────────────────────────────────────

async function main () {
  const today = new Date().toISOString().split('T')[0]

  // console.log(chalk.bold.cyan('\n' + '='.repeat(56)))
  // console.log(chalk.bold.cyan('  多指数恐贪指数对比'))
  // console.log(chalk.bold.cyan(`  统计区间：${DISPLAY_FROM} → ${today}`))
  // console.log(chalk.bold.cyan('='.repeat(56) + '\n'))

  const results = []
  const minuteDataMap = new Map()

  // 获取所有指数的分时数据
  for (const idx of INDICES) {
    try {
      if (idx.ignore) continue
      const minuteData = await fetchMinuteData(idx.symbol)
      minuteDataMap.set(idx.symbol, minuteData)
    } catch (err) {
      console.error(chalk.red(`  ✗ ${idx.name}分时数据获取失败：${err.message}`))
    }
  }
  // 处理分时数据，生成5分钟数据点和M20线，以及分时恐贪指数
  const processedMinuteDataMap = new Map()
  for (const [symbol, minuteData] of minuteDataMap.entries()) {
    if (minuteData) {
      // 新浪接口已经返回5分钟级别的数据
      const fiveMinuteData = minuteData

      // 计算5分钟移动平均线 (1个5分钟点)
      const m5Data = []
      for (let i = 0; i < fiveMinuteData.length; i++) {
        m5Data.push(fiveMinuteData[i].price) // 5分钟数据点本身就是M5
      }

      // 计算20分钟移动平均线 (20个5分钟点，即100分钟移动平均线)
      // 注意：Mairui API返回的数据是按时间正序排列的，最新的数据在最后
      const m20Data = []
      for (let i = 0; i < fiveMinuteData.length; i++) {
        if (i < 19) { // 20个5分钟点，需要足够的数据点
          m20Data.push(null)
        } else {
          const sum = fiveMinuteData.slice(i - 19, i + 1).reduce((acc, item) => acc + item.price, 0)
          m20Data.push(sum / 20)
        }
      }

      // 计算分时恐贪指数
      const minuteFG = calcMinuteFearGreed(minuteData)

      // 打印分时恐贪数值
      console.log(`${symbol}  恐贪指数：${minuteFG.latestScore} · ${minuteFG.label}`)

      // 为5分钟数据点计算恐贪指数
      const fiveMinuteFG = minuteFG.scores

      // 判断当前是否站上M5和M20
      // 注意：新浪接口返回的数据是按时间正序排列的，最新的数据在最后
      const latestPrice = fiveMinuteData[fiveMinuteData.length - 1].price
      const latestM5 = m5Data[m5Data.length - 1]
      const latestM20 = m20Data[m20Data.length - 1]
      const isAboveM5 = latestPrice >= latestM5
      const isAboveM20 = latestM20 !== null && latestPrice >= latestM20

      processedMinuteDataMap.set(symbol, {
        fiveMinuteData,
        m5Data,
        m20Data,
        fiveMinuteFG,
        latestFG: minuteFG.latestScore,
        latestFGLabel: minuteFG.label,
        isAboveM5,
        isAboveM20,
        latestPrice
      })
    }
  }

  for (const idx of INDICES) {
    try {
      const data = await fetchIndexData(idx.symbol, idx.name, FETCH_FROM, today)
      const fg = calcFearGreed(data, idx.symbol)

      // 找到 DISPLAY_FROM 对应的下标，过滤展示范围
      const dispStart = data.findIndex((d) => d.date >= DISPLAY_FROM)
      const dispIdx = dispStart >= 0 ? dispStart : 0

      // 计算买入卖出点
      const buySellPoints = calculateBuySellPoints(fg.scores, data.map((d) => d.close), idx.symbol)

      results.push({
        ...idx,
        fg,
        buyPoints: buySellPoints.buyPoints.map(p => p - dispIdx).filter(p => p >= 0),
        sellPoints: buySellPoints.sellPoints.map(p => p - dispIdx).filter(p => p >= 0),
        displayDates: data.slice(dispIdx).map((d) => d.date),
        displayScores: fg.scores.slice(dispIdx),
        displayCloses: data.slice(dispIdx).map((d) => d.close),
      })
    } catch (err) {
      console.error(chalk.red(`  ✗ ${idx.name} 获取失败：${err.message}`))
      results.push({ ...idx, error: err.message })
    }
  }

  console.log('')
  const marketInfo = printMarketStatus(results)
  printSummaryTable(results)
  printSubIndicators(results)

  const htmlPath = generateHTML(results, today, processedMinuteDataMap, marketInfo)
  console.log(chalk.bold.green(`\n  HTML 报告已生成：${htmlPath}`))
  console.log(chalk.gray(`  在浏览器中打开查看图表。\n`))
}

// ─── 牛市/熊市判断 ──────────────────────────────────────────

/**
 * 判断当前市场状态（牛市/熊市）
 * @param {number[]} prices 收盘价数组
 * @param {number[]} scores 恐贪指数数组
 * @returns {string} marketStatus: 'bull' (牛市), 'bear' (熊市), 'neutral' (震荡)
 */
function determineMarketStatus (prices, scores) {
  if (prices.length < 60 || scores.length < 60) {
    return { status: 'neutral', details: null }
  }

  // 基于200日均线判断
  const ma200 = calculateMA(prices, 200)
  const latestPrice = prices[prices.length - 1]
  const latestMA200 = ma200[ma200.length - 1]
  const isAboveMA200 = latestPrice >= latestMA200

  // 基于价格趋势（最近60天）
  const recentPrices = prices.slice(-60)
  const trendChange = (recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices[0]

  // 基于恐贪指数趋势（最近30天）
  const recentScores = scores.slice(-30)
  const avgRecentScore = recentScores.reduce((a, b) => a + b, 0) / recentScores.length

  // 基于RSI判断
  const rsi = calculateRSI(prices)
  const latestRSI = rsi[rsi.length - 1] || 50

  let bullScore = 0
  let bearScore = 0

  if (isAboveMA200) bullScore += 1
  else bearScore += 1

  if (trendChange > 0.1) bullScore += 1
  else if (trendChange < -0.1) bearScore += 1

  if (avgRecentScore > 60) bullScore += 1
  else if (avgRecentScore < 40) bearScore += 1

  if (latestRSI > 55) bullScore += 1
  else if (latestRSI < 45) bearScore += 1

  let status = 'neutral'
  if (bullScore >= 3) status = 'bull'
  else if (bearScore >= 3) status = 'bear'

  // 返回详细信息
  return {
    status,
    bullScore,
    bearScore,
    details: {
      ma200: {
        value: latestMA200 ? latestMA200.toFixed(2) : 'N/A',
        price: latestPrice.toFixed(2),
        isAbove: isAboveMA200,
        score: isAboveMA200 ? 1 : 0
      },
      trendChange: {
        value: (trendChange * 100).toFixed(1) + '%',
        score: trendChange > 0.1 ? 1 : (trendChange < -0.1 ? -1 : 0)
      },
      avgFearGreed: {
        value: avgRecentScore.toFixed(1),
        score: avgRecentScore > 60 ? 1 : (avgRecentScore < 40 ? -1 : 0)
      },
      rsi: {
        value: latestRSI ? latestRSI.toFixed(1) : 'N/A',
        score: latestRSI > 55 ? 1 : (latestRSI < 45 ? -1 : 0)
      }
    }
  }
}

function getAdjustedThresholds (marketStatus) {
  const thresholds = {
    bull: { buyThreshold: 25, sellThreshold: 85, minInterval: 25 },
    bear: { buyThreshold: 35, sellThreshold: 70, minInterval: 15 },
    neutral: { buyThreshold: 30, sellThreshold: 80, minInterval: 20 }
  }
  return thresholds[marketStatus] || thresholds.neutral
}

function getMarketStatusInfo (marketStatus) {
  const statusInfo = {
    bull: {
      label: '牛市',
      description: '当前处于牛市环境，市场情绪积极',
      advice: '建议适当提高风险承受，恐贪指数阈值可适当放宽',
      color: chalk.green
    },
    bear: {
      label: '熊市',
      description: '当前处于熊市环境，市场情绪低迷',
      advice: '建议保持谨慎，恐贪指数阈值应更加敏感',
      color: chalk.red
    },
    neutral: {
      label: '震荡市',
      description: '当前处于震荡行情，方向不明',
      advice: '建议观望为主，等待明确信号',
      color: chalk.yellow
    }
  }
  return statusInfo[marketStatus] || statusInfo.neutral
}

function calculateMA (prices, period) {
  const ma = new Array(prices.length).fill(null)
  for (let i = period - 1; i < prices.length; i++) {
    const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0)
    ma[i] = sum / period
  }
  return ma
}

function printMarketStatus (results) {
  const shResult = results.find(r => r.symbol === 'sh000001')

  if (!shResult || shResult.error || !shResult.displayCloses || !shResult.displayScores) {
    console.log(chalk.yellow('  ℹ 无法获取上证指数数据，跳过市场状态判断'))
    return null
  }

  const marketResult = determineMarketStatus(shResult.displayCloses, shResult.displayScores)
  const marketStatus = marketResult.status
  const statusInfo = getMarketStatusInfo(marketStatus)
  const thresholds = getAdjustedThresholds(marketStatus)
  const details = marketResult.details

  // 获取最新恐贪指数
  const latestScore = shResult.displayScores ? shResult.displayScores[shResult.displayScores.length - 1] : null
  const canBuy = latestScore !== null && latestScore < thresholds.buyThreshold
  const canSell = latestScore !== null && latestScore > thresholds.sellThreshold


  return { marketStatus, thresholds, details: marketResult.details, latestScore, canBuy, canSell, bullScore: marketResult.bullScore, bearScore: marketResult.bearScore }
}

// ─── 仓位计算 ────────────────────────────────────────────

/**
 * 根据恐贪指数计算仓位
 * @param {number} score 恐贪指数得分
 * @param {string} symbol 指数代码
 * @param {string} riskPreference 风险偏好：conservative(保守), moderate(稳健), aggressive(积极)
 * @returns {number} 建议仓位（0-100）
 */
function calculatePosition (score, symbol, riskPreference = 'moderate') {
  // 根据风险偏好和恐贪指数调整仓位
  const positionMap = {
    conservative: {
      '<20': 80,  // 极度恐慌 - 保守型
      '<40': 60,  // 恐慌 - 保守型
      '<60': 40,  // 中性 - 保守型
      '<80': 20,  // 贪婪 - 保守型
      '>=80': 10  // 极度贪婪 - 保守型
    },
    moderate: {
      '<20': 90,  // 极度恐慌 - 稳健型
      '<40': 70,  // 恐慌 - 稳健型
      '<60': 50,  // 中性 - 稳健型
      '<80': 30,  // 贪婪 - 稳健型
      '>=80': 15  // 极度贪婪 - 稳健型
    },
    aggressive: {
      '<20': 100, // 极度恐慌 - 积极型
      '<40': 80,  // 恐慌 - 积极型
      '<60': 60,  // 中性 - 积极型
      '<80': 40,  // 贪婪 - 积极型
      '>=80': 20  // 极度贪婪 - 积极型
    }
  }

  // 获取对应风险偏好的仓位映射
  const positions = positionMap[riskPreference] || positionMap.moderate

  // 根据恐贪指数返回对应仓位
  if (score < 20) {
    return positions['<20']
  } else if (score < 40) {
    return positions['<40']
  } else if (score < 60) {
    return positions['<60']
  } else if (score < 80) {
    return positions['<80']
  } else {
    return positions['>=80']
  }
}

// ─── 买入卖出时机分析 ──────────────────────────────────────

// 改进的买入卖出点计算
/**
 * 根据指数类型计算买卖点（针对不同指数采用差异化参数）
 * @param {number[]} scores 原始恐贪值数组（完整区间）
 * @param {number[]} prices 原始收盘价数组
 * @param {string} symbol 指数代码
 * @returns {{buyPoints: number[], sellPoints: number[]}} 原始索引位置的买卖点数组
 */
/**
 * 根据指数类型计算买卖点（优化卖出逻辑：高位拐头卖出）
 * @param {number[]} scores 原始恐贪值数组（完整区间）
 * @param {number[]} prices 原始收盘价数组
 * @param {string} symbol 指数代码
 * @returns {{buyPoints: number[], sellPoints: number[]}} 原始索引位置的买卖点数组
 */
/**
 * 基于价格走势的买卖点计算（双均线交叉策略）
 * @param {number[]} scores 忽略，仅保留参数占位（原接口要求）
 * @param {number[]} prices 原始收盘价数组
 * @param {string} symbol 指数代码
 * @returns {{buyPoints: number[], sellPoints: number[]}} 原始索引位置的买卖点数组
 */
/**
 * 基于RSI反转的买卖点计算（仅针对上证指数和沪深300）
 * @param {number[]} scores 忽略（占位符）
 * @param {number[]} prices 原始收盘价数组
 * @param {string} symbol 指数代码
 * @returns {{buyPoints: number[], sellPoints: number[]}} 原始索引位置的买卖点数组
 */
/**
 * 基于价格波段高低点的买卖点计算（仅针对上证指数和沪深300）
 * @param {number[]} scores 忽略（占位符）
 * @param {number[]} prices 原始收盘价数组
 * @param {string} symbol 指数代码
 * @returns {{buyPoints: number[], sellPoints: number[]}} 原始索引位置的买卖点数组
 */
/**
 * 基于沪深300恐贪值的买卖点计算
 * @param {number[]} scores 原始恐贪值数组
 * @param {number[]} prices 原始收盘价数组
 * @param {string} symbol 指数代码
 * @returns {{buyPoints: number[], sellPoints: number[]}} 原始索引位置的买卖点数组
 */
/**
 * 基于沪深300恐贪值的买卖点计算（简单阈值穿越）
 * @param {number[]} scores 原始恐贪值数组
 * @param {number[]} prices 忽略（保留参数占位）
 * @param {string} symbol 指数代码
 * @returns {{buyPoints: number[], sellPoints: number[]}} 原始索引位置的买卖点数组
 */
function calculateBuySellPoints (scores, prices, symbol) {

  const buyPoints = []
  const sellPoints = []

  const BUY_THRESHOLD = 30   // 买入阈值：低于30
  // 特殊处理不同指数的卖出阈值
  let SELL_THRESHOLD = 80  // 默认卖出阈值：高于80
  if (symbol === 'sh510880') {
    SELL_THRESHOLD = 75  // 红利指数：卖出阈值75
  } else if (symbol === 'sh000001' || symbol === 'sh000300') {
    SELL_THRESHOLD = 90  // 上证指数、沪深300：卖出阈值90
  }
  const MIN_INTERVAL = 20     // 同向信号最小间隔（天）

  let lastBuyIdx = -MIN_INTERVAL
  let lastSellIdx = -MIN_INTERVAL

  // 从第二天开始遍历，需要与前一日比较
  for (let i = 1; i < scores.length; i++) {
    const prev = scores[i - 1]
    const curr = scores[i]

    // 买入信号：从前一日 >=30 变为当日 <30（进入恐慌区）
    if (prev >= BUY_THRESHOLD && curr < BUY_THRESHOLD) {
      if (i - lastBuyIdx >= MIN_INTERVAL) {
        buyPoints.push(i)
        lastBuyIdx = i
        // 买入后重置卖出的冷却期（允许立即卖出）
        lastSellIdx = -MIN_INTERVAL
      }
    }

    // 卖出信号：从前一日 <=阈值 变为当日 >阈值（进入贪婪区）
    if (prev <= SELL_THRESHOLD && curr > SELL_THRESHOLD) {
      if (i - lastSellIdx >= MIN_INTERVAL) {
        sellPoints.push(i)
        lastSellIdx = i
        // 卖出后重置买入的冷却期（允许立即买入）
        lastBuyIdx = -MIN_INTERVAL
      }
    }
  }

  return { buyPoints, sellPoints }
}

/**
 * 计算RSI（相对强弱指标）
 * @param {number[]} prices 收盘价数组
 * @param {number} period 周期，默认14
 * @returns {number[]} RSI值数组，前period-1个为null
 */
function calculateRSI (prices, period = 14) {
  const rsi = new Array(prices.length).fill(null)
  if (prices.length <= period) return rsi

  // 计算每日价格变化
  const changes = []
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1])
  }

  // 初始化第一个平均值
  let avgGain = 0, avgLoss = 0
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) {
      avgGain += changes[i]
    } else {
      avgLoss += Math.abs(changes[i])
    }
  }
  avgGain /= period
  avgLoss /= period

  // 第一个RSI值
  if (avgLoss === 0) {
    rsi[period] = 100
  } else {
    const rs = avgGain / avgLoss
    rsi[period] = 100 - 100 / (1 + rs)
  }

  // 平滑计算后续RSI
  for (let i = period + 1; i < prices.length; i++) {
    const change = changes[i - 1]
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period
      avgLoss = (avgLoss * (period - 1) + 0) / period
    } else {
      avgGain = (avgGain * (period - 1) + 0) / period
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period
    }

    if (avgLoss === 0) {
      rsi[i] = 100
    } else {
      const rs = avgGain / avgLoss
      rsi[i] = 100 - 100 / (1 + rs)
    }
  }

  return rsi
}

function getBuySellAdvice (score, subScores) {
  if (score === null) return { advice: '数据不足', color: chalk.gray }

  if (score < 20) {
    return { advice: '极度恐慌，建议买入', color: chalk.green }
  } else if (score < 40) {
    return { advice: '恐慌，可考虑买入', color: chalk.cyan }
  } else if (score < 60) {
    // 进一步分析子指标
    if (subScores.s5_pricePosition < 30) {
      return { advice: '中性，价格低位，可分批买入', color: chalk.cyan }
    } else if (subScores.s5_pricePosition > 70) {
      return { advice: '中性，价格高位，建议观望', color: chalk.yellow }
    } else {
      return { advice: '中性，观望为主', color: chalk.white }
    }
  } else if (score < 80) {
    return { advice: '贪婪，考虑卖出', color: chalk.yellow }
  } else {
    return { advice: '极度贪婪，建议卖出', color: chalk.red }
  }
}

// ─── 控制台：综合得分汇总表 ─────────────────────────────────

function printSummaryTable (results) {
  console.log(chalk.bold.cyan('╔══════════════════════════════════════════════════════╗'))
  console.log(chalk.bold.cyan('║           多指数恐贪指数 — 最新得分汇总              ║'))
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════╝\n'))

  const t = new Table({
    head: ['指数', '最新日期', '综合得分', '情绪判断', '建议'].map((h) => chalk.bold(h)),
    colWidths: [13, 13, 12, 12, 18],
    style: { border: ['cyan'] },
  })

  for (const r of results) {
    if (r.error) {
      t.push([r.name, '–', chalk.red('获取失败'), '–', '–'])
      continue
    }

    const s = r.fg.latestScore
    if (s === null) {
      t.push([r.name, '–', chalk.gray('数据不足'), '–', '–'])
      continue
    }

    const label = getLabel(s).replace(' 🔥', '').replace(' ❄️', '')
    const advice = getBuySellAdvice(s, r.fg.latestSubs)
    t.push([r.name, r.fg.latestDate, scoreStr(s), label, advice.color(advice.advice)])
  }
  console.log(t.toString())
  console.log(chalk.gray('  0–20 极度恐慌 | 20–40 恐慌 | 40–60 中性 | 60–80 贪婪 | 80–100 极度贪婪\n'))
}

// ─── 控制台：子指标明细 ─────────────────────────────────────

function printSubIndicators (results) {
  console.log(chalk.bold.cyan('╔══════════════════════════════════════════════════════╗'))
  console.log(chalk.bold.cyan('║         多指数恐贪指数 — 5子指标得分明细             ║'))
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════╝\n'))

  const t = new Table({
    head: ['指数', '①价格动能', '②波动率↓', '③RSI(14)', '④方向量', '⑤价格位置', '综合'].map((h) => chalk.bold(h)),
    colWidths: [13, 12, 11, 11, 10, 12, 10],
    style: { border: ['cyan'] },
  })

  for (const r of results) {
    if (r.error || !r.fg.latestScore) {
      t.push([r.name, '–', '–', '–', '–', '–', '–'])
      continue
    }

    const sub = r.fg.latestSubs
    t.push([
      r.name,
      fmtSub(sub.s1_momentum),
      fmtSub(sub.s2_volatility),
      fmtSub(sub.s3_rsi),
      fmtSub(sub.s4_volMomentum),
      fmtSub(sub.s5_pricePosition),
      scoreStr(r.fg.latestScore),
    ])
  }

  console.log(t.toString())
  console.log(chalk.gray('  子指标均为历史百分位得分（0–100），蓝<30<青<45<白<55<黄<70<红\n'))
}

// ─── HTML 报告 ───────────────────────────────────────────────

function generateHTML (results, today, processedMinuteDataMap, marketInfo = null, volumeDataMap = new Map()) {
  const valid = results.filter((r) => !r.error && r.fg.latestScore !== null)

  // 所有指数共用同一套日期轴（取第一个有效结果的）
  const dates = valid.length > 0 ? valid[0].displayDates : []

  // 市场状态信息
  const marketStatusHTML = marketInfo ? `
<div class="wrap" style="border-color: ${marketInfo.marketStatus === 'bull' ? '#3fb950' : marketInfo.marketStatus === 'bear' ? '#f85149' : '#e3b341'}33;">
  <h2 style="display: flex; align-items: center; gap: 12px;">
    <span style="font-size: 1.1rem;">📊</span>
    <span>市场状态判断</span>
    <span style="margin-left: auto; font-size: 1rem; font-weight: 700; color: ${marketInfo.marketStatus === 'bull' ? '#3fb950' : marketInfo.marketStatus === 'bear' ? '#f85149' : '#e3b341'}">
      ${marketInfo.marketStatus === 'bull' ? '🟢 牛市' : marketInfo.marketStatus === 'bear' ? '🔴 熊市' : '🟡 震荡市'}
    </span>
  </h2>
  <div style="margin-top: 12px; padding: 12px; background: #0d1117; border-radius: 8px;">
    <p style="font-size: 0.85rem; color: #8b949e; margin-bottom: 12px;">
      ${marketInfo.marketStatus === 'bull' ? '当前处于牛市环境，市场情绪积极，建议适当提高风险承受。' :
      marketInfo.marketStatus === 'bear' ? '当前处于熊市环境，市场情绪低迷，建议保持谨慎。' :
        '当前处于震荡行情，方向不明，建议观望为主。'}
    </p>
    
    <div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #30363d;">
      <p style="font-size: 0.75rem; color: #8b949e; margin-bottom: 8px; font-weight: 700;">📈 牛熊得分统计</p>
      <div style="display: flex; gap: 20px;">
        <div style="flex: 1; padding: 10px; background: rgba(63, 185, 80, 0.1); border-radius: 6px; text-align: center;">
          <span style="font-size: 0.75rem; color: #8b949e;">牛市得分</span>
          <div style="font-size: 1.5rem; font-weight: 700; color: #3fb950;">${marketInfo.bullScore || 0}/4</div>
          <div style="height: 8px; background: #21262d; border-radius: 4px; margin-top: 6px; overflow: hidden;">
            <div style="height: 100%; width: ${((marketInfo.bullScore || 0) / 4) * 100}%; background: #3fb950; border-radius: 4px;"></div>
          </div>
        </div>
        <div style="flex: 1; padding: 10px; background: rgba(248, 81, 73, 0.1); border-radius: 6px; text-align: center;">
          <span style="font-size: 0.75rem; color: #8b949e;">熊市得分</span>
          <div style="font-size: 1.5rem; font-weight: 700; color: #f85149;">${marketInfo.bearScore || 0}/4</div>
          <div style="height: 8px; background: #21262d; border-radius: 4px; margin-top: 6px; overflow: hidden;">
            <div style="height: 100%; width: ${((marketInfo.bearScore || 0) / 4) * 100}%; background: #f85149; border-radius: 4px;"></div>
          </div>
        </div>
      </div>
      <p style="font-size: 0.7rem; color: #6e7681; margin-top: 8px;">判断规则：≥3分判定为对应市场状态，否则为震荡市</p>
    </div>
    
    ${marketInfo.details ? `
    <div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #30363d;">
      <p style="font-size: 0.75rem; color: #8b949e; margin-bottom: 8px; font-weight: 700;">📊 判断依据（4项指标）</p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;">
        <div style="padding: 8px; background: #161b22; border-radius: 6px;">
          <span style="font-size: 0.72rem; color: #8b949e;">① 200日均线</span>
          <div style="font-size: 0.85rem; margin-top: 4px;">
            价格 <span style="color: #c9d1d9;">${marketInfo.details.ma200.price}</span> 
            <span style="color: ${marketInfo.details.ma200.isAbove ? '#3fb950' : '#f85149'};">${marketInfo.details.ma200.isAbove ? '>' : '<'}</span> 
            MA200 <span style="color: #c9d1d9;">${marketInfo.details.ma200.value}</span>
            <span style="color: ${marketInfo.details.ma200.score === 1 ? '#3fb950' : '#f85149'}; margin-left: 4px;">(${marketInfo.details.ma200.score === 1 ? '+' : ''}${marketInfo.details.ma200.score})</span>
          </div>
        </div>
        <div style="padding: 8px; background: #161b22; border-radius: 6px;">
          <span style="font-size: 0.72rem; color: #8b949e;">② 60天趋势</span>
          <div style="font-size: 0.85rem; margin-top: 4px;">
            涨跌幅 <span style="color: ${marketInfo.details.trendChange.score === 1 ? '#3fb950' : marketInfo.details.trendChange.score === -1 ? '#f85149' : '#c9d1d9'};">${marketInfo.details.trendChange.value}</span>
            <span style="color: ${marketInfo.details.trendChange.score === 1 ? '#3fb950' : marketInfo.details.trendChange.score === -1 ? '#f85149' : '#8b949e'}; margin-left: 4px;">(${marketInfo.details.trendChange.score === 1 ? '+' : ''}${marketInfo.details.trendChange.score})</span>
          </div>
        </div>
        <div style="padding: 8px; background: #161b22; border-radius: 6px;">
          <span style="font-size: 0.72rem; color: #8b949e;">③ 恐贪指数</span>
          <div style="font-size: 0.85rem; margin-top: 4px;">
            30天平均 <span style="color: #c9d1d9;">${marketInfo.details.avgFearGreed.value}</span>
            <span style="color: ${marketInfo.details.avgFearGreed.score === 1 ? '#3fb950' : marketInfo.details.avgFearGreed.score === -1 ? '#f85149' : '#8b949e'}; margin-left: 4px;">(${marketInfo.details.avgFearGreed.score === 1 ? '+' : ''}${marketInfo.details.avgFearGreed.score})</span>
          </div>
        </div>
        <div style="padding: 8px; background: #161b22; border-radius: 6px;">
          <span style="font-size: 0.72rem; color: #8b949e;">④ RSI指标</span>
          <div style="font-size: 0.85rem; margin-top: 4px;">
            <span style="color: #c9d1d9;">${marketInfo.details.rsi.value}</span>
            <span style="color: ${marketInfo.details.rsi.score === 1 ? '#3fb950' : marketInfo.details.rsi.score === -1 ? '#f85149' : '#8b949e'}; margin-left: 4px;">(${marketInfo.details.rsi.score === 1 ? '+' : ''}${marketInfo.details.rsi.score})</span>
          </div>
        </div>
      </div>
    </div>
    ` : ''}
    
    <div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #30363d;">
      <p style="font-size: 0.75rem; color: #8b949e; margin-bottom: 8px; font-weight: 700;">📌 当前阈值（已调整）</p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px;">
        <div>
          <span style="font-size: 0.75rem; color: #8b949e;">买入阈值</span>
          <div style="font-size: 1.1rem; font-weight: 700; color: #3fb950;">${marketInfo.thresholds.buyThreshold}</div>
        </div>
        <div>
          <span style="font-size: 0.75rem; color: #8b949e;">卖出阈值</span>
          <div style="font-size: 1.1rem; font-weight: 700; color: #f85149;">${marketInfo.thresholds.sellThreshold}</div>
        </div>
        <div>
          <span style="font-size: 0.75rem; color: #8b949e;">信号间隔</span>
          <div style="font-size: 1.1rem; font-weight: 700; color: #58a6ff;">${marketInfo.thresholds.minInterval}天</div>
        </div>
      </div>
    </div>
    
    ${marketInfo.latestScore !== undefined ? `
    <div>
      <p style="font-size: 0.75rem; color: #8b949e; margin-bottom: 8px; font-weight: 700;">💰 当前恐贪指数</p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px;">
        <div>
          <span style="font-size: 0.75rem; color: #8b949e;">当前值</span>
          <div style="font-size: 1.3rem; font-weight: 700; color: ${marketInfo.latestScore < 40 ? '#f85149' : marketInfo.latestScore > 60 ? '#3fb950' : '#e3b341'};">${marketInfo.latestScore.toFixed(1)}</div>
        </div>
        <div>
          <span style="font-size: 0.75rem; color: #8b949e;">买入信号</span>
          <div style="font-size: 1.1rem; font-weight: 700; color: ${marketInfo.canBuy ? '#3fb950' : '#6e7681'};">${marketInfo.canBuy ? '✅ 可买入' : '❌ 不可买入'}</div>
        </div>
        <div>
          <span style="font-size: 0.75rem; color: #8b949e;">卖出信号</span>
          <div style="font-size: 1.1rem; font-weight: 700; color: ${marketInfo.canSell ? '#f85149' : '#6e7681'};">${marketInfo.canSell ? '✅ 可卖出' : '❌ 不可卖出'}</div>
        </div>
      </div>
    </div>
    ` : ''}
  </div>
</div>
` : ''

  // 4条 F&G 折线
  const fgDatasets = valid.map((r) => JSON.stringify({
    label: r.name,
    data: r.displayScores,
    borderColor: r.color,
    borderWidth: 2,
    pointRadius: 0,
    fill: false,
    spanGaps: false,
    tension: 0.25,
  })).join(',\n    ')

  // 获取买入卖出建议
  const getHTMLAdvice = (score, subScores) => {
    if (score === null) return { text: '数据不足', cls: 'gray' }

    if (score < 20) {
      return { text: '极度恐慌，建议买入', cls: 'green' }
    } else if (score < 40) {
      return { text: '恐慌，可考虑买入', cls: 'blue' }
    } else if (score < 60) {
      if (subScores.s5_pricePosition < 30) {
        return { text: '中性，价格低位，可分批买入', cls: 'blue' }
      } else if (subScores.s5_pricePosition > 70) {
        return { text: '中性，价格高位，建议观望', cls: 'orange' }
      } else {
        return { text: '中性，观望为主', cls: 'yellow' }
      }
    } else if (score < 80) {
      return { text: '贪婪，考虑卖出', cls: 'orange' }
    } else {
      return { text: '极度贪婪，建议卖出', cls: 'red' }
    }
  }

  // KPI 卡片
  const kpiCards = valid.map((r) => {
    const s = r.fg.latestScore
    const lbl = getLabel(s).replace(' 🔥', '').replace(' ❄️', '')
    const cls = s >= 80 ? 'red' : s >= 60 ? 'orange' : s >= 40 ? 'yellow' : s >= 20 ? 'blue' : 'blue'
    const advice = getHTMLAdvice(s, r.fg.latestSubs)
    return `<div class="card"><div class="lbl">${r.name}</div><div class="val ${cls}">${s.toFixed(1)} · ${lbl}</div><div class="advice ${advice.cls}">${advice.text}</div></div>`
  }).join('\n  ')

  // 子指标表格 HTML
  const subRows = valid.map((r) => {
    const sub = r.fg.latestSubs
    const sc = (v) => {
      const cls = v >= 70 ? 'red' : v >= 55 ? 'orange' : v >= 45 ? 'yellow' : v >= 30 ? 'blue' : 'blue'
      return `<span class="${cls}">${v.toFixed(1)}</span>`
    }
    const advice = getHTMLAdvice(r.fg.latestScore, sub)
    const volumeData = volumeDataMap ? volumeDataMap.get(r.symbol) : null

    let volumeChangeStr = '–'
    let volumeChangeCls = ''
    if (volumeData) {
      const changePercent = volumeData.volumeChangePercent
      volumeChangeStr = `${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}%`
      volumeChangeCls = changePercent > 0 ? 'green' : changePercent < 0 ? 'red' : ''
    }

    return `<tr>
      <td>${r.name}</td>
      <td>${sc(sub.s1_momentum)}</td>
      <td>${sc(sub.s2_volatility)}</td>
      <td>${sc(sub.s3_rsi)}</td>
      <td>${sc(sub.s4_volMomentum)}</td>
      <td>${sc(sub.s5_pricePosition)}</td>
      <td><strong>${sc(r.fg.latestScore)}</strong></td>
      <td><span class="${advice.cls}">${advice.text}</span></td>
    </tr>`
  }).join('\n    ')

  const refLines = [
    `{label:'极度贪婪(80)',data:D.map(()=>80),borderColor:'rgba(248,81,73,0.35)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:false}`,
    `{label:'贪婪(60)',data:D.map(()=>60),borderColor:'rgba(240,136,62,0.4)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:false}`,
    `{label:'中性(40)',data:D.map(()=>40),borderColor:'rgba(227,179,65,0.4)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:false}`,
    `{label:'恐慌(20)',data:D.map(()=>20),borderColor:'rgba(121,192,255,0.4)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:false}`,
  ].join(',\n    ')

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>多指数恐贪对比报告</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',sans-serif;padding:24px}
    h1{text-align:center;color:#58a6ff;font-size:1.5rem;margin-bottom:6px}
    .sub{text-align:center;color:#8b949e;font-size:.85rem;margin-bottom:28px}
    .kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:28px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 16px}
    .card .lbl{font-size:.72rem;color:#8b949e;margin-bottom:4px}
    .card .val{font-size:1.1rem;font-weight:700}
    .card .advice{font-size:.8rem;margin-top:6px}
    .green{color:#3fb950}.red{color:#f85149}.blue{color:#58a6ff}
    .orange{color:#f0883e}.yellow{color:#e3b341}.gray{color:#8b949e}
    .wrap{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:20px;margin-bottom:22px}
    .wrap h2{font-size:.9rem;color:#8b949e;margin-bottom:14px}
    table.sub-table{width:100%;border-collapse:collapse;font-size:.82rem}
    table.sub-table th{background:#21262d;color:#8b949e;padding:6px 10px;text-align:center;border:1px solid #30363d}
    table.sub-table td{padding:6px 10px;text-align:center;border:1px solid #21262d}
    table.sub-table tr:hover td{background:#161b22}
    .card .position{font-size:.8rem;margin-top:4px;color:#8b949e}
    .hint{font-size:.72rem;color:#8b949e;margin-top:8px}
    .grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(480px,1fr));gap:18px;margin-bottom:22px}
    .idx-panel{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:18px}
    .idx-panel .panel-title{font-size:.95rem;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:10px}
    .idx-panel .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
    .idx-panel .chart-lbl{font-size:.75rem;color:#8b949e;margin:12px 0 6px}
  </style>
</head>
<body>
<h1>多指数市场恐贪指数 · 对比报告</h1>
<p class="sub">统计区间：${DISPLAY_FROM} → ${today} &nbsp;·&nbsp; 5指标简化模型 &nbsp;·&nbsp; 数据来源：腾讯财经</p>

<div class="kpi">
  ${kpiCards}
</div>

${marketStatusHTML}

<div class="wrap">
  <h2>① 恐贪指数走势对比（${DISPLAY_FROM} 至今，4指数叠加）</h2>
  <canvas id="fgChart" height="70"></canvas>
</div>



<div class="grid-2">
${valid.map((r, i) => {
    const minuteData = processedMinuteDataMap ? processedMinuteDataMap.get(r.symbol) : null
    if (!minuteData) return ''
    return `
  <div class="wrap">
    <h2>③ ${r.name}分时图（5分钟K线，M20线，分时恐贪）</h2>
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
      <span style="font-size: 0.85rem; color: #8b949e;">最新分时恐贪：</span>
      <span style="font-size: 0.95rem; font-weight: 700; color: ${minuteData.latestFG >= 80 ? '#f85149' : minuteData.latestFG >= 60 ? '#f0883e' : minuteData.latestFG >= 40 ? '#e3b341' : minuteData.latestFG >= 20 ? '#79c0ff' : '#58a6ff'}">${minuteData.latestFG || '–'} · ${minuteData.latestFGLabel || '–'}</span>
    </div>
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
      <span style="font-size: 0.85rem; color: #8b949e;">当前价格：</span>
      <span style="font-size: 0.95rem; font-weight: 700; color: #c9d1d9">${minuteData.latestPrice ? minuteData.latestPrice.toFixed(2) : '–'}</span>
      <span style="font-size: 0.85rem; color: #8b949e;">M20价格：</span>
      <span style="font-size: 0.95rem; font-weight: 700; color: #c9d1d9">${minuteData.m20Data && minuteData.m20Data[minuteData.m20Data.length - 1] ? minuteData.m20Data[minuteData.m20Data.length - 1].toFixed(2) : '–'}</span>
      <span style="font-size: 0.85rem; color: #8b949e;">M20状态：</span>
      <span style="font-size: 0.95rem; font-weight: 700; color: ${minuteData.isAboveM20 ? '#3fb950' : '#f85149'}">${minuteData.isAboveM20 ? '站上' : minuteData.isAboveM20 === false ? '跌破' : '数据不足'}</span>
    </div>
    <canvas id="minuteChart${i}" height="60"></canvas>
  </div>
  `
  }).join('')}
</div>

<h2 style="color:#8b949e;font-size:.9rem;margin-bottom:14px">④ 各指数单独走势详情</h2>
<div class="grid-2">
${valid.map((r, i) => {
    const s = r.fg.latestScore
    const lbl = getLabel(s).replace(' 🔥', '').replace(' ❄️', '')
    const cls = s >= 80 ? '#f85149' : s >= 60 ? '#f0883e' : s >= 40 ? '#e3b341' : '#79c0ff'
    return `  <div class="idx-panel" style="border-color:${r.color}33">
    <div class="panel-title">
      <span class="dot" style="background:${r.color}"></span>
      <span style="color:${r.color}">${r.name}</span>
      <span style="color:${cls};font-size:.85rem">▎${s.toFixed(1)} / 100 · ${lbl}</span>
      <span style="color:#8b949e;font-size:.72rem;margin-left:auto">${r.fg.latestDate}</span>
    </div>
    <div class="chart-lbl">价格与恐贪指数走势（${DISPLAY_FROM} 至今）</div>
    <canvas id="pf${i}" height="110"></canvas>
  </div>`
  }).join('\n')}
</div>

<div class="wrap">
  <h2>⑤ 5子指标得分明细（当前最新交易日）</h2>
  <table class="sub-table">
    <thead>
      <tr>
        <th>指数</th><th>①价格动能</th><th>②波动率↓</th><th>③RSI(14)</th><th>④方向成交量</th><th>⑤价格位置</th><th>综合得分</th><th>投资建议</th>
      </tr>
    </thead>
    <tbody>
    ${subRows}
    </tbody>
  </table>
  <p class="hint">子指标均为历史百分位得分（0–100）&nbsp;·&nbsp; 0–20 极度恐慌 | 20–40 恐慌 | 40–60 中性 | 60–80 贪婪 | 80–100 极度贪婪</p>
</div>


<script>
const D=${JSON.stringify(dates)};
const gc='rgba(48,54,61,0.8)',tc='#8b949e';
const base={
  responsive:true,
  interaction:{mode:'index',intersect:false},
  plugins:{legend:{labels:{color:tc,usePointStyle:true,pointStyleWidth:10}}},
  scales:{
    x:{ticks:{color:tc,maxTicksLimit:14,maxRotation:0},grid:{color:gc}},
    y:{ticks:{color:tc},grid:{color:gc}}
  }
};

// ① 恐贪走势
new Chart(document.getElementById('fgChart'),{
  type:'line',
  data:{
    labels:D,
    datasets:[
      ${fgDatasets},
      ${refLines}
    ]
  },
  options:{
    ...base,
    plugins:{
      ...base.plugins,
      legend:{labels:{color:tc,filter:(i)=>!i.text.includes('('),usePointStyle:true}},
    },
    scales:{
      x:{ticks:{color:tc,maxTicksLimit:14,maxRotation:0},grid:{color:gc}},
      y:{ticks:{color:tc,stepSize:20},grid:{color:gc},min:0,max:100,
         title:{display:true,text:'恐贪值',color:tc}}
    }
  }
});



// ④ 各指数单独面板
const IDX=${JSON.stringify(valid.map((r) => ({
    color: r.color,
    dates: r.displayDates,
    closes: r.displayCloses,
    scores: r.displayScores,
    buyPoints: r.buyPoints,
    sellPoints: r.sellPoints,
  })))};

const refDS = (D) => [
  {label:'极度贪婪(80)',data:D.map(()=>80),borderColor:'rgba(248,81,73,0.35)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:false},
  {label:'贪婪(60)',    data:D.map(()=>60),borderColor:'rgba(240,136,62,0.4)', borderWidth:1,borderDash:[3,4],pointRadius:0,fill:false},
  {label:'中性(40)',    data:D.map(()=>40),borderColor:'rgba(227,179,65,0.4)', borderWidth:1,borderDash:[3,4],pointRadius:0,fill:false},
  {label:'恐慌(20)',    data:D.map(()=>20),borderColor:'rgba(121,192,255,0.4)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:false},
];

IDX.forEach((idx, i) => {
  const noLegend = {
    ...base,
    plugins:{legend:{display:false}},
  };

  // 合并价格与恐贪指数图表
  const validFG = idx.scores.filter(v=>v!==null);
  if(validFG.length > 0){
    // 计算买入卖出点数据
    const buyData = idx.scores.map((score, i) => idx.buyPoints.includes(i) ? score : null);
    const sellData = idx.scores.map((score, i) => idx.sellPoints.includes(i) ? score : null);
    
    new Chart(document.getElementById('pf'+i),{
      type:'line',
      data:{labels:idx.dates,datasets:[
        // 价格数据
        {label:'收盘价',data:idx.closes,
         borderColor:idx.color,backgroundColor:idx.color+'14',
         borderWidth:1.5,pointRadius:0,fill:true,tension:0.1,
         yAxisID:'y'},
        // 恐贪值数据
        {label:'恐贪值',data:idx.scores,
         borderColor:'rgba(200,200,200,0.85)',borderWidth:1.8,
         pointRadius:0,fill:false,spanGaps:false,tension:0.2,
         yAxisID:'y1'},
        // 买入点
        {label:'买入点',data:buyData,
         borderColor:'rgba(63, 185, 80, 0.8)',backgroundColor:'rgba(63, 185, 80, 1)',
         borderWidth:0,pointRadius:6,pointHoverRadius:8,fill:false,spanGaps:true,
         yAxisID:'y1'},
        // 卖出点
        {label:'卖出点',data:sellData,
         borderColor:'rgba(248, 81, 73, 0.8)',backgroundColor:'rgba(248, 81, 73, 1)',
         borderWidth:0,pointRadius:6,pointHoverRadius:8,fill:false,spanGaps:true,
         yAxisID:'y1'},
        // 参考线
        ...refDS(idx.dates).map(ds => ({
          ...ds,
          yAxisID:'y1'
        })),
      ]},
      options:{
        ...noLegend,
        scales:{
          x:{ticks:{color:tc,maxTicksLimit:10,maxRotation:0},grid:{color:gc}},
          y:{ticks:{color:tc},grid:{color:gc},
             title:{display:true,text:'点位/价格',color:tc}},
          y1:{ticks:{color:tc,stepSize:20},grid:{color:'rgba(255,255,255,0.05)'},min:0,max:100,
              title:{display:true,text:'恐贪值',color:tc},
              position:'right',
              grid:{drawOnChartArea:false}}
        }
      },
    });
  }
});

${processedMinuteDataMap ? `
// ③ 各指数分时图
const minuteDataMap = ${JSON.stringify(Object.fromEntries(processedMinuteDataMap))};
const indices = ${JSON.stringify(valid.map((r, i) => ({ symbol: r.symbol, name: r.name, color: r.color, index: i })))};

indices.forEach((idx) => {
  const minuteData = minuteDataMap[idx.symbol];
  if (minuteData && document.getElementById('minuteChart' + idx.index)) {
    new Chart(document.getElementById('minuteChart' + idx.index),{
      type:'line',
      data:{
        labels:minuteData.fiveMinuteData.map(d => d.time),
        datasets:[
          // 5分钟价格线
          {label:'5分钟价格',data:minuteData.fiveMinuteData.map(d => d.price),
           borderColor:idx.color,backgroundColor:idx.color+'14',
           borderWidth:2,pointRadius:0,fill:false,tension:0.1,
           yAxisID:'y'},
          // M20线
          {label:'M20',data:minuteData.m20Data,
           borderColor:'#f0883e',backgroundColor:'transparent',
           borderWidth:1.5,pointRadius:0,fill:false,tension:0.1,borderDash:[3,4],
           yAxisID:'y'},
          // 分时恐贪指数
          {label:'分时恐贪',data:minuteData.fiveMinuteFG,
           borderColor:'#f85149',backgroundColor:'rgba(248, 81, 73, 0.1)',
           borderWidth:1.8,pointRadius:0,fill:false,tension:0.2,
           yAxisID:'y1'}
        ]
      },
      options:{
        ...base,
        plugins:{
          ...base.plugins,
          legend:{display:true,position:'top',labels:{color:tc}}
        },
        scales:{
          x:{ticks:{color:tc,maxTicksLimit:15,maxRotation:0},grid:{color:gc}},
          y:{ticks:{color:tc},grid:{color:gc},title:{display:true,text:'价格',color:tc}},
          y1:{ticks:{color:tc,stepSize:20},grid:{color:'rgba(255,255,255,0.05)'},min:0,max:100,
              title:{display:true,text:'恐贪值',color:tc},
              position:'right',
              grid:{drawOnChartArea:false}}
        }
      }
    });
  }
});
` : ''}
</script>
</body>
</html>`

  const outPath = path.join(process.cwd(), 'multi-report.html')
  fs.writeFileSync(outPath, html, 'utf8')
  return outPath
}

// ─── 工具函数 ────────────────────────────────────────────────

function scoreStr (s) {
  if (s >= 80) return chalk.red(s.toFixed(1))
  if (s >= 60) return chalk.yellow(s.toFixed(1))
  if (s >= 40) return chalk.white(s.toFixed(1))
  if (s >= 20) return chalk.cyan(s.toFixed(1))
  return chalk.blue(s.toFixed(1))
}

function fmtSub (s) {
  if (s >= 70) return chalk.red(s.toFixed(1))
  if (s >= 55) return chalk.yellow(s.toFixed(1))
  if (s >= 45) return chalk.white(s.toFixed(1))
  if (s >= 30) return chalk.cyan(s.toFixed(1))
  return chalk.blue(s.toFixed(1))
}

function buildBar (score) {
  const filled = Math.round(score / 5)
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled)
  if (score >= 80) return chalk.red(bar)
  if (score >= 60) return chalk.yellow(bar)
  if (score >= 40) return chalk.white(bar)
  if (score >= 20) return chalk.cyan(bar)
  return chalk.blue(bar)
}

main().catch((err) => {
  console.error(chalk.red('\n运行出错：'), err.message)
  process.exit(1)
})
