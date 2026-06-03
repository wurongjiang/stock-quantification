#!/usr/bin/env node

// ─── 高级策略回测系统 ────────────────────────────────────────
// 策略逻辑：
// 买入条件：
// 1. 价格站上20日均线，且20日均线拐头向上
// 2. 或者MACD金叉
// 3. 或者SAR翻红
// 
// 卖出条件：
// 1. 跌破20日均线
// 2. 或者MACD死叉
// 3. 或者SAR翻绿
// 
// 仓位管理：
// 1. 初始仓位较轻
// 2. 趋势确认后加仓
// 3. 趋势破位立即清仓

const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const Table = require('cli-table3')

// ─── 导入工具函数 ──────────────────────────────────────────
const { fetchIndexData } = require('./fetchData')

// ─── 配置 ──────────────────────────────────────────────────
const INDICES = [
  { symbol: 'sh000001', name: '上证指数', category: '沪深' },
  { symbol: 'sh000300', name: '沪深300', category: '沪深' },
  { symbol: 'sh000905', name: '中证500', category: '中证' },
  { symbol: 'sh000821', name: '红利', category: '红利' },
  { symbol: 'sh000688', name: '科创50', category: '科芯' },
]

// 回测时间范围
const START_DATE = '2024-10-10'
const END_DATE = '2026-03-17'

// 策略参数
const STRATEGY_PARAMS = {
  MA20: 20,          // 20日均线
  MACD_FAST: 12,     // MACD快线
  MACD_SLOW: 26,     // MACD慢线
  MACD_SIGNAL: 9,    // MACD信号
  SAR_STEP: 0.02,    // SAR步长
  SAR_MAX: 0.2,      // SAR最大步长
  INITIAL_POSITION: 30, // 初始仓位（百分比）
  FULL_POSITION: 100,   // 满仓仓位（百分比）
  ADD_POSITION: 30,      // 加仓幅度（百分比）
}

// ─── 工具函数 ──────────────────────────────────────────────

/**
 * 计算移动平均线
 * @param {number[]} data - 价格数据数组
 * @param {number} period - 周期
 * @returns {number[]} 移动平均线数组
 */
function calculateMA (data, period) {
  const result = []
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null)
    } else {
      const sum = data.slice(i - period + 1, i + 1).reduce((acc, val) => acc + val, 0)
      result.push(sum / period)
    }
  }
  return result
}

/**
 * 计算MACD指标
 * @param {number[]} prices - 价格数据数组
 * @returns {Object} MACD指标对象
 */
function calculateMACD (prices) {
  const fastPeriod = STRATEGY_PARAMS.MACD_FAST
  const slowPeriod = STRATEGY_PARAMS.MACD_SLOW
  const signalPeriod = STRATEGY_PARAMS.MACD_SIGNAL
  
  // 计算EMA
  function calculateEMA(data, period) {
    const ema = []
    const multiplier = 2 / (period + 1)
    
    // 第一个EMA值为前period个数据的平均值
    let sum = 0
    for (let i = 0; i < period; i++) {
      sum += data[i]
    }
    ema.push(sum / period)
    
    // 计算其余EMA值
    for (let i = period; i < data.length; i++) {
      const currentEMA = (data[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]
      ema.push(currentEMA)
    }
    
    // 填充前period-1个为null
    const result = new Array(period - 1).fill(null).concat(ema)
    return result
  }
  
  const ema12 = calculateEMA(prices, fastPeriod)
  const ema26 = calculateEMA(prices, slowPeriod)
  
  // 计算MACD线
  const macdLine = []
  for (let i = 0; i < prices.length; i++) {
    if (ema12[i] === null || ema26[i] === null) {
      macdLine.push(null)
    } else {
      macdLine.push(ema12[i] - ema26[i])
    }
  }
  
  // 计算信号线
  const signalLine = calculateEMA(macdLine.filter(val => val !== null), signalPeriod)
  const filledSignalLine = new Array(prices.length - signalLine.length).fill(null).concat(signalLine)
  
  // 计算柱状图
  const histogram = []
  for (let i = 0; i < prices.length; i++) {
    if (macdLine[i] === null || filledSignalLine[i] === null) {
      histogram.push(null)
    } else {
      histogram.push(macdLine[i] - filledSignalLine[i])
    }
  }
  
  return {
    macdLine,
    signalLine: filledSignalLine,
    histogram
  }
}

/**
 * 计算SAR指标
 * @param {number[]} prices - 价格数据数组
 * @param {number[]} highs - 最高价数据数组
 * @param {number[]} lows - 最低价数据数组
 * @returns {number[]} SAR指标数组
 */
function calculateSAR (prices, highs, lows) {
  const step = STRATEGY_PARAMS.SAR_STEP
  const maxStep = STRATEGY_PARAMS.SAR_MAX
  const sar = []
  
  let trend = 'up'
  let ep = highs[0]
  let af = step
  sar.push(lows[0] - (highs[0] - lows[0]) * 0.02)
  
  for (let i = 1; i < prices.length; i++) {
    const prevSar = sar[i - 1]
    let currentSar
    
    if (trend === 'up') {
      currentSar = prevSar + af * (ep - prevSar)
      if (lows[i] < currentSar) {
        trend = 'down'
        currentSar = ep
        af = step
        ep = lows[i]
      } else {
        if (highs[i] > ep) {
          ep = highs[i]
          af = Math.min(af + step, maxStep)
        }
      }
    } else {
      currentSar = prevSar - af * (prevSar - ep)
      if (highs[i] > currentSar) {
        trend = 'up'
        currentSar = ep
        af = step
        ep = highs[i]
      } else {
        if (lows[i] < ep) {
          ep = lows[i]
          af = Math.min(af + step, maxStep)
        }
      }
    }
    
    sar.push(currentSar)
  }
  
  return sar
}

/**
 * 检查20日均线是否拐头向上
 * @param {number[]} ma20 - 20日均线数组
 * @param {number} index - 当前索引
 * @returns {boolean} 是否拐头向上
 */
function isMA20Up (ma20, index) {
  if (index < 5) return false
  return ma20[index] > ma20[index - 1] && ma20[index - 1] > ma20[index - 2]
}

/**
 * 检查MACD是否金叉
 * @param {number[]} macdLine - MACD线数组
 * @param {number[]} signalLine - 信号线数组
 * @param {number} index - 当前索引
 * @returns {boolean} 是否金叉
 */
function isMACDCrossover (macdLine, signalLine, index) {
  if (index < 1) return false
  return macdLine[index - 1] < signalLine[index - 1] && macdLine[index] > signalLine[index]
}

/**
 * 检查MACD是否死叉
 * @param {number[]} macdLine - MACD线数组
 * @param {number[]} signalLine - 信号线数组
 * @param {number} index - 当前索引
 * @returns {boolean} 是否死叉
 */
function isMACDDivergence (macdLine, signalLine, index) {
  if (index < 1) return false
  return macdLine[index - 1] > signalLine[index - 1] && macdLine[index] < signalLine[index]
}

/**
 * 检查SAR是否翻红
 * @param {number[]} prices - 价格数据数组
 * @param {number[]} sar - SAR指标数组
 * @param {number} index - 当前索引
 * @returns {boolean} 是否翻红
 */
function isSARRed (prices, sar, index) {
  if (index < 1) return false
  return prices[index] > sar[index] && prices[index - 1] <= sar[index - 1]
}

/**
 * 检查SAR是否翻绿
 * @param {number[]} prices - 价格数据数组
 * @param {number[]} sar - SAR指标数组
 * @param {number} index - 当前索引
 * @returns {boolean} 是否翻绿
 */
function isSARGray (prices, sar, index) {
  if (index < 1) return false
  return prices[index] < sar[index] && prices[index - 1] >= sar[index - 1]
}

/**
 * 执行回测
 * @param {Array} data - 日线数据
 * @returns {Object} 回测结果
 */
function backtestAdvancedStrategy (data) {
  const prices = data.map(d => d.close)
  const highs = data.map(d => d.high)
  const lows = data.map(d => d.low)
  const dates = data.map(d => d.date)
  
  // 计算技术指标
  const ma20 = calculateMA(prices, STRATEGY_PARAMS.MA20)
  const macd = calculateMACD(prices)
  const sar = calculateSAR(prices, highs, lows)
  
  let position = 0 // 0: 空仓, 1: 持仓
  let currentPositionPercentage = 0 // 当前仓位百分比
  let buyPrice = 0
  let sellPrice = 0
  let totalReturn = 0
  let trades = []
  let positionHistory = []
  
  for (let i = STRATEGY_PARAMS.MA20; i < prices.length; i++) {
    const price = prices[i]
    const currentMA20 = ma20[i]
    
    // 买入条件
    if (position === 0) {
      const ma20Condition = price > currentMA20 && isMA20Up(ma20, i)
      const macdCondition = isMACDCrossover(macd.macdLine, macd.signalLine, i)
      const sarCondition = isSARRed(prices, sar, i)
      
      if (ma20Condition || macdCondition || sarCondition) {
        position = 1
        currentPositionPercentage = STRATEGY_PARAMS.INITIAL_POSITION
        buyPrice = price
        trades.push({
          date: dates[i],
          type: 'buy',
          price: buyPrice,
          position: currentPositionPercentage
        })
        positionHistory.push({
          date: dates[i],
          position: currentPositionPercentage
        })
      }
    }
    // 持仓状态
    else if (position === 1) {
      // 加仓条件：趋势确认（价格继续上涨且20日均线持续向上）
      if (price > buyPrice * 1.05 && isMA20Up(ma20, i) && currentPositionPercentage < STRATEGY_PARAMS.FULL_POSITION) {
        const addPosition = Math.min(STRATEGY_PARAMS.ADD_POSITION, STRATEGY_PARAMS.FULL_POSITION - currentPositionPercentage)
        currentPositionPercentage += addPosition
        trades.push({
          date: dates[i],
          type: 'add',
          price: price,
          position: currentPositionPercentage
        })
        positionHistory.push({
          date: dates[i],
          position: currentPositionPercentage
        })
      }
      
      // 卖出条件
      const ma20Condition = price < currentMA20
      const macdCondition = isMACDDivergence(macd.macdLine, macd.signalLine, i)
      const sarCondition = isSARGray(prices, sar, i)
      
      if (ma20Condition || macdCondition || sarCondition) {
        position = 0
        sellPrice = price
        const tradeReturn = (sellPrice - buyPrice) / buyPrice * (currentPositionPercentage / 100)
        totalReturn += tradeReturn
        trades.push({
          date: dates[i],
          type: 'sell',
          price: sellPrice,
          position: 0,
          return: tradeReturn
        })
        positionHistory.push({
          date: dates[i],
          position: 0
        })
        currentPositionPercentage = 0
      }
    }
  }
  
  // 如果最后仍然持仓，计算到最后一天的收益
  if (position === 1) {
    const finalPrice = prices[prices.length - 1]
    const finalReturn = (finalPrice - buyPrice) / buyPrice * (currentPositionPercentage / 100)
    totalReturn += finalReturn
    trades.push({
      date: dates[dates.length - 1],
      type: 'sell',
      price: finalPrice,
      position: 0,
      return: finalReturn
    })
    positionHistory.push({
      date: dates[dates.length - 1],
      position: 0
    })
  }
  
  return {
    totalReturn,
    trades,
    positionHistory,
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    startPrice: prices[0],
    endPrice: prices[prices.length - 1],
    buyAndHoldReturn: (prices[prices.length - 1] - prices[0]) / prices[0]
  }
}

// ─── 主函数 ────────────────────────────────────────────────
async function main (showDetail = false) {
  console.log(chalk.bold.cyan('╔══════════════════════════════════════════════════════╗'))
  console.log(chalk.bold.cyan('║                高级策略回测系统                      ║'))
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════╝'))
  console.log()
  console.log(chalk.bold.yellow(`回测时间范围: ${START_DATE} → ${END_DATE}`))
  console.log(chalk.bold.yellow('买入条件: 价格站上20日均线且拐头向上，或MACD金叉，或SAR翻红'))
  console.log(chalk.bold.yellow('卖出条件: 跌破20日均线，或MACD死叉，或SAR翻绿'))
  console.log(chalk.bold.yellow('仓位管理: 初始仓位较轻，趋势确认后加仓，趋势破位立即清仓'))
  console.log()

  const results = []

  for (const idx of INDICES) {
    try {
      console.log(chalk.blue(`正在回测 ${idx.name} (${idx.symbol})...`))

      // 获取日线数据
      const dailyData = await fetchIndexData(idx.symbol, idx.name, START_DATE, END_DATE, 1000)

      if (dailyData.length < STRATEGY_PARAMS.MA20) {
        console.log(chalk.yellow(`  ${idx.name} 数据不足，跳过回测`))
        results.push({ ...idx, error: '数据不足' })
        continue
      }

      // 执行回测
      const backtestResult = backtestAdvancedStrategy(dailyData)
      
      results.push({
        ...idx,
        ...backtestResult
      })

      console.log(chalk.green(`  ✓ ${idx.name} 回测完成`))

    } catch (error) {
      console.log(chalk.red(`  ✗ ${idx.name} 回测失败: ${error.message}`))
      results.push({ ...idx, error: error.message })
    }
  }

  // 生成报告
  generateReport(results, showDetail)
}

// ─── 报告生成 ──────────────────────────────────────────────
function generateReport (results, showDetail = false) {
  console.log('\n' + chalk.bold.cyan('╔══════════════════════════════════════════════════════╗'))
  console.log(chalk.bold.cyan('║                回测结果报告                            ║'))
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════╝\n'))

  // 详细回测结果表格
  const t = new Table({
    head: ['指数', '总收益', '买入持有收益率', '交易次数', '开始日期', '结束日期'].map(h => chalk.bold(h)),
    colWidths: [13, 15, 15, 10, 12, 12],
    style: { border: ['cyan'] },
  })

  for (const r of results) {
    if (r.error) {
      t.push([r.name, '–', '–', '–', '–', '–'])
      continue
    }

    t.push([
      r.name,
      `${(r.totalReturn * 100).toFixed(2)}%`,
      `${(r.buyAndHoldReturn * 100).toFixed(2)}%`,
      r.trades.length,
      r.startDate,
      r.endDate
    ])
  }

  console.log(t.toString())

  // 交易明细
  if (showDetail) {
    console.log('\n' + chalk.bold.yellow('交易明细:'))
    for (const r of results) {
      if (r.error) continue

      console.log(`\n${chalk.bold(r.name)}:`)
      console.log(chalk.gray('  交易记录:'))
      
      for (const trade of r.trades) {
        if (trade.type === 'buy') {
          console.log(chalk.green(`    ${trade.date} 买入: ${trade.price.toFixed(2)} (仓位: ${trade.position}%)`))
        } else if (trade.type === 'add') {
          console.log(chalk.blue(`    ${trade.date} 加仓: ${trade.price.toFixed(2)} (仓位: ${trade.position}%)`))
        } else {
          console.log(chalk.red(`    ${trade.date} 卖出: ${trade.price.toFixed(2)} (收益率: ${(trade.return * 100).toFixed(2)}%)`))
        }
      }
    }
  }
}

// ─── 执行 ─────────────────────────────────────────────────
if (require.main === module) {
  const showDetail = process.argv.indexOf('--detail') !== -1
  main(showDetail).catch(err => {
    console.error(chalk.red('执行失败:', err))
    process.exit(1)
  })
}

module.exports = { main, backtestAdvancedStrategy }