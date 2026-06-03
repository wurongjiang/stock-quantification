#!/usr/bin/env node

// ─── 交易策略系统 ────────────────────────────────────────────
// 策略逻辑：
// 1. 所有个股使用30分钟的M20作为参照
// 2. 严格按照五日线：3020上就进，破五日线就出
// 3. 低位3020上，仓位可放大；高位3020上，仓位必须小
// 4. 关键点位博弈总持仓不可超过1w
// 5. 博弈点位：十日线、二十日线
// 6. 不同产品的价格划分：
//    - 科芯：2W
//    - 红利：10W
//    - 中证：2W
//    - 沪深：4W

const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const Table = require('cli-table3')

// ─── 导入工具函数 ──────────────────────────────────────────
const { fetchIndexData, fetchMinuteData, fetchMairui30MinData } = require('./fetchData')
const { calcSMA, calcFearGreed } = require('./fearGreed')

// ─── 配置 ──────────────────────────────────────────────────
const INDICES = [
  { symbol: 'sh000001', name: '上证指数', category: '沪深', priceLimit: 40000, showPosition: false },
  { symbol: 'sh000300', name: '沪深300', category: '沪深', priceLimit: 40000, showPosition: true, use3020Rule: true },
  { symbol: 'sh000905', name: '中证500', category: '中证', priceLimit: 20000, showPosition: true, use3020Rule: true },
  { symbol: 'sh000821', name: '红利', category: '红利', priceLimit: 100000, showPosition: true, use3020Rule: false },
  { symbol: 'sh000688', name: '科创50', category: '科芯', priceLimit: 20000, showPosition: true, use3020Rule: true },
]

// 策略参数
const STRATEGY_PARAMS = {
  MA5: 5,          // 五日线
  MA10: 10,        // 十日线
  MA20: 20,        // 二十日线
  M20_30MIN: 20,   // 30分钟M20
  MAX_GAME_POSITION: 10000, // 关键点位博弈总持仓上限
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
 * 判断是否在3020上
 * @param {number} price - 当前价格
 * @param {number} m20 - 30分钟M20
 * @returns {boolean} 是否在3020上
 */
function isAboveM20 (price, m20) {
  return price > m20
}

/**
 * 判断是否破五日线
 * @param {number} price - 当前价格
 * @param {number} ma5 - 五日线
 * @returns {boolean} 是否破五日线
 */
function isBelowMA5 (price, ma5) {
  return price < ma5
}

/**
 * 判断是否在低位
 * @param {number} price - 当前价格
 * @param {number[]} prices - 价格历史数据
 * @returns {boolean} 是否在低位
 */
function isLowPosition (price, prices) {
  if (prices.length < 30) return false
  const recentPrices = prices.slice(-30)
  const avgPrice = recentPrices.reduce((acc, val) => acc + val, 0) / recentPrices.length
  return price < avgPrice * 0.95
}

/**
 * 判断是否在高位
 * @param {number} price - 当前价格
 * @param {number[]} prices - 价格历史数据
 * @returns {boolean} 是否在高位
 */
function isHighPosition (price, prices) {
  if (prices.length < 30) return false
  const recentPrices = prices.slice(-30)
  const avgPrice = recentPrices.reduce((acc, val) => acc + val, 0) / recentPrices.length
  return price > avgPrice * 1.05
}

/**
 * 判断是否在250日均线附近
 * @param {number} price - 当前价格
 * @param {number} ma250 - 250日均线
 * @returns {boolean} 是否在250日均线附近
 */
function isNearMA250 (price, ma250) {
  const threshold = 0.03 // 3%阈值
  return Math.abs(price - ma250) / ma250 < threshold
}

/**
 * 计算红利低波ETF的建议仓位
 * @param {number} price - 当前价格
 * @param {number} ma250 - 250日均线
 * @param {number} fearGreed - 恐贪指数
 * @returns {number} 建议仓位（百分比）
 */
function calculateHongLiPosition (price, ma250, fearGreed) {
  // 距离M250越近越买入
  if (ma250) {
    const distance = Math.abs(price - ma250) / ma250
    if (distance < 0.01) { // 1%以内，非常接近
      return 100
    } else if (distance < 0.03) { // 3%以内，比较接近
      return 80
    } else if (distance < 0.05) { // 5%以内，接近
      return 60
    }
  }

  // 恐贪低于40以下，陆续买入
  if (fearGreed < 30) {
    return 100
  } else if (fearGreed < 40) {
    return 80
  }

  // 恐贪高于75以上，陆续卖出
  if (fearGreed >= 90) {
    return 0
  } else if (fearGreed >= 80) {
    return 20
  } else if (fearGreed >= 75) {
    return 40
  }

  // 中性位置
  return 60
}

/**
 * 计算建议仓位
 * @param {number} price - 当前价格
 * @param {number[]} prices - 价格历史数据
 * @param {boolean} isAboveM20 - 是否在3020上
 * @param {boolean} isBelowMA5 - 是否破五日线
 * @param {string} category - 产品类别
 * @param {number} priceLimit - 价格限制
 * @param {string} symbol - 指数代码
 * @param {number} ma250 - 250日均线
 * @param {number} fearGreed - 恐贪指数
 * @returns {number} 建议仓位（百分比）
 */
function calculatePosition (price, prices, isAboveM20, isBelowMA5, category, priceLimit, symbol, ma250, fearGreed) {
  // 红利低波ETF使用单独规则
  if (symbol === 'sh000821') {
    return calculateHongLiPosition(price, ma250, fearGreed)
  }

  // 其他指数使用原有规则
  // 破五日线，清仓
  if (isBelowMA5) {
    return 0
  }

  // 不在3020上，清仓
  if (!isAboveM20) {
    return 0
  }

  // 低位3020上，仓位可放大
  if (isLowPosition(price, prices)) {
    return 100
  }

  // 高位3020上，仓位必须小
  if (isHighPosition(price, prices)) {
    return 30
  }

  // 中性位置
  return 60
}

/**
 * 计算建议持仓金额
 * @param {number} position - 仓位百分比
 * @param {number} priceLimit - 价格限制
 * @returns {number} 建议持仓金额
 */
function calculatePositionAmount (position, priceLimit) {
  return (position / 100) * priceLimit
}

/**
 * 检查是否在关键点位
 * @param {number} price - 当前价格
 * @param {number} ma10 - 十日线
 * @param {number} ma20 - 二十日线
 * @returns {boolean} 是否在关键点位
 */
function isAtKeyLevel (price, ma10, ma20) {
  const threshold = 0.01 // 1%阈值
  return Math.abs(price - ma10) / ma10 < threshold || Math.abs(price - ma20) / ma20 < threshold
}

// ─── 主函数 ────────────────────────────────────────────────
async function main () {
  console.log(chalk.bold.cyan('╔══════════════════════════════════════════════════════╗'))
  console.log(chalk.bold.cyan('║                交易策略分析系统                      ║'))
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════╝'))
  console.log()

  const results = []
  let totalGamePosition = 0

  for (const idx of INDICES) {
    try {
      console.log(chalk.blue(`正在分析 ${idx.name} (${idx.symbol})...`))

      // 获取日线数据
      const endDate = new Date().toISOString().split('T')[0]
      const startDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      const dailyData = await fetchIndexData(idx.symbol, idx.name, startDate, endDate, 60)

      if (dailyData.length < STRATEGY_PARAMS.MA20) {
        console.log(chalk.yellow(`  ${idx.name} 数据不足，跳过分析`))
        results.push({ ...idx, error: '数据不足' })
        continue
      }

      // 处理数据
      const prices = dailyData.map(d => d.close)
      const ma5 = calculateMA(prices, STRATEGY_PARAMS.MA5)
      const ma10 = calculateMA(prices, STRATEGY_PARAMS.MA10)
      const ma20 = calculateMA(prices, STRATEGY_PARAMS.MA20)

      // 计算250日均线（仅红利低波ETF需要）
      let ma250 = null
      if (idx.symbol === 'sh000821' && prices.length >= 250) {
        ma250 = calculateMA(prices, 250)
      }

      // 获取30分钟K线数据
      let minuteData
      let m20_30min

      // 红利指数不需要30分钟M20数据，直接使用20日均线
      if (idx.symbol === 'sh000821') {
        console.log(`  ${idx.name} 不需要30分钟M20数据，使用20日均线代替`)
        m20_30min = ma20
      } else {
        try {
          // 对所有指数使用Mairui API获取30分钟数据
          minuteData = await fetchMairui30MinData(idx.symbol, idx.name)
          // 处理30分钟数据，计算M20
          const minutePrices = minuteData.map(d => d.close)
          m20_30min = calculateMA(minutePrices, STRATEGY_PARAMS.M20_30MIN)
        } catch (error) {
          // 如果API获取失败，使用原来的分时数据作为fallback
          console.log(chalk.yellow(`  ${idx.name} 30分钟K线获取失败，使用分时数据作为fallback: ${error.message}`))
          minuteData = await fetchMinuteData(idx.symbol)
          // 处理分时数据，计算30分钟M20
          // 由于接口限制，我们使用当日分时数据计算30分钟M20
          // 每6个5分钟数据点组成一个30分钟数据点
          const thirtyMinData = []
          for (let i = 0; i < minuteData.length; i += 6) {
            const segment = minuteData.slice(i, i + 6)
            if (segment.length === 6) {
              const closePrice = segment[segment.length - 1].price
              thirtyMinData.push(closePrice)
            }
          }
          m20_30min = calculateMA(thirtyMinData, STRATEGY_PARAMS.M20_30MIN)
        }

        // 如果30分钟数据不足，使用20日均线代替
        if (!m20_30min || m20_30min.length === 0) {
          m20_30min = ma20
        }
      }

      // 获取最新数据
      const latestPrice = prices[prices.length - 1]
      const latestMA5 = ma5[ma5.length - 1]
      const latestMA10 = ma10[ma10.length - 1]
      const latestMA20 = ma20[ma20.length - 1]
      let latestM20_30min = m20_30min[m20_30min.length - 1] || latestMA20 // 如果30分钟M20为null，使用20日均线代替

      // 检查30分钟M20是否合理，如果与20日均线相差太大，使用20日均线代替
      // 暂时移除检查，直接使用API返回的数据
      // if (latestM20_30min && latestMA20) {
      //   const ratio = Math.abs(latestM20_30min - latestMA20) / latestMA20
      //   if (ratio > 0.1) { // 如果相差超过10%，认为数据不合理
      //     console.log(chalk.yellow(`  ${idx.name} 30分钟M20数据不合理，使用20日均线代替`))
      //     latestM20_30min = latestMA20
      //   }
      // }

      // 判断条件
      const aboveM20 = isAboveM20(latestPrice, latestM20_30min)
      const belowMA5 = isBelowMA5(latestPrice, latestMA5)
      const atKeyLevel = isAtKeyLevel(latestPrice, latestMA10, latestMA20)

      // 计算仓位
      const position = calculatePosition(latestPrice, prices, aboveM20, belowMA5, idx.category, idx.priceLimit)
      const positionAmount = calculatePositionAmount(position, idx.priceLimit)

      // 计算关键点位博弈仓位
      let gamePosition = 0
      if (atKeyLevel && position > 0) {
        gamePosition = Math.min(STRATEGY_PARAMS.MAX_GAME_POSITION - totalGamePosition, positionAmount * 0.5)
        totalGamePosition += gamePosition
      }

      results.push({
        ...idx,
        latestPrice,
        latestMA5,
        latestMA10,
        latestMA20,
        latestM20_30min,
        aboveM20,
        belowMA5,
        atKeyLevel,
        position,
        positionAmount,
        gamePosition,
        totalPosition: positionAmount + gamePosition
      })

      console.log(chalk.green(`  ✓ ${idx.name} 分析完成`))

    } catch (error) {
      console.log(chalk.red(`  ✗ ${idx.name} 分析失败: ${error.message}`))
      results.push({ ...idx, error: error.message })
    }
  }

  // 生成报告
  generateReport(results, totalGamePosition)
}

/**
 * 格式化恐贪指数显示，根据数值显示不同颜色
 * @param {number} fearGreed - 恐贪指数
 * @returns {string} 格式化后的恐贪指数
 */
function formatFearGreed (fearGreed) {
  const value = fearGreed.toFixed(2)
  if (fearGreed < 30) {
    return chalk.blueBright(value) // 蓝色
  } else if (fearGreed < 45) {
    return chalk.cyanBright(value) // 青色
  } else if (fearGreed < 55) {
    return chalk.whiteBright(value) // 白色
  } else if (fearGreed < 70) {
    return chalk.yellowBright(value) // 黄色
  } else {
    return chalk.redBright(value) // 红色
  }
}

/**
 * 格式化恐贪指数显示，根据数值显示不同颜色（HTML版本）
 * @param {number} fearGreed - 恐贪指数
 * @returns {string} 格式化后的恐贪指数
 */
function formatFearGreedHTML (fearGreed) {
  const value = fearGreed.toFixed(2)
  let colorClass = ''
  if (fearGreed < 30) {
    colorClass = 'blue'
  } else if (fearGreed < 45) {
    colorClass = 'cyan'
  } else if (fearGreed < 55) {
    colorClass = 'white'
  } else if (fearGreed < 70) {
    colorClass = 'yellow'
  } else {
    colorClass = 'red'
  }
  return `<span class="${colorClass}">${value}</span>`
}

// ─── 报告生成 ──────────────────────────────────────────────
function generateReport (results, totalGamePosition) {
  console.log('\n' + chalk.bold.cyan('╔══════════════════════════════════════════════════════╗'))
  console.log(chalk.bold.cyan('║                交易策略分析报告                      ║'))
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════╝\n'))

  // 策略概览
  console.log(chalk.bold.yellow('策略概览:'))
  console.log(`- 30分钟M20作为参照`)
  console.log(`- 五日线：3020上就进，破五日线就出`)
  console.log(`- 低位3020上，仓位可放大；高位3020上，仓位必须小`)
  console.log(`- 关键点位博弈总持仓上限：${STRATEGY_PARAMS.MAX_GAME_POSITION}元`)
  console.log(`- 博弈点位：十日线、二十日线`)
  console.log(`- 当前关键点位博弈总持仓：${totalGamePosition.toFixed(2)}元\n`)

  // 详细分析表格
  const t = new Table({
    head: ['指数', '最新价格', 'MA5', 'MA20', '恐贪指数', '30分钟M20', '3020上', '破五日线', '关键点位', '建议仓位', '建议持仓', '博弈仓位', '总持仓'].map(h => chalk.bold(h)),
    colWidths: [13, 10, 8, 8, 12, 8, 8, 8, 8, 10, 8, 10],
    style: { border: ['cyan'] },
  })

  for (const r of results) {
    if (r.error) {
      t.push([r.name, '–', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–'])
      continue
    }

    t.push([
      r.name,
      r.latestPrice.toFixed(2),
      r.latestMA5.toFixed(2),
      r.latestMA20.toFixed(2),
      r.fearGreed ? formatFearGreed(r.fearGreed) : '–',
      r.latestM20_30min.toFixed(2),
      r.aboveM20 ? chalk.green('是') : chalk.red('否'),
      r.belowMA5 ? chalk.red('是') : chalk.green('否'),
      r.atKeyLevel ? chalk.yellow('是') : '否',
      `${r.position}%`,
      r.positionAmount.toFixed(2),
      r.gamePosition.toFixed(2),
      r.totalPosition.toFixed(2)
    ])
  }

  console.log(t.toString())

  // 交易建议
  console.log('\n' + chalk.bold.yellow('交易建议:'))
  for (const r of results) {
    if (r.error) continue

    let advice = ''

    // 红利低波ETF使用单独的交易规则
    if (r.symbol === 'sh000821') {
      if (r.fearGreed < 40) {
        advice = chalk.green('恐贪较低，建议买入')
      } else if (r.fearGreed >= 75) {
        advice = chalk.red('恐贪较高，建议卖出')
      } else if (r.position >= 80) {
        advice = chalk.green('距离M250较近，建议重仓')
      } else if (r.position >= 50) {
        advice = chalk.blue('中性位置，建议半仓')
      } else {
        advice = chalk.yellow('距离M250较远，建议轻仓')
      }
    } else {
      // 其他指数使用3020规则
      if (r.belowMA5) {
        advice = chalk.red('破五日线，建议清仓')
      } else if (!r.aboveM20) {
        advice = chalk.red('不在3020上，建议清仓')
      } else if (r.isLowPosition) {
        advice = chalk.green('低位3020上，建议满仓')
      } else if (r.isHighPosition) {
        advice = chalk.yellow('高位3020上，建议轻仓')
      } else {
        advice = chalk.blue('中性位置，建议半仓')
      }
    }

    if (r.atKeyLevel) {
      advice += chalk.yellow('，当前在关键点位，可适当博弈')
    }

    // 显示恐贪指数颜色信息
    let fearGreedInfo = ''
    if (r.fearGreed !== null) {
      if (r.fearGreed < 30) {
        fearGreedInfo = chalk.blueBright(`(恐贪: ${r.fearGreed.toFixed(2)} - 极度恐慌)`)
      } else if (r.fearGreed < 45) {
        fearGreedInfo = chalk.cyanBright(`(恐贪: ${r.fearGreed.toFixed(2)} - 恐慌)`)
      } else if (r.fearGreed < 55) {
        fearGreedInfo = chalk.whiteBright(`(恐贪: ${r.fearGreed.toFixed(2)} - 中性)`)
      } else if (r.fearGreed < 70) {
        fearGreedInfo = chalk.yellowBright(`(恐贪: ${r.fearGreed.toFixed(2)} - 贪婪)`)
      } else {
        fearGreedInfo = chalk.redBright(`(恐贪: ${r.fearGreed.toFixed(2)} - 极度贪婪)`)
      }
    }

    console.log(`${r.name}: ${advice} ${fearGreedInfo}`)
  }
}

// ─── HTML 报告 ──────────────────────────────────────────────
function generateHTML (results, totalGamePosition) {
  const valid = results.filter(r => !r.error)
  const today = new Date().toISOString().split('T')[0]

  // 生成HTML内容
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>交易策略分析报告</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      background-color: #f5f5f5;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    
    h1, h2, h3 {
      color: #2c3e50;
      margin-bottom: 20px;
    }
    
    h1 {
      font-size: 28px;
      text-align: center;
      margin-top: 20px;
    }
    
    h2 {
      font-size: 24px;
      margin-top: 40px;
      border-bottom: 2px solid #3498db;
      padding-bottom: 10px;
    }
    
    h3 {
      font-size: 18px;
      margin-top: 30px;
    }
    
    .overview {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      margin-bottom: 30px;
    }
    
    .overview ul {
      list-style-type: none;
      padding-left: 20px;
    }
    
    .overview li {
      margin-bottom: 10px;
      position: relative;
    }
    
    .overview li::before {
      content: "•";
      color: #3498db;
      font-weight: bold;
      display: inline-block;
      width: 1em;
      margin-left: -1em;
    }
    
    .table-container {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      overflow-x: auto;
      margin-bottom: 30px;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
    }
    
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #e0e0e0;
    }
    
    th {
      background-color: #f8f9fa;
      font-weight: 600;
      color: #2c3e50;
    }
    
    tr:hover {
      background-color: #f5f5f5;
    }
    
    .green {
      color: #27ae60;
      font-weight: 600;
    }
    
    .red {
      color: #e74c3c;
      font-weight: 600;
    }
    
    .yellow {
      color: #f39c12;
      font-weight: 600;
    }
    
    .blue {
      color: #3498db;
      font-weight: 600;
    }
    
    .cyan {
      color: #00bcd4;
      font-weight: 600;
    }
    
    .white {
      color: #ffffff;
      font-weight: 600;
      text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
    }
    
    .advice {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }
    
    .advice-item {
      margin-bottom: 15px;
      padding: 15px;
      border-left: 4px solid #3498db;
      background-color: #f8f9fa;
      border-radius: 0 4px 4px 0;
    }
    
    .advice-item h4 {
      margin-bottom: 5px;
      color: #2c3e50;
    }
    
    .footer {
      text-align: center;
      margin-top: 40px;
      padding: 20px;
      color: #7f8c8d;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>交易策略分析报告</h1>
    <p style="text-align: center; color: #7f8c8d;">生成时间: ${today}</p>
    
    <div class="overview">
      <h2>策略概览</h2>
      <ul>
        <li>30分钟M20作为参照</li>
        <li>五日线：3020上就进，破五日线就出</li>
        <li>低位3020上，仓位可放大；高位3020上，仓位必须小</li>
        <li>关键点位博弈总持仓上限：${STRATEGY_PARAMS.MAX_GAME_POSITION}元</li>
        <li>博弈点位：十日线、二十日线</li>
        <li>当前关键点位博弈总持仓：${totalGamePosition.toFixed(2)}元</li>
      </ul>
    </div>
    
    <div class="table-container">
      <h2>详细分析</h2>
      <table>
        <thead>
          <tr>
            <th>指数</th>
            <th>最新价格</th>
            <th>MA5</th>
            <th>MA20</th>
            <th>恐贪指数</th>
            <th>30分钟M20</th>
            <th>3020上</th>
            <th>破五日线</th>
            <th>关键点位</th>
            <th>建议仓位</th>
            <th>建议持仓</th>
            <th>博弈仓位</th>
            <th>总持仓</th>
          </tr>
        </thead>
        <tbody>
          ${valid.map(r => `
            <tr>
              <td>${r.name}</td>
              <td>${r.latestPrice.toFixed(2)}</td>
              <td>${r.latestMA5.toFixed(2)}</td>
              <td>${r.latestMA20.toFixed(2)}</td>
              <td>${r.fearGreed ? formatFearGreedHTML(r.fearGreed) : '–'}</td>
              <td>${r.latestM20_30min.toFixed(2)}</td>
              <td class="${r.aboveM20 ? 'green' : 'red'}">${r.aboveM20 ? '是' : '否'}</td>
              <td class="${r.belowMA5 ? 'red' : 'green'}">${r.belowMA5 ? '是' : '否'}</td>
              <td class="${r.atKeyLevel ? 'yellow' : ''}">${r.atKeyLevel ? '是' : '否'}</td>
              <td>${r.position}%</td>
              <td>${r.positionAmount.toFixed(2)}</td>
              <td>${r.gamePosition.toFixed(2)}</td>
              <td>${r.totalPosition.toFixed(2)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    
    <div class="advice">
      <h2>交易建议</h2>
      ${valid.map(r => {
    let advice = ''
    let adviceClass = 'blue'

    // 红利低波ETF使用单独的交易规则
    if (r.symbol === 'sh000821') {
      if (r.fearGreed < 40) {
        advice = '恐贪较低，建议买入'
        adviceClass = 'green'
      } else if (r.fearGreed >= 75) {
        advice = '恐贪较高，建议卖出'
        adviceClass = 'red'
      } else if (r.position >= 80) {
        advice = '距离M250较近，建议重仓'
        adviceClass = 'green'
      } else if (r.position >= 50) {
        advice = '中性位置，建议半仓'
        adviceClass = 'blue'
      } else {
        advice = '距离M250较远，建议轻仓'
        adviceClass = 'yellow'
      }
    } else {
      // 其他指数使用3020规则
      if (r.belowMA5) {
        advice = '破五日线，建议清仓'
        adviceClass = 'red'
      } else if (!r.aboveM20) {
        advice = '不在3020上，建议清仓'
        adviceClass = 'red'
      } else if (isLowPosition(r.latestPrice, valid.find(v => v.symbol === r.symbol).prices)) {
        advice = '低位3020上，建议满仓'
        adviceClass = 'green'
      } else if (isHighPosition(r.latestPrice, valid.find(v => v.symbol === r.symbol).prices)) {
        advice = '高位3020上，建议轻仓'
        adviceClass = 'yellow'
      } else {
        advice = '中性位置，建议半仓'
        adviceClass = 'blue'
      }
    }

    if (r.atKeyLevel) {
      advice += '，当前在关键点位，可适当博弈'
    }

    return `
          <div class="advice-item">
            <h4>${r.name}</h4>
            <p class="${adviceClass}">${advice}</p>
          </div>
        `
  }).join('')}
    </div>
    
    <div class="footer">
      <p>交易策略分析系统 © ${new Date().getFullYear()}</p>
    </div>
  </div>
</body>
</html>
  `

  // 写入文件
  const htmlPath = path.join(__dirname, '../trading-report.html')
  fs.writeFileSync(htmlPath, html)

  return htmlPath
}

// ─── 执行 ─────────────────────────────────────────────────
async function main () {
  console.log(chalk.bold.cyan('╔══════════════════════════════════════════════════════╗'))
  console.log(chalk.bold.cyan('║                交易策略分析系统                      ║'))
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════╝'))
  console.log()

  const results = []
  let totalGamePosition = 0

  for (const idx of INDICES) {
    try {
      console.log(chalk.blue(`正在分析 ${idx.name} (${idx.symbol})...`))

      // 为所有指数获取足够的数据量，以便计算恐贪指数
      const endDate = new Date().toISOString().split('T')[0]
      let startDate
      let dataLimit
      if (idx.symbol === 'sh000821') {
        // 红利低波ETF需要250日均线，获取300天数据
        startDate = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        dataLimit = 300
      } else {
        // 其他指数需要足够的数据来计算恐贪指数，获取200天数据
        startDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        dataLimit = 200
      }

      const dailyData = await fetchIndexData(idx.symbol, idx.name, startDate, endDate, dataLimit)

      if (dailyData.length < STRATEGY_PARAMS.MA20) {
        console.log(chalk.yellow(`  ${idx.name} 数据不足，跳过分析`))
        results.push({ ...idx, error: '数据不足' })
        continue
      }

      // 处理数据
      const prices = dailyData.map(d => d.close)
      const ma5 = calculateMA(prices, STRATEGY_PARAMS.MA5)
      const ma10 = calculateMA(prices, STRATEGY_PARAMS.MA10)
      const ma20 = calculateMA(prices, STRATEGY_PARAMS.MA20)

      // 计算250日均线（仅红利低波ETF需要）
      let ma250 = null
      if (idx.symbol === 'sh000821' && prices.length >= 250) {
        ma250 = calculateMA(prices, 250)
      }

      // 获取30分钟K线数据
      let minuteData
      let m20_30min

      // 红利指数不需要30分钟M20数据，直接使用20日均线
      if (idx.symbol === 'sh000821') {
        console.log(`  ${idx.name} 不需要30分钟M20数据，使用20日均线代替`)
        m20_30min = ma20
      } else {
        try {
          // 对所有指数使用Mairui API获取30分钟数据
          minuteData = await fetchMairui30MinData(idx.symbol, idx.name)
          // 处理30分钟数据，计算M20
          const minutePrices = minuteData.map(d => d.close)
          m20_30min = calculateMA(minutePrices, STRATEGY_PARAMS.M20_30MIN)
        } catch (error) {
          // 如果API获取失败，使用原来的分时数据作为fallback
          console.log(chalk.yellow(`  ${idx.name} 30分钟K线获取失败，使用分时数据作为fallback: ${error.message}`))
          minuteData = await fetchMinuteData(idx.symbol)
          // 处理分时数据，计算30分钟M20
          // 由于接口限制，我们使用当日分时数据计算30分钟M20
          // 每6个5分钟数据点组成一个30分钟数据点
          const thirtyMinData = []
          for (let i = 0; i < minuteData.length; i += 6) {
            const segment = minuteData.slice(i, i + 6)
            if (segment.length === 6) {
              const closePrice = segment[segment.length - 1].price
              thirtyMinData.push(closePrice)
            }
          }
          m20_30min = calculateMA(thirtyMinData, STRATEGY_PARAMS.M20_30MIN)
        }

        // 如果30分钟数据不足，使用20日均线代替
        if (!m20_30min || m20_30min.length === 0) {
          m20_30min = ma20
        }
      }

      // 获取最新数据
      const latestPrice = prices[prices.length - 1]
      const latestMA5 = ma5[ma5.length - 1]
      const latestMA10 = ma10[ma10.length - 1]
      const latestMA20 = ma20[ma20.length - 1]
      const latestMA250 = ma250 ? ma250[ma250.length - 1] : null
      let latestM20_30min = m20_30min[m20_30min.length - 1] || latestMA20 // 如果30分钟M20为null，使用20日均线代替

      // 检查30分钟M20是否合理，如果与20日均线相差太大，使用20日均线代替
      // 暂时移除检查，直接使用API返回的数据
      // if (latestM20_30min && latestMA20) {
      //   const ratio = Math.abs(latestM20_30min - latestMA20) / latestMA20
      //   if (ratio > 0.1) { // 如果相差超过10%，认为数据不合理
      //     console.log(chalk.yellow(`  ${idx.name} 30分钟M20数据不合理，使用20日均线代替`))
      //     latestM20_30min = latestMA20
      //   }
      // }

      // 计算恐贪指数
      let fearGreed = null
      try {
        const fg = calcFearGreed(dailyData, idx.symbol)
        fearGreed = fg.latestScore
        if (fearGreed !== null) {
          console.log(chalk.blue(`  ${idx.name} 恐贪指数: ${fearGreed.toFixed(2)}`))
        } else {
          console.log(chalk.yellow(`  ${idx.name} 恐贪指数计算失败: 无数据`))
        }
      } catch (e) {
        console.log(chalk.yellow(`  ${idx.name} 恐贪指数计算失败: ${e.message}`))
      }

      // 判断条件
      const aboveM20 = isAboveM20(latestPrice, latestM20_30min)
      const belowMA5 = isBelowMA5(latestPrice, latestMA5)
      const atKeyLevel = isAtKeyLevel(latestPrice, latestMA10, latestMA20)

      // 计算仓位
      let position = 0
      let positionAmount = 0
      let gamePosition = 0

      // 判断高低位
      const isLowPos = isLowPosition(latestPrice, prices)
      const isHighPos = isHighPosition(latestPrice, prices)

      if (idx.showPosition) {
        // 计算仓位
        position = calculatePosition(latestPrice, prices, aboveM20, belowMA5, idx.category, idx.priceLimit, idx.symbol, latestMA250, fearGreed || 50)
        positionAmount = calculatePositionAmount(position, idx.priceLimit)

        // 计算关键点位博弈仓位
        // 只有使用3020规则的指数才需要博弈仓位，且总持仓不可超过1w
        if (idx.use3020Rule && atKeyLevel && position > 0) {
          gamePosition = Math.min(STRATEGY_PARAMS.MAX_GAME_POSITION - totalGamePosition, positionAmount * 0.5)
          totalGamePosition += gamePosition
        }
        // 红利低波ETF不需要博弈仓位限制
      }

      results.push({
        ...idx,
        prices,
        latestPrice,
        latestMA5,
        latestMA10,
        latestMA20,
        latestMA250,
        latestM20_30min,
        fearGreed,
        aboveM20,
        belowMA5,
        atKeyLevel,
        position,
        positionAmount,
        gamePosition,
        totalPosition: positionAmount + gamePosition
      })

      console.log(chalk.green(`  ✓ ${idx.name} 分析完成`))

    } catch (error) {
      console.log(chalk.red(`  ✗ ${idx.name} 分析失败: ${error.message}`))
      results.push({ ...idx, error: error.message })
    }
  }

  // 生成报告
  generateReport(results, totalGamePosition)

  // 生成HTML报告
  const htmlPath = generateHTML(results, totalGamePosition)
  console.log(`\n  HTML 报告已生成：${htmlPath}`)
  console.log(`  在浏览器中打开查看详细分析。`)
}

if (require.main === module) {
  main().catch(err => {
    console.error(chalk.red('执行失败:', err))
    process.exit(1)
  })
}

module.exports = { main }
