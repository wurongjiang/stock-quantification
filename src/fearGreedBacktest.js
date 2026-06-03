#!/usr/bin/env node

// ─── 恐贪指数策略回测系统 ────────────────────────────────────
// 策略逻辑：
// 买入条件：
// 1. 恐贪指数 < 20
// 2. RSI(14) < 30
// 3. 分3批建仓（每跌3%加一批）
// 
// 卖出条件：
// 1. 恐贪指数 > 80
// 2. RSI(14) > 70
// 3. 分3批减仓
// 
// 止损条件：
// 1. 基本面恶化（此处简化为跌破200日均线）
// 2. 跌破历史前低

const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const Table = require('cli-table3')

// ─── 导入工具函数 ──────────────────────────────────────────
const { fetchIndexData } = require('./fetchData')
const { calcFearGreed } = require('./fearGreed')

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
  RSI_PERIOD: 14,     // RSI周期
  MA200: 200,         // 200日均线
  FEAR_THRESHOLD: 20,  // 恐贪指数买入阈值
  GREED_THRESHOLD: 80, // 恐贪指数卖出阈值
  RSI_BUY_THRESHOLD: 30, // RSI买入阈值
  RSI_SELL_THRESHOLD: 70, // RSI卖出阈值
  BATCH_SIZE: 3,       // 建仓/减仓批次
  BATCH_DROP: 3,       // 每批建仓的价格下跌百分比
  MAX_POSITION: 100,   // 最大仓位（百分比）
  STOP_LOSS_PERCENT: 10, // 止损百分比
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
 * 计算RSI指标
 * @param {number[]} prices - 价格数据数组
 * @param {number} period - 周期
 * @returns {number[]} RSI指标数组
 */
function calculateRSI (prices, period) {
  const rsi = []
  const changes = []

  // 计算价格变化
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1])
  }

  // 计算初始平均增益和平均损失
  let avgGain = 0
  let avgLoss = 0

  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) {
      avgGain += changes[i]
    } else {
      avgLoss += Math.abs(changes[i])
    }
  }

  avgGain /= period
  avgLoss /= period

  // 计算第一个RSI值
  const firstRS = avgGain / avgLoss
  const firstRSI = 100 - (100 / (1 + firstRS))
  rsi.push(null) // 前period个值为null

  for (let i = 0; i < period - 1; i++) {
    rsi.push(null)
  }
  rsi.push(firstRSI)

  // 计算其余RSI值
  for (let i = period; i < changes.length; i++) {
    const currentChange = changes[i]
    let currentGain = 0
    let currentLoss = 0

    if (currentChange > 0) {
      currentGain = currentChange
    } else {
      currentLoss = Math.abs(currentChange)
    }

    avgGain = (avgGain * (period - 1) + currentGain) / period
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period

    let rs = 0
    if (avgLoss === 0) {
      rs = 100
    } else {
      rs = avgGain / avgLoss
    }

    const currentRSI = 100 - (100 / (1 + rs))
    rsi.push(currentRSI)
  }

  return rsi
}

/**
 * 计算历史前低
 * @param {number[]} prices - 价格数据数组
 * @param {number} index - 当前索引
 * @param {number} lookback - 回溯期数
 * @returns {number} 历史前低
 */
function getHistoricalLow (prices, index, lookback = 200) {
  const start = Math.max(0, index - lookback)
  const slice = prices.slice(start, index + 1)
  return Math.min(...slice)
}

/**
 * 执行回测
 * @param {Array} data - 日线数据
 * @returns {Object} 回测结果
 */
function backtestFearGreedStrategy (data) {
  const prices = data.map(d => d.close)
  const dates = data.map(d => d.date)

  // 计算技术指标
  const ma200 = calculateMA(prices, STRATEGY_PARAMS.MA200)
  const rsi = calculateRSI(prices, STRATEGY_PARAMS.RSI_PERIOD)

  // 计算恐贪指数
  let fearGreedScores = []
  try {
    const fg = calcFearGreed(data, 'sh000001') // 使用上证指数计算恐贪指数
    if (fg && fg.scores) {
      fearGreedScores = fg.scores
    } else {
      // 如果恐贪指数计算失败，使用默认值
      fearGreedScores = new Array(prices.length).fill(50)
    }
  } catch (e) {
    // 如果计算失败，使用默认值
    fearGreedScores = new Array(prices.length).fill(50)
  }

  let position = 0 // 0: 空仓, 1: 持仓
  let currentPositionPercentage = 0 // 当前仓位百分比
  let buyPrice = 0
  let sellPrice = 0
  let totalReturn = 0
  let trades = []
  let positionHistory = []
  let batchCount = 0 // 建仓批次计数
  let lastBuyPrice = 0 // 上次建仓价格

  for (let i = Math.max(STRATEGY_PARAMS.MA200, STRATEGY_PARAMS.RSI_PERIOD); i < prices.length; i++) {
    const price = prices[i]
    const currentMA200 = ma200[i]
    const currentRSI = rsi[i]
    const currentFearGreed = fearGreedScores[i] || 50
    const historicalLow = getHistoricalLow(prices, i)

    // 买入条件
    if (position === 0) {
      const buyCondition = currentFearGreed < STRATEGY_PARAMS.FEAR_THRESHOLD && currentRSI < STRATEGY_PARAMS.RSI_BUY_THRESHOLD

      if (buyCondition) {
        position = 1
        batchCount = 1
        currentPositionPercentage = STRATEGY_PARAMS.MAX_POSITION / STRATEGY_PARAMS.BATCH_SIZE
        buyPrice = price
        lastBuyPrice = price
        trades.push({
          date: dates[i],
          type: 'buy',
          price: buyPrice,
          position: currentPositionPercentage,
          batch: batchCount
        })
        positionHistory.push({
          date: dates[i],
          position: currentPositionPercentage
        })
      }
    }
    // 持仓状态
    else if (position === 1) {
      // 分批建仓
      if (batchCount < STRATEGY_PARAMS.BATCH_SIZE && price < lastBuyPrice * (1 - STRATEGY_PARAMS.BATCH_DROP / 100)) {
        batchCount++
        const addPosition = STRATEGY_PARAMS.MAX_POSITION / STRATEGY_PARAMS.BATCH_SIZE
        currentPositionPercentage += addPosition
        lastBuyPrice = price
        trades.push({
          date: dates[i],
          type: 'buy',
          price: price,
          position: currentPositionPercentage,
          batch: batchCount
        })
        positionHistory.push({
          date: dates[i],
          position: currentPositionPercentage
        })
      }

      // 卖出条件
      const sellCondition = currentFearGreed > STRATEGY_PARAMS.GREED_THRESHOLD && currentRSI > STRATEGY_PARAMS.RSI_SELL_THRESHOLD

      if (sellCondition) {
        // 分3批减仓
        const sellBatchSize = currentPositionPercentage / STRATEGY_PARAMS.BATCH_SIZE

        for (let j = 0; j < STRATEGY_PARAMS.BATCH_SIZE; j++) {
          currentPositionPercentage -= sellBatchSize
          if (currentPositionPercentage < 0) currentPositionPercentage = 0

          trades.push({
            date: dates[i],
            type: 'sell',
            price: price,
            position: currentPositionPercentage,
            batch: j + 1
          })
        }

        position = 0
        sellPrice = price
        const tradeReturn = (sellPrice - buyPrice) / buyPrice * (STRATEGY_PARAMS.MAX_POSITION / 100)
        totalReturn += tradeReturn

        positionHistory.push({
          date: dates[i],
          position: 0
        })
        batchCount = 0
      }

      // 止损条件
      const stopLossCondition = price < currentMA200 || price < historicalLow * 0.95

      if (stopLossCondition) {
        position = 0
        sellPrice = price
        const tradeReturn = (sellPrice - buyPrice) / buyPrice * (currentPositionPercentage / 100)
        totalReturn += tradeReturn
        trades.push({
          date: dates[i],
          type: 'sell',
          price: sellPrice,
          position: 0,
          return: tradeReturn,
          reason: '止损'
        })
        positionHistory.push({
          date: dates[i],
          position: 0
        })
        batchCount = 0
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
  console.log(chalk.bold.cyan('║                恐贪指数策略回测系统                    ║'))
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════╝'))
  console.log()
  console.log(chalk.bold.yellow(`回测时间范围: ${START_DATE} → ${END_DATE}`))
  console.log(chalk.bold.yellow('买入条件: 恐贪指数<20，且RSI(14)<30，分3批建仓（每跌3%加一批）'))
  console.log(chalk.bold.yellow('卖出条件: 恐贪指数>80，且RSI(14)>70，分3批减仓'))
  console.log(chalk.bold.yellow('止损条件: 基本面恶化（跌破200日均线）或跌破历史前低'))
  console.log()

  const results = []

  for (const idx of INDICES) {
    try {
      console.log(chalk.blue(`正在回测 ${idx.name} (${idx.symbol})...`))

      // 获取日线数据
      const dailyData = await fetchIndexData(idx.symbol, idx.name, START_DATE, END_DATE, 1000)

      if (dailyData.length < Math.max(STRATEGY_PARAMS.MA200, STRATEGY_PARAMS.RSI_PERIOD)) {
        console.log(chalk.yellow(`  ${idx.name} 数据不足，跳过回测`))
        results.push({ ...idx, error: '数据不足' })
        continue
      }

      // 执行回测
      const backtestResult = backtestFearGreedStrategy(dailyData)

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
          console.log(chalk.green(`    ${trade.date} 买入: ${trade.price.toFixed(2)} (仓位: ${trade.position.toFixed(2)}%, 批次: ${trade.batch})`))
        } else {
          const reason = trade.reason ? ` (${trade.reason})` : ''
          console.log(chalk.red(`    ${trade.date} 卖出: ${trade.price.toFixed(2)} (仓位: ${trade.position.toFixed(2)}%${reason})`))
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

module.exports = { main, backtestFearGreedStrategy }