'use strict'

/**
 * 简化版 5 指标恐贪指数（纯上证指数日 K 线数据）
 *
 * 子指标（各等权 20%）：
 *   1. 价格动能    — (Close - MA60) / MA60 的历史百分位
 *                    偏离均线越高 → 越贪婪
 *   2. 历史波动率  — 20日收益率标准差的历史百分位（反向）
 *                    波动率越低 → 越贪婪（市场平静时往往过度乐观）
 *   3. RSI(14)    — RSI 值的历史百分位
 *                    RSI 越高 → 越贪婪
 *   4. 方向成交量  — 量比 × 涨跌方向 的历史百分位
 *                    放量上涨 → 贪婪；放量下跌 → 恐慌
 *   5. 价格位置    — 当前收盘在过去 120 日高低区间的相对位置（直接 0–100）
 *                    靠近 120 日高点 → 贪婪；靠近低点 → 恐慌
 *
 * 评分机制：
 *   每个子指标均映射到 0–100 分（百分位法 or 区间比）
 *   最终恐贪值 = 5 个子指标得分的等权平均
 *
 * 区间标签：
 *   0–20  极度恐慌
 *   20–40 恐慌
 *   40–60 中性
 *   60–80 贪婪
 *   80–100 极度贪婪
 */

// ─── 工具函数 ────────────────────────────────────────────────

function calcSMA (arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null
    let sum = 0
    for (let k = i - period + 1; k <= i; k++) sum += arr[k]
    return sum / period
  })
}

function calcRSI (closes, period = 14) {
  const rsi = new Array(closes.length).fill(null)
  if (closes.length < period + 1) return rsi

  let gainSum = 0, lossSum = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gainSum += diff
    else lossSum += Math.abs(diff)
  }

  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? Math.abs(diff) : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return rsi
}

/**
 * 历史百分位排名：value 在 arr（已过滤 null/NaN）中的百分位（0–100）
 * 使用"不超过 value 的比例"方式，与 CNN 等主流实现一致
 */
function percentileRank (validArr, value) {
  if (validArr.length === 0) return 50
  const below = validArr.filter((v) => v <= value).length
  return (below / validArr.length) * 100
}

// ─── 主函数 ─────────────────────────────────────────────────

function calcFearGreed (data) {
  const closes = data.map((d) => d.close)
  const volumes = data.map((d) => d.volume)
  const dates = data.map((d) => d.date)
  const n = closes.length

  // 日收益率序列（i=0 为 null）
  const returns = closes.map((c, i) =>
    i === 0 ? null : (c - closes[i - 1]) / closes[i - 1],
  )

  // ── 子指标原始序列 ───────────────────────────────────────

  // 指标 1：价格动能 (close - MA60) / MA60
  const ma60 = calcSMA(closes, 60)
  const momentum = closes.map((c, i) =>
    ma60[i] == null ? null : (c - ma60[i]) / ma60[i],
  )

  // 指标 2：20 日历史波动率（收益率标准差）
  const volatility = closes.map((_, i) => {
    if (i < 20) return null
    const slice = returns.slice(i - 19, i + 1).filter((v) => v !== null)
    if (slice.length < 10) return null
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length
    return Math.sqrt(variance)
  })

  // 指标 3：RSI(14)
  const rsi14 = calcRSI(closes, 14)

  // 指标 4：方向成交量 = 量比 × 涨跌方向
  const ma20vol = calcSMA(volumes, 20)
  const volMomentum = volumes.map((v, i) => {
    if (ma20vol[i] == null || i === 0 || returns[i] == null) return null
    const volRatio = v / ma20vol[i]
    const dir = returns[i] >= 0 ? 1 : -1
    return volRatio * dir
  })

  // 指标 5：价格位置——在过去 120 日高低区间的相对位置（直接出 0–100 分）
  const pricePosition = closes.map((c, i) => {
    if (i < 119) return null
    const slice = closes.slice(i - 119, i + 1)
    const hi = Math.max(...slice)
    const lo = Math.min(...slice)
    if (hi === lo) return 50
    const position = ((c - lo) / (hi - lo)) * 100
    return position
  })



  // ── 预提取各指标的全局有效值数组（用于百分位计算）────────
  const valMomentum = momentum.filter((v) => v !== null)
  const valVolatility = volatility.filter((v) => v !== null)
  const valRSI = rsi14.filter((v) => v !== null)
  const valVolMomentum = volMomentum.filter((v) => v !== null)

  // ── 逐日合成恐贪值 ────────────────────────────────────────
  const scores = closes.map((_, i) => {
    if (
      momentum[i] == null ||
      volatility[i] == null ||
      rsi14[i] == null ||
      volMomentum[i] == null ||
      pricePosition[i] == null
    ) return null

    // 检查各指标值是否有效
    if (valMomentum.length === 0 || valVolatility.length === 0 || valRSI.length === 0 || valVolMomentum.length === 0) {
      return null
    }

    const s1 = percentileRank(valMomentum, momentum[i])           // 价格动能
    const s2 = 100 - percentileRank(valVolatility, volatility[i])    // 波动率（反向）
    const s3 = percentileRank(valRSI, rsi14[i])              // RSI
    const s4 = percentileRank(valVolMomentum, volMomentum[i])        // 方向成交量
    const s5 = pricePosition[i]                                       // 价格位置

    return +((s1 + s2 + s3 + s4 + s5) / 5).toFixed(1)
  })

  // ── 最新有效日 ────────────────────────────────────────────
  let latestIdx = -1
  for (let i = n - 1; i >= 0; i--) {
    if (scores[i] !== null) { latestIdx = i; break }
  }

  const latestScore = latestIdx >= 0 ? scores[latestIdx] : null
  const latestDate = latestIdx >= 0 ? dates[latestIdx] : null

  // 最新子指标细节（供控制台报告）
  let latestSubs = null
  if (latestIdx >= 0) {
    latestSubs = {
      s1_momentum: +percentileRank(valMomentum, momentum[latestIdx]).toFixed(1),
      s2_volatility: +(100 - percentileRank(valVolatility, volatility[latestIdx])).toFixed(1),
      s3_rsi: +percentileRank(valRSI, rsi14[latestIdx]).toFixed(1),
      s4_volMomentum: +percentileRank(valVolMomentum, volMomentum[latestIdx]).toFixed(1),
      s5_pricePosition: +pricePosition[latestIdx].toFixed(1),
      // 原始值（便于理解）
      rawMomentumPct: +(momentum[latestIdx] * 100).toFixed(2),
      rawVolatilityPct: +(volatility[latestIdx] * 100).toFixed(3),
      rawRSI: +rsi14[latestIdx].toFixed(1),
      rawVolRatio: +(volumes[latestIdx] / ma20vol[latestIdx]).toFixed(2),
    }
  }

  return {
    scores,       // 每日恐贪值数组（热身期为 null）
    latestScore,
    latestDate,
    latestSubs,
    label: latestScore !== null ? getLabel(latestScore) : '–',
  }
}

function getLabel (score) {
  if (score >= 80) return '极度贪婪 🔥'
  if (score >= 60) return '贪婪'
  if (score >= 40) return '中性'
  if (score >= 20) return '恐慌'
  return '极度恐慌 ❄️'
}

function getLabelColor (score) {
  if (score >= 80) return '#f85149'
  if (score >= 60) return '#f0883e'
  if (score >= 40) return '#e3b341'
  if (score >= 20) return '#79c0ff'
  return '#58a6ff'
}

/**
 * 分时数据恐贪指数计算
 * @param {Array} minuteData 分时数据数组，每个元素包含 time, price, volume, amount
 * @returns {Object} 恐贪指数结果
 */
function calcMinuteFearGreed (minuteData) {
  const prices = minuteData.map((d) => d.price)
  const volumes = minuteData.map((d) => d.volume)
  const times = minuteData.map((d) => d.time)
  const n = prices.length

  // 收益率序列（i=0 为 null）
  const returns = prices.map((p, i) =>
    i === 0 ? null : (p - prices[i - 1]) / prices[i - 1],
  )

  // ── 子指标原始序列 ───────────────────────────────────────

  // 指标 1：价格动能 (price - MA20) / MA20
  const ma20 = calcSMA(prices, 20)
  const momentum = prices.map((p, i) =>
    ma20[i] == null ? null : (p - ma20[i]) / ma20[i],
  )

  // 指标 2：10 分钟历史波动率（收益率标准差）
  const volatility = prices.map((_, i) => {
    if (i < 10) return null
    const slice = returns.slice(i - 9, i + 1).filter((v) => v !== null)
    if (slice.length < 5) return null
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length
    return Math.sqrt(variance)
  })

  // 指标 3：RSI(14) - 适用于分时数据
  const rsi14 = calcRSI(prices, 14)

  // 指标 4：方向成交量 = 量比 × 涨跌方向
  const ma10vol = calcSMA(volumes, 10)
  const volMomentum = volumes.map((v, i) => {
    if (ma10vol[i] == null || i === 0 || returns[i] == null) return null
    const volRatio = v / ma10vol[i]
    const dir = returns[i] >= 0 ? 1 : -1
    return volRatio * dir
  })

  // 指标 5：价格位置——在过去 30 分钟高低区间的相对位置（直接出 0–100 分）
  const pricePosition = prices.map((p, i) => {
    if (i < 29) return null
    const slice = prices.slice(i - 29, i + 1)
    const hi = Math.max(...slice)
    const lo = Math.min(...slice)
    if (hi === lo) return 50
    return ((p - lo) / (hi - lo)) * 100
  })

  // ── 预提取各指标的全局有效值数组（用于百分位计算）────────
  const valMomentum = momentum.filter((v) => v !== null)
  const valVolatility = volatility.filter((v) => v !== null)
  const valRSI = rsi14.filter((v) => v !== null)
  const valVolMomentum = volMomentum.filter((v) => v !== null)

  // ── 逐分钟合成恐贪值 ────────────────────────────────────────
  const scores = prices.map((_, i) => {
    if (
      momentum[i] == null ||
      volatility[i] == null ||
      rsi14[i] == null ||
      volMomentum[i] == null ||
      pricePosition[i] == null
    ) return null

    const s1 = percentileRank(valMomentum, momentum[i])           // 价格动能
    const s2 = 100 - percentileRank(valVolatility, volatility[i])    // 波动率（反向）
    const s3 = percentileRank(valRSI, rsi14[i])              // RSI
    const s4 = percentileRank(valVolMomentum, volMomentum[i])        // 方向成交量
    const s5 = pricePosition[i]                                       // 价格位置

    return +((s1 + s2 + s3 + s4 + s5) / 5).toFixed(1)
  })

  // ── 最新有效分钟 ────────────────────────────────────────────
  let latestIdx = -1
  for (let i = n - 1; i >= 0; i--) {
    if (scores[i] !== null) { latestIdx = i; break }
  }

  const latestScore = latestIdx >= 0 ? scores[latestIdx] : null
  const latestTime = latestIdx >= 0 ? times[latestIdx] : null

  // 最新子指标细节
  let latestSubs = null
  if (latestIdx >= 0) {
    latestSubs = {
      s1_momentum: +percentileRank(valMomentum, momentum[latestIdx]).toFixed(1),
      s2_volatility: +(100 - percentileRank(valVolatility, volatility[latestIdx])).toFixed(1),
      s3_rsi: +percentileRank(valRSI, rsi14[latestIdx]).toFixed(1),
      s4_volMomentum: +percentileRank(valVolMomentum, volMomentum[latestIdx]).toFixed(1),
      s5_pricePosition: +pricePosition[latestIdx].toFixed(1),
    }
  }

  return {
    scores,       // 每分钟恐贪值数组（热身期为 null）
    latestScore,
    latestTime,
    latestSubs,
    label: latestScore !== null ? getLabel(latestScore) : '–',
  }
}

function getLabelColor (score) {
  if (score >= 80) return '#f85149'
  if (score >= 60) return '#f0883e'
  if (score >= 40) return '#e3b341'
  if (score >= 20) return '#79c0ff'
  return '#58a6ff'
}

module.exports = { calcFearGreed, getLabel, getLabelColor, calcMinuteFearGreed }
