import { INDEXES, fetchIndexMinuteHistory, clearMinuteHistoryCache } from './tencentDataSource.js'
import { normalizeContainment, findFractals, buildStrokes, buildCenters, buildSignals } from './chan.js'
// NotificationService 通过全局变量方式引入（在 HTML 中通过 <script> 标签引入）
const NotificationService = window.NotificationService

const POLL_INTERVAL = 5 * 60 * 1000 // 5 分钟
const DEFAULT_PERIOD = 'm30' // 默认使用 30 分钟周期
const INITIAL_CASH = 1000000 // 初始资金（与 chan-intraday.js 一致）
const PERIOD_CONFIG = {
  m30: { limit: 2000 },
  m60: { limit: 2000 },
  m15: { limit: 3000 },
  m5: { limit: 4000 }
}

let pollTimer = null
let isRunning = false
let stockResults = {}
let currentStock = 'all' // 当前选中的股票
let pendingNotifications = [] // 待发送的通知队列
let lastNotificationState = {} // 上一次的通知状态（用于对比变化）
let lastOperationState = {} // 上一次的操作状态（记录每只股票的最后操作）
let lastTradeCount = {} // 上一次的交易记录数量（用于检测新交易）
let isFirstLoad = false // 是否是首次加载（用于强制发送首次通知）

// 从 localStorage 恢复状态（防止页面刷新后状态丢失）
function loadStateFromStorage () {
  try {
    const saved = localStorage.getItem('chanMultiMonitorState')
    if (saved) {
      const parsed = JSON.parse(saved)
      lastOperationState = parsed.lastOperationState || {}
      lastTradeCount = parsed.lastTradeCount || {}
      console.log('[状态恢复] 从 localStorage 恢复成功')
      console.log('[状态恢复] lastOperationState:', JSON.stringify(lastOperationState))
      console.log('[状态恢复] lastTradeCount:', JSON.stringify(lastTradeCount))
    } else {
      console.log('[状态恢复] localStorage 为空，首次启动')
    }
  } catch (e) {
    console.warn('[状态恢复] 恢复失败:', e)
  }
}

// 保存状态到 localStorage
function saveStateToStorage () {
  try {
    localStorage.setItem('chanMultiMonitorState', JSON.stringify({
      lastOperationState,
      lastTradeCount
    }))
  } catch (e) {
    console.warn('[状态保存] 保存失败:', e)
  }
}

// 格式化数字
const numberFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

function formatNumber (value) {
  if (value === null || !Number.isFinite(value)) {
    return '--'
  }
  return numberFormatter.format(value)
}

// 格式化时长
function formatDuration (minutes) {
  if (minutes === null || minutes === undefined) return '--'
  if (minutes < 60) return `${minutes}分钟`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hours}小时${mins}分钟` : `${hours}小时`
}

// 获取信号类型名称
function getSignalTypeName (signalType) {
  const typeMap = {
    'first_buy': '一买',
    'second_buy': '二买',
    'first_sell': '一卖',
    'second_sell': '二卖',
    'buy': '买入',
    'sell': '卖出',
    'third_buy': '三买',
    'third_sell': '三卖'
  }
  return typeMap[signalType] || signalType
}

// 计算两个时间之间的分钟数（与 chan-intraday.js 一致）
function minutesBetween (startDate, endDate) {
  const start = new Date(`${String(startDate).replace(' ', 'T')}:00+08:00`)
  const end = new Date(`${String(endDate).replace(' ', 'T')}:00+08:00`)
  const diff = end - start
  if (!Number.isFinite(diff)) {
    return null
  }
  return Math.max(0, Math.round(diff / 60000))
}

// 构建交易记录（与 chan-intraday.js 的 buildTradeRecords 完全一致，实现 T+1 过滤）
function buildTradeRecords (signals, rows) {
  let cash = INITIAL_CASH
  let shares = 0
  let holding = false
  let buySignal = null
  let completedTrades = 0
  let winningTrades = 0
  const records = []

  signals.forEach((signal) => {
    if (signal.type === 'buy' && !holding) {
      shares = cash / signal.executePrice
      cash = 0
      holding = true
      buySignal = signal
      records.push({
        ...signal,
        profitPct: null,
        holdingMinutes: null
      })
      return
    }

    if (signal.type === 'sell' && holding) {
      cash = shares * signal.executePrice
      shares = 0
      holding = false
      completedTrades += 1
      if (signal.executePrice > buySignal.executePrice) {
        winningTrades += 1
      }
      records.push({
        ...signal,
        profitPct: (signal.executePrice / buySignal.executePrice - 1) * 100,
        holdingMinutes: minutesBetween(buySignal.executeDate, signal.executeDate)
      })
      buySignal = null
    }
  })

  // 计算最终资产价值
  const latest = rows[rows.length - 1]
  const finalValue = latest ? cash + shares * latest.close : INITIAL_CASH

  return {
    records,
    summary: {
      finalValue,
      profit: finalValue - INITIAL_CASH,
      returnPct: (finalValue / INITIAL_CASH - 1) * 100,
      holding,
      operationCount: records.length,
      winRatePct: completedTrades ? (winningTrades / completedTrades) * 100 : null
    }
  }
}

// 分析单个股票
async function analyzeStock (symbol) {
  try {
    console.log(`正在分析：${symbol} - ${INDEXES[symbol]}`)

    // 获取分钟 K 线数据
    const config = PERIOD_CONFIG[DEFAULT_PERIOD] || PERIOD_CONFIG.m30
    const data = await fetchIndexMinuteHistory(symbol, DEFAULT_PERIOD, config.limit)

    if (!data || data.length === 0) {
      console.warn(`获取 ${symbol} 数据失败`)
      return null
    }

    // 过滤无效数据（与 chan-intraday.js 一致）
    const cleanRows = data.filter(
      (row) =>
        Number.isFinite(row.open) &&
        Number.isFinite(row.close) &&
        Number.isFinite(row.high) &&
        Number.isFinite(row.low)
    )

    console.log(`${symbol} 获取到 ${cleanRows.length} 条有效数据`)

    // 打印最新数据用于调试
    if (cleanRows.length > 0) {
      const latest = cleanRows[cleanRows.length - 1]
      console.log(`${symbol} 最新数据:`, {
        date: latest.date,
        open: latest.open,
        close: latest.close,
        high: latest.high,
        low: latest.low
      })
    }

    // 处理 K 线包含关系
    const normalizedData = normalizeContainment(cleanRows)

    // 查找分型
    const fractals = findFractals(normalizedData)
    console.log(`${symbol} 分型数量：${fractals.length}`)

    // 构建笔（使用 cleanRows 与 chan-intraday.js 一致）
    const strokes = buildStrokes(fractals, cleanRows)
    console.log(`${symbol} 笔数量：${strokes.length}`)

    // 构建中枢
    const centers = buildCenters(strokes)
    console.log(`${symbol} 中枢数量：${centers.length}`)

    // 生成信号（注意参数顺序：strokes, rows, centers）- 使用 cleanRows 与 chan-intraday.js 一致
    const signals = buildSignals(strokes, cleanRows, centers)
    console.log(`${symbol} 信号数量：${signals.length}`)

    // 打印信号详情用于调试
    if (signals.length > 0) {
      console.log(`${symbol} 信号详情:`)
      signals.forEach((sig, idx) => {
        console.log(`  ${idx + 1}. ${sig.signalName} - ${sig.type} - ${sig.executeDate} - ${sig.executePrice}`)
      })
    }

    if (signals.length === 0) {
      console.log(`${symbol} 未生成任何信号，可能原因：笔数量不足或没有形成中枢`)
    }

    // 获取最新数据（使用 cleanRows 与 chan-intraday.js 一致）
    const latest = cleanRows[cleanRows.length - 1]
    const prev = cleanRows[cleanRows.length - 2]

    // 计算涨跌
    let change = null
    let changePercent = null
    if (latest && prev) {
      change = latest.close - prev.close
      changePercent = (change / prev.close) * 100
    }

    // 使用 buildTradeRecords 构建交易记录（与 chan-intraday.js 一致，实现 T+1 过滤）
    const tradeResult = buildTradeRecords(signals, cleanRows)

    // 转换交易记录格式（添加股票名称等）
    const tradeRecords = tradeResult.records.map(sig => {
      const isBuy = sig.type.includes('buy')
      return {
        stockName: INDEXES[symbol],
        symbol: symbol,
        structureDate: sig.structureDate || '-',
        confirmDate: sig.confirmDate || '-',
        executeDate: sig.executeDate || '-',
        type: isBuy ? 'buy' : 'sell',
        action: isBuy ? '买入' : '卖出',
        signalName: sig.signalName || getSignalTypeName(sig.type),
        executePrice: sig.executePrice || latest?.close || null,
        referenceText: sig.referenceText || sig.description || '--',
        profitPct: sig.profitPct !== undefined ? sig.profitPct : null,
        holdingMinutes: sig.holdingMinutes || null
      }
    })

    // 获取最后一次交易记录
    const lastTrade = tradeRecords.length > 0 ? tradeRecords[tradeRecords.length - 1] : null

    // 根据最后一次交易确定当前持仓状态和信号类型
    const holding = tradeResult.summary.holding
    const currentSignal = lastTrade
      ? { type: lastTrade.type, reason: lastTrade.signalName }
      : null
    const signalType = currentSignal
      ? (currentSignal.type === 'buy' ? 'buy' : currentSignal.type === 'sell' ? 'sell' : 'hold')
      : 'hold'

    console.log(`[分析结果] ${INDEXES[symbol]} 信号类型: ${signalType}, 交易记录数: ${tradeRecords.length}`)

    return {
      symbol,
      name: INDEXES[symbol],
      price: latest?.close || null,
      change,
      changePercent,
      signal: {
        type: signalType,
        text: signalType === 'buy' ? '买入' : signalType === 'sell' ? '卖出' : '持有',
        description: lastTrade ? lastTrade.signalName : '暂无信号'
      },
      strokeCount: strokes.length,
      centerCount: centers.length,
      signalCount: signals.length,
      summary: tradeResult.summary,
      lastUpdate: new Date().toLocaleString('zh-CN'),
      tradeRecords
    }
  } catch (error) {
    console.error(`分析 ${symbol} 出错:`, error)
    return null
  }
}

// 更新股票标签
function updateStockTabs (results) {
  const container = document.getElementById('stock-tabs')
  container.innerHTML = ''

  // 添加"全部"标签
  const allTab = document.createElement('button')
  allTab.className = `stock-tab ${currentStock === 'all' ? 'active' : ''}`
  allTab.textContent = '全部'
  allTab.onclick = () => {
    currentStock = 'all'
    updateStockTabs(results)
    renderTradeTable(results)
    updateSummary(results)
  }
  container.appendChild(allTab)

  // 添加每个股票标签
  const symbols = Object.keys(results).sort((a, b) => results[a].name.localeCompare(results[b].name))
  symbols.forEach(symbol => {
    const tab = document.createElement('button')
    tab.className = `stock-tab ${currentStock === symbol ? 'active' : ''}`
    tab.textContent = results[symbol].name
    tab.onclick = () => {
      currentStock = symbol
      updateStockTabs(results)
      renderTradeTable(results)
      updateSummary(results)
    }
    container.appendChild(tab)
  })
}

// 更新汇总数据
function updateSummary (results) {
  const resultsArray = Object.values(results)
  const stockCount = resultsArray.length

  let totalSignals = 0
  let buySignals = 0
  let sellSignals = 0

  resultsArray.forEach(result => {
    totalSignals += result.signalCount
    if (result.signal.type === 'buy') buySignals++
    if (result.signal.type === 'sell') sellSignals++
  })

  document.getElementById('monitor-count').textContent = stockCount
  document.getElementById('total-signals').textContent = totalSignals
  document.getElementById('buy-signals').textContent = buySignals
  document.getElementById('sell-signals').textContent = sellSignals
  document.getElementById('last-update-time').textContent = new Date().toLocaleString('zh-CN')

  // 更新单个股票的统计数据
  updateStockSummary(results)
}

// 更新单个股票的统计数据
function updateStockSummary (results) {
  const summaryPanel = document.getElementById('stock-summary-panel')

  if (currentStock === 'all') {
    // 全部股票时隐藏详细统计
    summaryPanel.style.display = 'none'
    return
  }

  const result = results[currentStock]
  if (!result || !result.summary) {
    summaryPanel.style.display = 'none'
    return
  }

  summaryPanel.style.display = 'grid'
  const summary = result.summary

  // 更新统计数据
  document.getElementById('final-value').textContent = formatNumber(summary.finalValue)

  const profitEl = document.getElementById('total-profit')
  const profit = summary.profit || 0
  profitEl.textContent = formatNumber(profit)
  profitEl.className = profit >= 0 ? 'positive' : 'negative'

  const returnEl = document.getElementById('total-return')
  const returnPct = calculateTotalReturn(result.tradeRecords) || 0
  returnEl.textContent = `${formatNumber(returnPct)}%`
  returnEl.className = returnPct >= 0 ? 'positive' : 'negative'

  document.getElementById('operation-count').textContent = summary.operationCount || 0

  const winRateEl = document.getElementById('win-rate')
  if (summary.winRatePct !== null) {
    winRateEl.textContent = `${formatNumber(summary.winRatePct)}%`
    winRateEl.className = summary.winRatePct >= 50 ? 'positive' : 'negative'
  } else {
    winRateEl.textContent = '--'
    winRateEl.className = ''
  }

  const statusEl = document.getElementById('position-status')
  statusEl.textContent = summary.holding ? '持仓中' : '空仓'
  statusEl.className = summary.holding ? 'positive' : ''
}

// 渲染回测周期信息
function renderBacktestPeriod (results) {
  const timeSpan = document.getElementById('test-time')
  if (!timeSpan) return

  let earliestDate = null
  let latestDate = null

  Object.values(results).forEach(result => {
    if (result.tradeRecords && result.tradeRecords.length > 0) {
      result.tradeRecords.forEach(record => {
        const recordDate = new Date(record.executeDate)
        if (!earliestDate || recordDate < earliestDate) {
          earliestDate = recordDate
        }
        if (!latestDate || recordDate > latestDate) {
          latestDate = recordDate
        }
      })
    }
  })

  if (earliestDate && latestDate) {
    timeSpan.textContent = `${earliestDate.toLocaleDateString('zh-CN')} 到 ${latestDate.toLocaleDateString('zh-CN')}`
  } else {
    timeSpan.textContent = '--'
  }
}

// 计算累计收益率
function calculateTotalReturn (tradeRecords) {
  if (!tradeRecords || tradeRecords.length === 0) {
    return null
  }

  let totalReturn = 0
  tradeRecords.forEach(record => {
    if (record.profitPct !== null) {
      totalReturn += record.profitPct
    }
  })

  return totalReturn
}

// 渲染最后操作汇总表格
function renderLastTradeTable (results) {
  const tableBody = document.getElementById('last-trade-list')
  tableBody.innerHTML = ''

  // 渲染回测周期
  renderBacktestPeriod(results)

  const resultsArray = Object.values(results).filter(r => r)
  resultsArray.sort((a, b) => a.name.localeCompare(b.name))

  resultsArray.forEach((result) => {
    const tr = document.createElement('tr')

    // 获取最后一次交易记录
    const lastTrade = result.tradeRecords && result.tradeRecords.length > 0
      ? result.tradeRecords[result.tradeRecords.length - 1]
      : null

    // 判断持仓状态
    const isHolding = result.summary?.holding || false

    // 计算总收益率
    const totalReturn = calculateTotalReturn(result.tradeRecords)
    const returnClass = totalReturn !== null
      ? (totalReturn >= 0 ? 'positive' : 'negative')
      : ''
    const returnText = totalReturn !== null
      ? `${formatNumber(totalReturn)}%`
      : '--'

    // 使用缠论分析结果中的胜率
    const winRateText = result.summary?.winRatePct !== null
      ? `${formatNumber(result.summary.winRatePct)}%`
      : '--'

    // 操作次数
    const operationCount = result.tradeRecords ? result.tradeRecords.length : 0

    tr.innerHTML = `
      <td><strong>${result.name}</strong></td>
      <td class="${returnClass}">${returnText}</td>
      <td>${winRateText}</td>
      <td>${operationCount}</td>
      <td>${lastTrade ? `<span class="trade-badge ${lastTrade.type === 'buy' ? 'buy' : 'sell'}">${lastTrade.action}</span>` : '--'}</td>
      <td>${lastTrade ? lastTrade.executeDate : '--'}</td>
      <td>${lastTrade ? formatNumber(lastTrade.executePrice) : '--'}</td>
      <td>${lastTrade ? lastTrade.signalName : '--'}</td>
      <td><span class="holding-badge ${isHolding ? 'holding' : 'empty'}">${isHolding ? '持仓中' : '空仓'}</span></td>
    `

    tableBody.appendChild(tr)
  })
}

// 渲染交易记录表格（参照 chan-intraday 的格式）
function renderTradeTable (results) {
  const tableBody = document.getElementById('trade-list')
  const emptyText = document.getElementById('trade-empty')

  // 清空表格
  tableBody.innerHTML = ''

  // 获取当前选中股票的交易记录
  let allRecords = []
  if (currentStock === 'all') {
    // 获取所有股票的交易记录
    Object.values(results).forEach(result => {
      if (result.tradeRecords && result.tradeRecords.length > 0) {
        allRecords = allRecords.concat(result.tradeRecords)
      }
    })
  } else {
    // 获取指定股票的交易记录
    const result = results[currentStock]
    if (result && result.tradeRecords) {
      allRecords = result.tradeRecords
    }
  }

  // 按日期排序
  allRecords.sort((a, b) => new Date(a.executeDate) - new Date(b.executeDate))

  // 显示/隐藏空状态
  emptyText.style.display = allRecords.length > 0 ? 'none' : 'block'

  // 填充表格
  allRecords.forEach((record) => {
    const tr = document.createElement('tr')
    const isBuy = record.type === 'buy'
    const profitClass = record.profitPct === null ? '' : (record.profitPct >= 0 ? 'positive' : 'negative')

    tr.innerHTML = `
      <td><strong>${record.stockName}</strong></td>
      <td>${record.structureDate}</td>
      <td>${record.confirmDate}</td>
      <td>${record.executeDate}</td>
      <td><span class="trade-badge ${isBuy ? 'buy' : 'sell'}">${record.action}</span></td>
      <td>${record.signalName}</td>
      <td>${formatNumber(record.executePrice)}</td>
      <td>${record.referenceText || '--'}</td>
      <td class="${profitClass}">${record.profitPct === null ? '--' : `${formatNumber(record.profitPct)}%`}</td>
      <td>${formatDuration(record.holdingMinutes)}</td>
    `

    tableBody.appendChild(tr)
  })
}

// 添加待发送的通知（检测操作状态变化）
function addPendingNotification (result) {
  // 获取当前交易记录数量
  const currentTradeCount = result.tradeRecords ? result.tradeRecords.length : 0
  // 获取上一次的交易记录数量
  const previousTradeCount = lastTradeCount[result.symbol] || 0

  // 获取最后一次交易记录（用于获取操作时间、操作价等详细信息）
  const lastTrade = result.tradeRecords && currentTradeCount > 0
    ? result.tradeRecords[currentTradeCount - 1]
    : null

  // 判断持仓状态
  const holdingStatus = result.summary?.holding ? '持仓中' : '空仓'
  const lastAction = lastTrade ? lastTrade.action : '-'
  const signalName = lastTrade ? lastTrade.signalName : '-'
  const executeDate = lastTrade ? lastTrade.executeDate : '-'
  const executePrice = lastTrade ? lastTrade.executePrice : null

  // 是否有新交易（交易记录数量增加）
  const hasNewTrade = currentTradeCount > previousTradeCount
  // 是否是首次分析（该股票从未被分析过）
  const isFirstRun = lastTradeCount[result.symbol] === undefined || isFirstLoad

  console.log(`[通知检查] ${result.name}`)
  console.log(`  - 当前交易数: ${currentTradeCount}`)
  console.log(`  - 上一次交易数: ${previousTradeCount}`)
  console.log(`  - 是否首次: ${isFirstRun}`)
  console.log(`  - 是否有新交易: ${hasNewTrade}`)
  console.log(`  - 最后操作: ${lastAction}`)
  console.log(`  - 信号类型: ${signalName}`)
  console.log(`  - 操作时间: ${executeDate}`)
  console.log(`  - 操作价: ${executePrice}`)
  console.log(`  - 持仓状态: ${holdingStatus}`)

  // 获取上一次的操作状态（包含完整的列表数据）
  const previousState = lastOperationState[result.symbol]
  const currentState = {
    signalType: result.signal.type,
    holding: result.summary?.holding,
    lastAction: lastAction,
    signalName: signalName,
    executeDate: executeDate,
    executePrice: executePrice,
    price: result.price
  }
  let stateChanged = false
  let changeDescription = ''

  if (previousState) {
    // 对比信号类型变化
    if (previousState.signalType !== currentState.signalType) {
      stateChanged = true
      changeDescription += `信号类型: ${previousState.signalType} -> ${currentState.signalType}; `
    }

    // 对比持仓状态变化
    if (previousState.holding !== currentState.holding) {
      stateChanged = true
      changeDescription += `持仓状态: ${previousState.holding ? '持仓中' : '空仓'} -> ${currentState.holding ? '持仓中' : '空仓'}; `
    }

    // 对比最后操作变化（买入/卖出变化）
    if (previousState.lastAction !== currentState.lastAction) {
      stateChanged = true
      changeDescription += `最后操作: ${previousState.lastAction} -> ${currentState.lastAction}; `
    }

    // 对比信号名称变化（一买/二买/一卖/二卖等）
    if (previousState.signalName !== currentState.signalName) {
      stateChanged = true
      changeDescription += `信号名称: ${previousState.signalName || '-'} -> ${currentState.signalName || '-'}; `
    }

    // 对比操作时间变化
    if (previousState.executeDate !== currentState.executeDate) {
      stateChanged = true
      changeDescription += `操作时间: ${previousState.executeDate || '-'} -> ${currentState.executeDate || '-'}; `
    }

    // 对比操作价格变化
    if (previousState.executePrice !== currentState.executePrice) {
      stateChanged = true
      changeDescription += `操作价格: ${previousState.executePrice || '-'} -> ${currentState.executePrice || '-'}; `
    }

    console.log(`  - 操作状态变化: ${stateChanged ? '是' : '否'}`)
    if (stateChanged) {
      console.log(`  - 变化详情: ${changeDescription}`)
    }
  } else {
    // 首次记录状态，不算变化
    console.log(`  - 操作状态变化: 否（首次记录）`)
  }

  // 首次启动：发送所有股票的通知（只在首次加载时发送一次）
  if (isFirstRun) {
    console.log(`  ✅ 添加通知：首次启动 - ${result.name}`)

    pendingNotifications.push({
      symbol: result.symbol,
      name: result.name,
      type: result.signal.type,
      currentSignalName: result.signal.text,
      price: result.price,
      changePercent: result.changePercent,
      lastAction: lastAction,
      signalName: signalName,
      holdingStatus: holdingStatus,
      time: result.lastUpdate,
      executeDate: executeDate,
      executePrice: executePrice,
      isFirst: true,
      changeType: '首次启动'
    })
  } else if (hasNewTrade && lastTrade) {
    // 有新交易，发送买入/卖出通知
    console.log(`  ✅ 添加通知：新交易 - ${result.name} - ${lastTrade.action}`)

    // 根据交易类型发送通知
    const tradeType = lastTrade.type // 'buy' 或 'sell'

    pendingNotifications.push({
      symbol: result.symbol,
      name: result.name,
      type: tradeType,
      currentSignalName: tradeType === 'buy' ? '买入' : '卖出',
      price: result.price,
      changePercent: result.changePercent,
      lastAction: lastTrade.action,
      signalName: lastTrade.signalName,
      holdingStatus: holdingStatus,
      time: result.lastUpdate,
      tradeDate: lastTrade.executeDate,
      executePrice: lastTrade.executePrice,
      isFirst: false,
      changeType: tradeType === 'buy' ? '买入信号' : '卖出信号',
      changeDetails: changeDescription
    })
  } else if (stateChanged) {
    // 操作状态发生变化（列表数据变化），发送状态变化通知
    console.log(`  ✅ 添加通知：操作状态变化 - ${result.name}`)

    pendingNotifications.push({
      symbol: result.symbol,
      name: result.name,
      type: result.signal.type,
      currentSignalName: result.signal.text,
      price: result.price,
      changePercent: result.changePercent,
      lastAction: lastAction,
      signalName: signalName,
      holdingStatus: holdingStatus,
      time: result.lastUpdate,
      executeDate: executeDate,
      executePrice: executePrice,
      isFirst: false,
      changeType: '状态变化',
      changeDetails: changeDescription
    })
  } else {
    // 没有新交易，操作状态也没有变化，不发送通知
    console.log(`  ❌ 不发送通知：${result.name}`)
  }

  // 更新上一次的交易记录数量和操作状态（在判断完成后保存）
  lastTradeCount[result.symbol] = currentTradeCount
  lastOperationState[result.symbol] = currentState
}

// 批量发送所有通知（合并到最后一次）
async function sendAllNotifications () {
  console.log('===========================================')
  console.log('[通知发送] 检查待发送队列...')
  console.log('[通知发送] 队列长度:', pendingNotifications.length)
  console.log('[通知发送] 队列内容:', JSON.stringify(pendingNotifications, null, 2))

  if (pendingNotifications.length === 0) {
    console.log('[通知发送] 队列为空，跳过发送')
    console.log('===========================================')
    return
  }

  console.log(`[通知发送] 准备发送 ${pendingNotifications.length} 个通知...`)

  // 检查 NotificationService 是否可用
  if (!NotificationService) {
    console.error('[通知发送] ERROR: NotificationService 未定义，无法发送通知')
    // 清空待发送队列
    pendingNotifications = []
    console.log('===========================================')
    return
  }

  console.log('[通知发送] NotificationService 已就绪')

  // 配置通知服务
  NotificationService.setConfig({
    strategyName: '缠论多股监控',
    wxPusherTokens: ['AT_dMjPttrnlSqU9uKlpW7oxkGzVynM2RkD']
  })
  console.log('[通知发送] 配置已设置')

  // 判断是否是首次启动（所有通知都是首次启动通知）
  const isFirstRun = pendingNotifications.every(notif => notif.isFirst)

  // 根据是否首次启动，显示不同的消息内容
  let message
  if (isFirstRun) {
    // 首次启动通知
    message = `
🚀 **缠论多股监控系统启动成功**
🕐 时间：${new Date().toLocaleString('zh-CN')}
📈 监控股数：${Object.keys(INDEXES).length}

${pendingNotifications.map((notif, index) => `
---
${index + 1}. **${notif.name} (${notif.symbol})**
   ${notif.type === 'buy' ? '🟢' : notif.type === 'sell' ? '🔴' : '⚪'} **当前状态：${notif.currentSignalName}**
   💰 价格：${formatNumber(notif.price)}
   📊 持仓状态：${notif.holdingStatus}
   📅 最后操作：${notif.lastAction === '-' ? '暂无' : notif.lastAction}
`).join('\n')}

✅ 系统已启动，每5分钟自动分析一次
  `.trim()
  } else {
    // 分类通知：新交易信号和状态变化
    const tradeSignals = pendingNotifications.filter(notif => notif.changeType === '买入信号' || notif.changeType === '卖出信号')
    const stateChanges = pendingNotifications.filter(notif => notif.changeType === '状态变化')

    let notificationsText = ''

    // 添加新交易信号
    if (tradeSignals.length > 0) {
      notificationsText += `
📊 **新交易信号**
${tradeSignals.map((notif, index) => `
---
${index + 1}. **${notif.name} (${notif.symbol})**
   ${notif.type === 'buy' ? '🟢' : '🔴'} **${notif.changeType}**
   📅 交易日期：${notif.tradeDate || '-'}
   💰 执行价格：${formatNumber(notif.executePrice)}
   📊 当前价格：${formatNumber(notif.price)}
   📈 信号类型：${notif.signalName || '-'}
   🛒 持仓状态：${notif.holdingStatus}
`).join('\n')}
      `.trim()
    }

    // 添加状态变化通知
    if (stateChanges.length > 0) {
      if (notificationsText) notificationsText += '\n\n'
      notificationsText += `
🔄 **操作状态变化**
${stateChanges.map((notif, index) => `
---
${index + 1}. **${notif.name} (${notif.symbol})**
   ${notif.type === 'buy' ? '🟢' : notif.type === 'sell' ? '🔴' : '⚪'} **${notif.changeType}**
   💰 当前价格：${formatNumber(notif.price)}
   📊 持仓状态：${notif.holdingStatus}
   📈 信号类型：${notif.signalName || '-'}
   📝 变化详情：${notif.changeDetails || '-'}
`).join('\n')}
      `.trim()
    }

    message = `
🔔 **缠论多股监控 - 通知**
🕐 时间：${new Date().toLocaleString('zh-CN')}

${notificationsText}

⚠️ 共 ${pendingNotifications.length} 个通知，请关注
  `.trim()
  }

  console.log('[通知发送] 生成的消息内容:', message)
  console.log('[通知发送] 调用 addNotificationForce...')

  // 添加通知并发送（使用强制发送方法，确保每次变化都能发送）
  NotificationService.addNotificationForce(message, 'multi-stock')

  console.log('[通知发送] 调用 sendAllNotifications...')
  await NotificationService.sendAllNotifications()

  console.log('[通知发送] 通知发送完成')
  console.log('===========================================')

  // 清空待发送队列
  pendingNotifications = []

  // 重置首次加载标志（首次通知已发送）
  isFirstLoad = false
}

// 批量分析所有股票
async function analyzeAllStocks () {
  console.log('========== 开始批量分析所有股票 ==========')
  console.log('当前时间:', new Date().toLocaleString('zh-CN'))
  console.log('上一次状态记录:', JSON.stringify(lastNotificationState))

  // 清除缓存，确保获取最新数据
  clearMinuteHistoryCache()

  const symbols = Object.keys(INDEXES)
  document.getElementById('stock-count').textContent = symbols.length

  // 清空待发送通知队列（保留上一次状态记录）
  pendingNotifications = []

  // 逐个分析股票
  console.log(`[分析开始] 待分析股票列表: ${symbols.join(', ')}`)
  console.log(`[分析开始] 股票总数: ${symbols.length}`)
  
  let successCount = 0
  let failCount = 0
  
  for (const symbol of symbols) {
    console.log(`[分析进度] 正在分析第 ${symbols.indexOf(symbol) + 1}/${symbols.length}: ${symbol} - ${INDEXES[symbol]}`)
    const result = await analyzeStock(symbol)
    if (result) {
      stockResults[symbol] = result
      successCount++
      console.log(`[分析结果] ✅ ${INDEXES[symbol]} 分析成功`)

      // 收集待发送的通知（不立即发送）
      addPendingNotification(result)
    } else {
      failCount++
      console.log(`[分析结果] ❌ ${INDEXES[symbol]} 分析失败`)
    }

    // 每个股票之间稍微延迟，避免请求过快
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  
  console.log(`[分析完成] 成功: ${successCount}, 失败: ${failCount}`)

  // 更新股票标签
  updateStockTabs(stockResults)

  // 渲染交易记录表格
  renderTradeTable(stockResults)

  // 渲染最后操作汇总表格
  renderLastTradeTable(stockResults)

  // 更新汇总数据
  updateSummary(stockResults)

  // 更新时间
  document.getElementById('last-update').textContent = `最后更新：${new Date().toLocaleString('zh-CN')}`

  // 批量发送所有通知（合并到最后一次）
  await sendAllNotifications()

  // 保存状态到 localStorage（防止页面刷新后状态丢失）
  saveStateToStorage()

  console.log('批量分析完成')
}

// 启动监控
function startMonitoring () {
  if (isRunning) return

  isRunning = true
  document.getElementById('status-dot').className = 'status-dot running'
  document.getElementById('status-text').textContent = '监控运行中'

  // 立即执行一次分析
  analyzeAllStocks()

  // 设置定时任务
  pollTimer = setInterval(() => {
    analyzeAllStocks()
  }, POLL_INTERVAL)

  console.log('缠论多股监控系统已启动')
}

// 停止监控
function stopMonitoring () {
  if (!isRunning) return

  isRunning = false
  document.getElementById('status-dot').className = 'status-dot'
  document.getElementById('status-text').textContent = '监控已停止'

  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }

  console.log('缠论多股监控系统已停止')
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
  // 从 localStorage 恢复状态（防止页面刷新后状态丢失）
  loadStateFromStorage()

  // 标记为首次启动（强制发送一次通知）
  isFirstLoad = true

  // 启动监控
  startMonitoring()

  // 刷新按钮事件
  document.getElementById('refresh-btn').addEventListener('click', () => {
    analyzeAllStocks()
  })

  // 页面关闭前停止监控
  window.addEventListener('beforeunload', () => {
    stopMonitoring()
  })
})

// 导出函数供外部使用
export { startMonitoring, stopMonitoring, analyzeAllStocks }