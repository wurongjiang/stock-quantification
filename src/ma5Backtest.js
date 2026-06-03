#!/usr/bin/env node

// ─── 五日线策略回测系统 ────────────────────────────────────────
// 策略逻辑：
// 1. 价格上穿五日线时买入
// 2. 价格跌破五日线时卖出
// 3. 计算2024年1月到2026年3月17日的收益率

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
  MA5: 5,          // 五日线
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
 * 执行回测
 * @param {Array} data - 日线数据
 * @returns {Object} 回测结果
 */
function backtestMA5Strategy (data) {
  const prices = data.map(d => d.close)
  const dates = data.map(d => d.date)
  const ma5 = calculateMA(prices, STRATEGY_PARAMS.MA5)

  let position = 0 // 0: 空仓, 1: 持仓
  let buyPrice = 0
  let sellPrice = 0
  let totalReturn = 0
  let trades = []

  for (let i = STRATEGY_PARAMS.MA5; i < prices.length; i++) {
    const price = prices[i]
    const currentMA5 = ma5[i]
    const prevPrice = prices[i - 1]
    const prevMA5 = ma5[i - 1]

    // 上穿五日线，买入
    if (position === 0 && prevPrice < prevMA5 && price > currentMA5) {
      position = 1
      buyPrice = price
      trades.push({
        date: dates[i],
        type: 'buy',
        price: buyPrice
      })
    }
    // 跌破五日线，卖出
    else if (position === 1 && prevPrice > prevMA5 && price < currentMA5) {
      position = 0
      sellPrice = price
      const tradeReturn = (sellPrice - buyPrice) / buyPrice
      totalReturn += tradeReturn
      trades.push({
        date: dates[i],
        type: 'sell',
        price: sellPrice,
        return: tradeReturn
      })
    }
  }

  // 如果最后仍然持仓，计算到最后一天的收益
  if (position === 1) {
    const finalPrice = prices[prices.length - 1]
    const finalReturn = (finalPrice - buyPrice) / buyPrice
    totalReturn += finalReturn
    trades.push({
      date: dates[dates.length - 1],
      type: 'sell',
      price: finalPrice,
      return: finalReturn
    })
  }

  return {
    totalReturn,
    trades,
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    startPrice: prices[0],
    endPrice: prices[prices.length - 1],
    buyAndHoldReturn: (prices[prices.length - 1] - prices[0]) / prices[0]
  }
}

// ─── 主函数 ────────────────────────────────────────────────
async function main (showDetail = true) {
  console.log(chalk.bold.cyan('╔══════════════════════════════════════════════════════╗'))
  console.log(chalk.bold.cyan('║                五日线策略回测系统                      ║'))
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════╝'))
  console.log()
  console.log(chalk.bold.yellow(`回测时间范围: ${START_DATE} → ${END_DATE}`))
  console.log(chalk.bold.yellow('策略逻辑: 价格上穿五日线买入，跌破五日线卖出'))
  console.log()

  const results = []

  for (const idx of INDICES) {
    try {
      console.log(chalk.blue(`正在回测 ${idx.name} (${idx.symbol})...`))

      // 获取日线数据
      const dailyData = await fetchIndexData(idx.symbol, idx.name, START_DATE, END_DATE, 1000)

      if (dailyData.length < STRATEGY_PARAMS.MA5) {
        console.log(chalk.yellow(`  ${idx.name} 数据不足，跳过回测`))
        results.push({ ...idx, error: '数据不足' })
        continue
      }

      // 执行回测
      const backtestResult = backtestMA5Strategy(dailyData)

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
function generateReport (results, showDetail = true) {
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
      r.trades.length / 2,
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
          console.log(chalk.green(`    ${trade.date} 买入: ${trade.price.toFixed(2)}`))
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

module.exports = { main, backtestMA5Strategy }