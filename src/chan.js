import { INDEXES, fetchIndexHistory } from './tencentDataSource.js'

const DEFAULT_SYMBOL = 'sh000001'
const START_DATE = '2024-01-01'
const INITIAL_CASH = 1000000
const MIN_STROKE_GAP = 4
const MIN_SEGMENT_STROKES = 3
const MACD_WARMUP_BARS = 35
const MAX_CENTER_AREAS = 6

const numberFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

let chartInstance = null
let historyRows = []
let historyPayload = {}
let currentSymbol = DEFAULT_SYMBOL
let currentMeta = { symbol: DEFAULT_SYMBOL, name: INDEXES[DEFAULT_SYMBOL] }
let currentStartDate = START_DATE
let currentEndDate = null
let currentMaxDate = null
let isSwitching = false

function formatNumber (value) {
  if (value === null || !Number.isFinite(value)) {
    return '--'
  }
  return numberFormatter.format(value)
}

function setText (id, value) {
  const element = document.getElementById(id)
  if (element) {
    element.textContent = value
  }
}

function symbolName (symbol = currentSymbol) {
  return INDEXES[symbol] || symbol
}

function round (value, digits = 2) {
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

function daysBetween (startDate, endDate) {
  return Math.round(
    (new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000
  )
}

function findNextRowAfter (rows, date) {
  return rows.find((row) => row.date > date && Number.isFinite(row.open))
}

function buildRowIndexByDate (rows) {
  return new Map(rows.map((row, index) => [row.date, index]))
}

function calculateEma (values, period) {
  const multiplier = 2 / (period + 1)
  const ema = []
  let previous = null

  values.forEach((value) => {
    if (!Number.isFinite(value)) {
      ema.push(previous)
      return
    }

    previous = previous === null ? value : value * multiplier + previous * (1 - multiplier)
    ema.push(previous)
  })

  return ema
}

function calculateMacd (rows) {
  const closes = rows.map((row) => row.close)
  const ema12 = calculateEma(closes, 12)
  const ema26 = calculateEma(closes, 26)
  const dif = ema12.map((value, index) =>
    Number.isFinite(value) && Number.isFinite(ema26[index]) ? value - ema26[index] : null
  )
  const dea = calculateEma(dif, 9)

  return dif.map((value, index) => {
    const signal = dea[index]
    const histogram = Number.isFinite(value) && Number.isFinite(signal) ? 2 * (value - signal) : null
    return {
      dif: value,
      dea: signal,
      histogram
    }
  })
}

function formatCenterRange (center) {
  if (!center) {
    return '--'
  }
  return `${formatNumber(center.low)} - ${formatNumber(center.high)}`
}

function formatCenterPhase (center) {
  if (!center) {
    return '--'
  }
  return center.phaseLabel || '形成中'
}

function detectDirection (previous, current, fallback) {
  if (current.high > previous.high && current.low > previous.low) {
    return 'up'
  }
  if (current.high < previous.high && current.low < previous.low) {
    return 'down'
  }
  return fallback
}

function isContained (previous, current) {
  return (
    (current.high <= previous.high && current.low >= previous.low) ||
    (current.high >= previous.high && current.low <= previous.low)
  )
}

function mergeContained (previous, current, direction) {
  const isDown = direction === 'down'
  return {
    ...previous,
    date: current.date,
    endDate: current.date,
    close: current.close,
    high: isDown ? Math.min(previous.high, current.high) : Math.max(previous.high, current.high),
    low: isDown ? Math.min(previous.low, current.low) : Math.max(previous.low, current.low),
    sourceEndIndex: current.sourceEndIndex
  }
}

function normalizeContainment (rows) {
  const bars = []
  let direction = 'up'

  rows.forEach((row, index) => {
    const current = {
      ...row,
      sourceStartIndex: index,
      sourceEndIndex: index,
      startDate: row.date,
      endDate: row.date
    }

    if (!bars.length) {
      bars.push(current)
      return
    }

    const previous = bars[bars.length - 1]
    if (isContained(previous, current)) {
      bars[bars.length - 1] = mergeContained(previous, current, direction)
      return
    }

    direction = detectDirection(previous, current, direction)
    bars.push(current)
  })

  return bars
}

function findFractals (bars) {
  const fractals = []

  for (let index = 1; index < bars.length - 1; index += 1) {
    const previous = bars[index - 1]
    const current = bars[index]
    const next = bars[index + 1]
    const isTop = current.high > previous.high && current.high > next.high
    const isBottom = current.low < previous.low && current.low < next.low

    if (!isTop && !isBottom) {
      continue
    }

    const type = isTop ? 'top' : 'bottom'
    fractals.push({
      type,
      index,
      date: current.endDate,
      confirmDate: next.endDate,
      price: type === 'top' ? current.high : current.low
    })
  }

  return fractals
}

function isMoreExtreme (current, previous) {
  if (current.type === 'top') {
    return current.price > previous.price
  }
  return current.price < previous.price
}

function buildStrokePoints (fractals) {
  const points = []

  fractals.forEach((fractal) => {
    if (!points.length) {
      points.push(fractal)
      return
    }

    const previous = points[points.length - 1]
    if (fractal.type === previous.type) {
      if (isMoreExtreme(fractal, previous)) {
        points[points.length - 1] = fractal
      }
      return
    }

    if (fractal.index - previous.index >= MIN_STROKE_GAP) {
      points.push(fractal)
    }
  })

  return points
}

function buildStrokes (fractals, rows = null) {
  const points = buildStrokePoints(fractals)
  const strokes = []

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    const direction = start.type === 'bottom' && end.type === 'top' ? 'up' : 'down'
    const startPrice = start.price
    const endPrice = end.price

    strokes.push({
      id: strokes.length + 1,
      direction,
      startDate: start.date,
      endDate: end.date,
      confirmDate: end.confirmDate,
      startIndex: start.index,
      endIndex: end.index,
      startPrice,
      endPrice,
      low: Math.min(startPrice, endPrice),
      high: Math.max(startPrice, endPrice),
      changePct: round((endPrice / startPrice - 1) * 100)
    })
  }

  return rows && rows.length ? enrichStrokesWithStrength(strokes, rows) : strokes
}

function getStrokeRowRange (stroke, rowIndexByDate) {
  const startIndex = rowIndexByDate.get(stroke.startDate)
  const endIndex = rowIndexByDate.get(stroke.endDate)

  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
    return null
  }

  return {
    start: Math.min(startIndex, endIndex),
    end: Math.max(startIndex, endIndex)
  }
}

function calculateStrokeStrength (stroke, rows, macd, rowIndexByDate) {
  const range = getStrokeRowRange(stroke, rowIndexByDate)
  const fallbackAmplitude = Math.abs(stroke.changePct)

  if (!range) {
    return {
      startRowIndex: null,
      endRowIndex: null,
      durationBars: null,
      amplitudePct: fallbackAmplitude,
      slopePct: null,
      macdArea: null,
      alignedMacdArea: null,
      volumeSum: null,
      volumePerBar: null,
      energy: fallbackAmplitude,
      unitEnergy: fallbackAmplitude
    }
  }

  const directionSign = stroke.direction === 'up' ? 1 : -1
  let macdArea = 0
  let alignedMacdArea = 0
  let volumeSum = 0
  let volumeCount = 0

  for (let index = range.start; index <= range.end; index += 1) {
    const histogram = macd[index] && macd[index].histogram
    if (Number.isFinite(histogram)) {
      macdArea += Math.abs(histogram)
      const alignedHistogram = Math.max(directionSign * histogram, 0)
      alignedMacdArea += alignedHistogram
    }

    const volume = rows[index] && rows[index].volume
    if (Number.isFinite(volume)) {
      volumeSum += volume
      volumeCount += 1
    }
  }

  const durationBars = Math.max(1, range.end - range.start + 1)
  const energy = alignedMacdArea || macdArea || fallbackAmplitude
  const unitEnergy = alignedMacdArea / durationBars

  return {
    startRowIndex: range.start,
    endRowIndex: range.end,
    durationBars,
    amplitudePct: fallbackAmplitude,
    slopePct: round(fallbackAmplitude / durationBars, 4),
    macdArea: round(macdArea, 4),
    alignedMacdArea: round(alignedMacdArea, 4),
    volumeSum: volumeCount ? round(volumeSum, 2) : null,
    volumePerBar: volumeCount ? round(volumeSum / volumeCount, 2) : null,
    energy: round(energy, 4),
    unitEnergy
  }
}

function enrichStrokesWithStrength (strokes, rows) {
  if (!rows || !rows.length) {
    return strokes.map((stroke) => ({
      ...stroke,
      strength: {
        amplitudePct: Math.abs(stroke.changePct),
        slopePct: Math.abs(stroke.changePct),
        energy: Math.abs(stroke.changePct),
        unitEnergy: Math.abs(stroke.changePct)
      }
    }))
  }

  const rowIndexByDate = buildRowIndexByDate(rows)
  const macd = calculateMacd(rows)

  return strokes.map((stroke) => ({
    ...stroke,
    strength: calculateStrokeStrength(stroke, rows, macd, rowIndexByDate)
  }))
}

function buildSegmentEndpointPoints (strokes) {
  if (!strokes.length) {
    return []
  }

  const first = strokes[0]
  const points = [
    {
      type: first.direction === 'up' ? 'bottom' : 'top',
      strokeIndex: 0,
      date: first.startDate,
      confirmDate: first.confirmDate,
      price: first.startPrice
    }
  ]

  strokes.forEach((stroke, index) => {
    points.push({
      type: stroke.direction === 'up' ? 'top' : 'bottom',
      strokeIndex: index + 1,
      date: stroke.endDate,
      confirmDate: stroke.confirmDate,
      price: stroke.endPrice
    })
  })

  return points
}

function buildSegmentPoints (strokes) {
  const points = []

  buildSegmentEndpointPoints(strokes).forEach((point) => {
    if (!points.length) {
      points.push(point)
      return
    }

    const previous = points[points.length - 1]
    if (point.type === previous.type) {
      if (isMoreExtreme(point, previous)) {
        points[points.length - 1] = point
      }
      return
    }

    if (point.strokeIndex - previous.strokeIndex >= MIN_SEGMENT_STROKES) {
      points.push(point)
    }
  })

  return points
}

function buildSegments (strokes) {
  const points = buildSegmentPoints(strokes)
  const segments = []

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    const direction = start.type === 'bottom' && end.type === 'top' ? 'up' : 'down'
    const strokeStartIndex = start.strokeIndex
    const strokeEndIndex = Math.max(strokeStartIndex, end.strokeIndex - 1)
    const componentStrokes = strokes.slice(strokeStartIndex, strokeEndIndex + 1)
    const energy = componentStrokes.reduce(
      (sum, stroke) => sum + (stroke.strength && Number.isFinite(stroke.strength.energy) ? stroke.strength.energy : 0),
      0
    )

    segments.push({
      id: segments.length + 1,
      direction,
      startDate: start.date,
      endDate: end.date,
      confirmDate: end.confirmDate,
      startPrice: start.price,
      endPrice: end.price,
      low: Math.min(start.price, end.price),
      high: Math.max(start.price, end.price),
      strokeStartIndex,
      strokeEndIndex,
      strokeCount: componentStrokes.length,
      changePct: round((end.price / start.price - 1) * 100),
      strength: {
        energy: round(energy, 4),
        energyPerStroke: componentStrokes.length ? round(energy / componentStrokes.length, 4) : null
      }
    })
  }

  return segments
}

function calculateCenterOverlap (group) {
  const low = Math.max(...group.map((stroke) => stroke.low))
  const high = Math.min(...group.map((stroke) => stroke.high))

  if (low >= high) {
    return null
  }

  return {
    low,
    high
  }
}

function centerWidthPct (center) {
  const middle = (center.low + center.high) / 2
  return middle ? round(((center.high - center.low) / middle) * 100, 2) : null
}

function createCenterSeed (strokes, endIndex, id) {
  if (endIndex < 2) {
    return null
  }

  const group = [strokes[endIndex - 2], strokes[endIndex - 1], strokes[endIndex]]
  const overlap = calculateCenterOverlap(group)

  if (!overlap) {
    return null
  }

  const center = {
    id,
    startDate: group[0].startDate,
    endDate: group[2].endDate,
    strokeStartIndex: endIndex - 2,
    seedStrokeEndIndex: endIndex,
    strokeEndIndex: endIndex,
    low: round(overlap.low),
    high: round(overlap.high),
    seedLow: round(overlap.low),
    seedHigh: round(overlap.high),
    status: 'forming',
    phaseLabel: '形成中',
    strokeCount: 3,
    breakoutDate: null,
    breakoutPrice: null,
    breakoutPct: null
  }

  return {
    ...center,
    widthPct: centerWidthPct(center)
  }
}

function strokeOverlapsCenter (stroke, center) {
  return stroke.high > center.low && stroke.low < center.high
}

function extendCenter (center, stroke, strokeIndex) {
  const narrowedLow = Math.max(center.low, stroke.low)
  const narrowedHigh = Math.min(center.high, stroke.high)
  const next = {
    ...center,
    endDate: stroke.endDate,
    strokeEndIndex: strokeIndex,
    strokeCount: center.strokeCount + 1,
    status: 'extended',
    phaseLabel: '延伸中'
  }

  if (narrowedLow < narrowedHigh) {
    next.low = round(narrowedLow)
    next.high = round(narrowedHigh)
  }

  return {
    ...next,
    widthPct: centerWidthPct(next)
  }
}

function closeCenter (center, stroke, strokeIndex) {
  const leaveDirection = stroke.low >= center.high ? 'up' : stroke.high <= center.low ? 'down' : stroke.direction
  const referencePrice = leaveDirection === 'up' ? center.high : center.low
  const breakoutPct = referencePrice ? (stroke.endPrice / referencePrice - 1) * 100 : null

  return {
    ...center,
    status: leaveDirection === 'up' ? 'left-up' : 'left-down',
    phaseLabel: leaveDirection === 'up' ? '向上离开' : '向下离开',
    breakoutDate: stroke.endDate,
    breakoutPrice: stroke.endPrice,
    breakoutStrokeIndex: strokeIndex,
    breakoutPct: Number.isFinite(breakoutPct) ? round(breakoutPct, 2) : null
  }
}

function buildCenters (strokes) {
  const centers = []
  let currentCenter = null

  for (let index = 2; index < strokes.length; index += 1) {
    if (!currentCenter) {
      currentCenter = createCenterSeed(strokes, index, centers.length + 1)
      continue
    }

    if (index <= currentCenter.strokeEndIndex) {
      continue
    }

    const stroke = strokes[index]
    if (strokeOverlapsCenter(stroke, currentCenter)) {
      currentCenter = extendCenter(currentCenter, stroke, index)
      continue
    }

    centers.push(closeCenter(currentCenter, stroke, index))
    currentCenter = createCenterSeed(strokes, index, centers.length + 1)
  }

  if (currentCenter) {
    centers.push(currentCenter)
  }

  return centers
}

function findLatestCenterForStroke (stroke, centers) {
  if (!stroke || !centers || !centers.length) {
    return null
  }

  const strokeIndex = stroke.id - 1
  return [...centers]
    .reverse()
    .find((center) => center.strokeStartIndex <= strokeIndex && center.seedStrokeEndIndex <= strokeIndex)
}

function centerSignalFields (center) {
  return {
    centerId: center ? center.id : null,
    centerLow: center ? center.low : null,
    centerHigh: center ? center.high : null,
    centerStatus: center ? center.status : null
  }
}

function formatSignalReference (parts) {
  return parts.filter(Boolean).join(' / ')
}

function createSecondSellSignal (firstUpStroke, reboundStroke, rows, centers = []) {
  const executeRow = findNextRowAfter(rows, reboundStroke.confirmDate)
  if (!executeRow) {
    return null
  }

  const center = findLatestCenterForStroke(reboundStroke, centers)

  return {
    type: 'sell',
    action: '卖出',
    signalName: '二卖',
    structureDate: reboundStroke.endDate,
    confirmDate: reboundStroke.confirmDate,
    executeDate: executeRow.date,
    executePrice: executeRow.open || executeRow.close,
    structurePrice: reboundStroke.endPrice,
    ...centerSignalFields(center),
    referenceText: formatSignalReference([
      `前高 ${formatNumber(firstUpStroke.endPrice)}`,
      center ? `中枢 ${center.id} ${formatCenterRange(center)}` : null
    ]),
    description: center ? `回落后的反抽不破前高，${formatCenterPhase(center)}` : '回落后的反抽不破前高'
  }
}

function createSecondBuySignal (firstDownStroke, pullbackStroke, rows, centers = []) {
  const executeRow = findNextRowAfter(rows, pullbackStroke.confirmDate)
  if (!executeRow) {
    return null
  }

  const center = findLatestCenterForStroke(pullbackStroke, centers)

  return {
    type: 'buy',
    action: '买入',
    signalName: '二买',
    structureDate: pullbackStroke.endDate,
    confirmDate: pullbackStroke.confirmDate,
    executeDate: executeRow.date,
    executePrice: executeRow.open || executeRow.close,
    structurePrice: pullbackStroke.endPrice,
    ...centerSignalFields(center),
    referenceText: formatSignalReference([
      `前低 ${formatNumber(firstDownStroke.endPrice)}`,
      center ? `中枢 ${center.id} ${formatCenterRange(center)}` : null
    ]),
    description: center ? `反弹后的回踩不破前低，${formatCenterPhase(center)}` : '反弹后的回踩不破前低'
  }
}

function buildSecondBuySignals (strokes, rows, centers = []) {
  const signals = []

  for (let index = 2; index < strokes.length; index += 1) {
    const firstDownStroke = strokes[index - 2]
    const reboundStroke = strokes[index - 1]
    const pullbackStroke = strokes[index]
    const isPullbackPattern =
      firstDownStroke.direction === 'down' &&
      reboundStroke.direction === 'up' &&
      pullbackStroke.direction === 'down'

    if (!isPullbackPattern) {
      continue
    }

    if (pullbackStroke.endPrice > firstDownStroke.endPrice) {
      const signal = createSecondBuySignal(firstDownStroke, pullbackStroke, rows, centers)
      if (signal) {
        signals.push(signal)
      }
    }
  }

  return signals
}

function buildSecondSellSignals (strokes, rows, centers = []) {
  const signals = []

  for (let index = 2; index < strokes.length; index += 1) {
    const firstUpStroke = strokes[index - 2]
    const pullbackStroke = strokes[index - 1]
    const reboundStroke = strokes[index]
    const isReboundPattern =
      firstUpStroke.direction === 'up' &&
      pullbackStroke.direction === 'down' &&
      reboundStroke.direction === 'up'

    if (!isReboundPattern) {
      continue
    }

    if (reboundStroke.endPrice < firstUpStroke.endPrice) {
      const signal = createSecondSellSignal(firstUpStroke, reboundStroke, rows, centers)
      if (signal) {
        signals.push(signal)
      }
    }
  }

  return signals
}

function getStrokeUnitEnergy (stroke) {
  const strength = stroke && stroke.strength
  if (strength && Number.isFinite(strength.unitEnergy)) {
    return strength.unitEnergy
  }
  if (strength && Number.isFinite(strength.alignedMacdArea) && Number.isFinite(strength.durationBars)) {
    return strength.alignedMacdArea / Math.max(1, strength.durationBars)
  }
  if (strength && Number.isFinite(strength.slopePct)) {
    return strength.slopePct
  }
  return stroke ? Math.abs(stroke.changePct) : null
}

function getDivergenceMatch (currentStroke, previousStroke) {
  if (!currentStroke || !previousStroke || currentStroke.direction !== previousStroke.direction) {
    return null
  }

  const strength = currentStroke.strength
  if (strength && Number.isInteger(strength.endRowIndex) && strength.endRowIndex < MACD_WARMUP_BARS) {
    return null
  }

  const currentEnergy = getStrokeUnitEnergy(currentStroke)
  const previousEnergy = getStrokeUnitEnergy(previousStroke)
  if (!Number.isFinite(currentEnergy) || !Number.isFinite(previousEnergy) || previousEnergy <= 0) {
    return null
  }

  const isUp = currentStroke.direction === 'up'
  const priceBreaks = isUp
    ? currentStroke.endPrice > previousStroke.endPrice
    : currentStroke.endPrice < previousStroke.endPrice
  const strengthRatio = currentEnergy / previousEnergy
  const strengthWeakens = currentEnergy < previousEnergy

  if (!priceBreaks || !strengthWeakens) {
    return null
  }

  return {
    isUp,
    strengthRatio,
    currentEnergy,
    previousEnergy
  }
}

function isFirstBuySellCenter (center, currentStroke) {
  if (!center) {
    return false
  }

  const expectedStatus = currentStroke.direction === 'up' ? 'left-up' : 'left-down'
  if (center.status !== expectedStatus) {
    return false
  }

  const strokeIndex = currentStroke.id - 1
  if (!Number.isInteger(center.breakoutStrokeIndex)) {
    return false
  }

  return strokeIndex >= center.breakoutStrokeIndex && strokeIndex - center.breakoutStrokeIndex <= 2
}

function findFirstBuySellCenter (currentStroke, centers) {
  if (!currentStroke || !centers || !centers.length) {
    return null
  }

  return [...centers]
    .reverse()
    .find((center) => isFirstBuySellCenter(center, currentStroke)) || null
}

function createDivergenceSignal (currentStroke, previousStroke, rows, centers, match) {
  const executeRow = findNextRowAfter(rows, currentStroke.confirmDate)
  if (!executeRow || !match) {
    return null
  }

  const isUp = match.isUp
  const center = findLatestCenterForStroke(currentStroke, centers)

  return {
    type: isUp ? 'sell' : 'buy',
    action: isUp ? '卖出' : '买入',
    signalName: isUp ? '顶背驰' : '底背驰',
    structureDate: currentStroke.endDate,
    confirmDate: currentStroke.confirmDate,
    executeDate: executeRow.date,
    executePrice: executeRow.open || executeRow.close,
    structurePrice: currentStroke.endPrice,
    ...centerSignalFields(center),
    referenceText: formatSignalReference([
      `单位力度 ${formatNumber(match.strengthRatio * 100)}%`,
      isUp ? `前高 ${formatNumber(previousStroke.endPrice)}` : `前低 ${formatNumber(previousStroke.endPrice)}`,
      center ? `中枢 ${center.id} ${formatCenterRange(center)}` : null
    ]),
    description: isUp ? '价格创新高但 MACD 单位力度转弱' : '价格创新低但 MACD 单位力度转弱',
    strengthRatio: round(match.strengthRatio * 100, 2)
  }
}

function createFirstBuySellSignal (currentStroke, previousStroke, rows, centers, match) {
  const executeRow = findNextRowAfter(rows, currentStroke.confirmDate)
  if (!executeRow || !match) {
    return null
  }

  const center = findFirstBuySellCenter(currentStroke, centers)
  if (!center) {
    return null
  }

  const isUp = currentStroke.direction === 'up'

  return {
    type: isUp ? 'sell' : 'buy',
    action: isUp ? '卖出' : '买入',
    signalName: isUp ? '一卖' : '一买',
    structureDate: currentStroke.endDate,
    confirmDate: currentStroke.confirmDate,
    executeDate: executeRow.date,
    executePrice: executeRow.open || executeRow.close,
    structurePrice: currentStroke.endPrice,
    ...centerSignalFields(center),
    referenceText: formatSignalReference([
      `中枢 ${center.id} ${formatCenterRange(center)}`,
      `单位力度 ${formatNumber(match.strengthRatio * 100)}%`,
      isUp ? `前高 ${formatNumber(previousStroke.endPrice)}` : `前低 ${formatNumber(previousStroke.endPrice)}`
    ]),
    description: isUp
      ? '中枢向上离开后创新高，但 MACD 单位力度转弱'
      : '中枢向下离开后创新低，但 MACD 单位力度转弱',
    strengthRatio: round(match.strengthRatio * 100, 2)
  }
}

function buildFirstBuySellSignals (strokes, rows, centers = []) {
  const signals = []

  for (let index = 2; index < strokes.length; index += 1) {
    const currentStroke = strokes[index]
    const previousSameDirectionStroke = strokes[index - 2]
    const match = getDivergenceMatch(currentStroke, previousSameDirectionStroke)

    if (!match) {
      continue
    }

    const signal = createFirstBuySellSignal(currentStroke, previousSameDirectionStroke, rows, centers, match)
    if (signal) {
      signals.push(signal)
    }
  }

  return signals
}

function isFirstBuySellSignal (signal) {
  return signal.signalName === '一买' || signal.signalName === '一卖'
}

function signalStructureKey (signal) {
  return `${signal.structureDate}-${signal.executeDate}`
}

function buildDivergenceSignals (strokes, rows, centers = [], coveredStructureKeys = new Set()) {
  const signals = []

  for (let index = 2; index < strokes.length; index += 1) {
    const currentStroke = strokes[index]
    const previousSameDirectionStroke = strokes[index - 2]
    const match = getDivergenceMatch(currentStroke, previousSameDirectionStroke)

    if (!match) {
      continue
    }

    const signal = createDivergenceSignal(currentStroke, previousSameDirectionStroke, rows, centers, match)
    if (signal && coveredStructureKeys.has(signalStructureKey(signal))) {
      continue
    }
    if (signal) {
      signals.push(signal)
    }
  }

  return signals
}

function signalPriority (signal) {
  const priorities = {
    '一买': 1,
    '一卖': 1,
    '二买': 2,
    '二卖': 2,
    '底背驰': 3,
    '顶背驰': 3
  }

  return priorities[signal.signalName] || 9
}

function buildSignals (strokes, rows, centers = []) {
  const seen = new Set()
  const firstSignals = buildFirstBuySellSignals(strokes, rows, centers)
  const firstSignalStructureKeys = new Set(firstSignals.filter(isFirstBuySellSignal).map(signalStructureKey))

  return firstSignals
    .concat(
      buildSecondBuySignals(strokes, rows, centers),
      buildSecondSellSignals(strokes, rows, centers),
      buildDivergenceSignals(strokes, rows, centers, firstSignalStructureKeys)
    )
    .filter((signal) => {
      const key = `${signal.signalName}-${signal.structureDate}-${signal.executeDate}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
    .sort((a, b) => a.executeDate.localeCompare(b.executeDate) || signalPriority(a) - signalPriority(b))
}

function getRangeRows () {
  return historyRows.filter((row) => {
    const afterStart = !currentStartDate || row.date >= currentStartDate
    const beforeEnd = !currentEndDate || row.date <= currentEndDate
    return afterStart && beforeEnd
  })
}

function getRangeData () {
  const rows = getRangeRows()
  const bars = normalizeContainment(rows)
  const fractals = findFractals(bars)
  const strokes = buildStrokes(fractals, rows)
  const segments = buildSegments(strokes)
  const centers = buildCenters(strokes)
  const signals = buildSignals(strokes, rows, centers)
  const tradeResult = buildTradeRecords(signals, rows)

  return {
    rows,
    bars,
    fractals,
    strokes,
    segments,
    centers,
    signals,
    tradeResult,
    meta: currentMeta
  }
}

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
        holdingDays: null
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
        holdingDays: daysBetween(buySignal.executeDate, signal.executeDate)
      })
      buySignal = null
    }
  })

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

function renderBacktestSummary (summary) {
  const profitClass = summary.profit >= 0 ? 'positive' : 'negative'

  setText('initial-cash', formatNumber(INITIAL_CASH))
  setText('final-value', formatNumber(summary.finalValue))
  setText('total-profit', formatNumber(summary.profit))
  setText('total-return', `${formatNumber(summary.returnPct)}%`)
  setText('operation-count', `${summary.operationCount} 次`)
  setText('win-rate', summary.winRatePct === null ? '--' : `${formatNumber(summary.winRatePct)}%`)
  setText('position-status', summary.holding ? '持仓中' : '空仓')

  document.getElementById('total-profit').className = profitClass
  document.getElementById('total-return').className = profitClass
}

function renderTradeTable (records) {
  const tableBody = document.getElementById('trade-list')
  const emptyText = document.getElementById('trade-empty')
  tableBody.innerHTML = ''
  emptyText.hidden = records.length > 0

  records.forEach((record) => {
    const tr = document.createElement('tr')
    const isBuy = record.type === 'buy'
    const profitClass =
      record.profitPct === null ? '' : record.profitPct >= 0 ? 'positive' : 'negative'

    tr.innerHTML = `
      <td>${record.structureDate}</td>
      <td>${record.confirmDate}</td>
      <td>${record.executeDate}</td>
      <td><span class="trade-badge ${isBuy ? 'buy' : 'sell'}">${record.action}</span></td>
      <td>${record.signalName}</td>
      <td>${formatNumber(record.executePrice)}</td>
      <td>${record.referenceText || '--'}</td>
      <td class="${profitClass}">${record.profitPct === null ? '--' : `${formatNumber(record.profitPct)}%`}</td>
      <td>${record.holdingDays === null ? '--' : `${record.holdingDays} 天`}</td>
    `
    tableBody.appendChild(tr)
  })
}

function centerForStroke (stroke, centers) {
  return [...centers]
    .reverse()
    .find((center) => stroke.id - 1 >= center.strokeStartIndex && stroke.id - 1 <= center.strokeEndIndex)
}

function renderStrokeTable (strokes, centers) {
  const tableBody = document.getElementById('stroke-list')
  tableBody.innerHTML = ''

  strokes.slice(-16).forEach((stroke) => {
    const tr = document.createElement('tr')
    const isUp = stroke.direction === 'up'
    const center = centerForStroke(stroke, centers)
    tr.innerHTML = `
      <td><span class="trade-badge ${isUp ? 'buy' : 'sell'}">${isUp ? '上行' : '下行'}</span></td>
      <td>${stroke.startDate}</td>
      <td>${stroke.endDate}</td>
      <td>${formatNumber(stroke.startPrice)}</td>
      <td>${formatNumber(stroke.endPrice)}</td>
      <td class="${stroke.changePct >= 0 ? 'positive' : 'negative'}">${formatNumber(stroke.changePct)}%</td>
      <td>${center ? `中枢 ${center.id} ${formatCenterPhase(center)}` : '--'}</td>
    `
    tableBody.appendChild(tr)
  })
}

function renderSymbolSwitcher () {
  const switcher = document.getElementById('chan-symbol-switcher')
  if (!switcher) {
    return
  }

  switcher.innerHTML = ''
  Object.entries(INDEXES).forEach(([symbol, name]) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `index-pill${symbol === currentSymbol ? ' active' : ''}`
    button.dataset.symbol = symbol
    button.innerHTML = `
      <strong>${name}</strong>
      <span>${symbol}</span>
    `
    button.addEventListener('click', () => showSymbol(symbol))
    switcher.appendChild(button)
  })
}

function updateActiveSymbol (symbol) {
  document.querySelectorAll('#chan-symbol-switcher .index-pill').forEach((button) => {
    button.classList.toggle('active', button.dataset.symbol === symbol)
  })
}

function buildStrokeLineData (strokes) {
  if (!strokes.length) {
    return []
  }

  const first = strokes[0]
  return [[first.startDate, first.startPrice]].concat(
    strokes.map((stroke) => [stroke.endDate, stroke.endPrice])
  )
}

function buildSegmentLineData (segments) {
  if (!segments.length) {
    return []
  }

  const first = segments[0]
  return [[first.startDate, first.startPrice]].concat(
    segments.map((segment) => [segment.endDate, segment.endPrice])
  )
}

function buildCenterAreas (centers) {
  return centers.slice(-MAX_CENTER_AREAS).map((center) => [
    {
      name: `中枢 ${center.id} ${formatCenterPhase(center)}`,
      xAxis: center.startDate,
      yAxis: center.low
    },
    {
      xAxis: center.endDate,
      yAxis: center.high
    }
  ])
}

function buildSignalScatter (signals, signalName) {
  return signals
    .filter((signal) => signal.signalName === signalName)
    .map((signal) => ({
      name: signal.signalName,
      value: [signal.executeDate, signal.executePrice],
      signal
    }))
}

function buildOption (data) {
  const { rows, strokes, segments, centers, signals, meta } = data
  const name = meta.name
  const dates = rows.map((row) => row.date)
  const candles = rows.map((row) => [row.open, row.close, row.low, row.high])
  const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#687789'
  const priceColor = getComputedStyle(document.documentElement).getPropertyValue('--price').trim() || '#2563eb'
  const splitColor = 'rgba(104, 119, 137, 0.16)'

  return {
    animation: true,
    backgroundColor: 'transparent',
    grid: { left: 70, right: 70, top: 54, bottom: 78 },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        label: { backgroundColor: '#3d4854' }
      },
      backgroundColor: 'rgba(30, 35, 41, 0.92)',
      borderWidth: 0,
      textStyle: { color: '#fdf8f1' },
      formatter (params) {
        const items = Array.isArray(params) ? params : [params]
        const axisDate = items[0] && (items[0].axisValue || (items[0].value && items[0].value[0]))
        const row = rows.find((item) => item.date === axisDate)
        if (!row) {
          return ''
        }
        const daySignals = signals.filter((signal) => signal.executeDate === row.date)
        return [
          `<div style="margin-bottom:6px;font-weight:600;">${row.date}</div>`,
          `${name} 开: ${formatNumber(row.open)} 高: ${formatNumber(row.high)}`,
          `低: ${formatNumber(row.low)} 收: ${formatNumber(row.close)}`,
          daySignals.length
            ? `<div style="margin-top:6px;color:#ffd7a8;">信号: ${daySignals
              .map((signal) => `${signal.signalName} ${signal.action}`)
              .join(' / ')}</div>`
            : ''
        ]
          .filter(Boolean)
          .join('<br>')
      }
    },
    toolbox: {
      right: 18,
      top: 10,
      feature: {
        dataZoom: { yAxisIndex: 'none' },
        restore: {},
        saveAsImage: { name: `${meta.symbol}-chan-day-${currentStartDate || START_DATE}` }
      },
      iconStyle: { borderColor: mutedColor }
    },
    legend: {
      top: 12,
      left: 22,
      textStyle: { color: mutedColor },
      data: [name, '笔', '线段', '一买', '一卖', '二买', '二卖', '底背驰', '顶背驰']
    },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: true,
      axisLine: { lineStyle: { color: splitColor } },
      axisLabel: { color: mutedColor, hideOverlap: true },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: {
        color: mutedColor,
        formatter (value) {
          return value.toFixed(0)
        }
      },
      splitLine: { lineStyle: { color: splitColor, type: 'dashed' } }
    },
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      {
        type: 'slider',
        height: 24,
        bottom: 18,
        borderColor: 'rgba(104, 119, 137, 0.24)',
        backgroundColor: '#f8fafc',
        fillerColor: 'rgba(37, 99, 235, 0.14)',
        handleStyle: { color: priceColor }
      }
    ],
    series: [
      {
        name,
        type: 'candlestick',
        data: candles,
        itemStyle: {
          color: '#dc2626',
          color0: '#059669',
          borderColor: '#dc2626',
          borderColor0: '#059669'
        },
        markArea: {
          silent: true,
          label: {
            color: mutedColor,
            fontSize: 11
          },
          itemStyle: {
            color: 'rgba(217, 119, 6, 0.11)',
            borderColor: 'rgba(217, 119, 6, 0.28)',
            borderWidth: 1
          },
          data: buildCenterAreas(centers)
        }
      },
      {
        name: '笔',
        type: 'line',
        data: buildStrokeLineData(strokes),
        showSymbol: true,
        symbolSize: 6,
        smooth: false,
        lineStyle: { width: 2, color: '#0d9488' },
        itemStyle: { color: '#0d9488' }
      },
      {
        name: '线段',
        type: 'line',
        data: buildSegmentLineData(segments),
        showSymbol: true,
        symbolSize: 7,
        smooth: false,
        lineStyle: { width: 3, color: '#7c3aed' },
        itemStyle: { color: '#7c3aed' },
        z: 4
      },
      {
        name: '一买',
        type: 'scatter',
        data: buildSignalScatter(signals, '一买'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#16a34a',
          borderColor: '#dcfce7',
          borderWidth: 2
        }
      },
      {
        name: '一卖',
        type: 'scatter',
        data: buildSignalScatter(signals, '一卖'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#b91c1c',
          borderColor: '#fee2e2',
          borderWidth: 2
        }
      },
      {
        name: '二买',
        type: 'scatter',
        data: buildSignalScatter(signals, '二买'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#0d9488',
          borderColor: '#d9fffb',
          borderWidth: 2
        }
      },
      {
        name: '二卖',
        type: 'scatter',
        data: buildSignalScatter(signals, '二卖'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#dc2626',
          borderColor: '#ffe2dc',
          borderWidth: 2
        }
      },
      {
        name: '底背驰',
        type: 'scatter',
        data: buildSignalScatter(signals, '底背驰'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#2563eb',
          borderColor: '#dbeafe',
          borderWidth: 2
        }
      },
      {
        name: '顶背驰',
        type: 'scatter',
        data: buildSignalScatter(signals, '顶背驰'),
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: '#f97316',
          borderColor: '#ffedd5',
          borderWidth: 2
        }
      }
    ]
  }
}

function renderChart (data) {
  const chartDom = document.getElementById('chart')
  if (!chartInstance) {
    chartInstance = echarts.init(chartDom, null, { renderer: 'canvas' })
    window.addEventListener('resize', () => chartInstance && chartInstance.resize())
  }

  chartInstance.setOption(buildOption(data), true)
}

function renderPageText (meta) {
  const name = meta.name
  setText('page-title', `${name}日K缠论`)
  setText('badge-symbol', `Tencent 数据源 / ${name} / 日K缠论`)
  setText('chan-symbol-chip', name)
  setText('chart-heading', `${name}日K缠论结构`)
  setText('legend-price', `${name}日K`)

  const chartDom = document.getElementById('chart')
  if (chartDom) {
    chartDom.setAttribute('aria-label', `${name}日 K 缠论结构图表`)
  }

  document.title = `${name}日K缠论`
}

function renderSummary (data) {
  const { rows, fractals, strokes, segments, centers, signals, tradeResult } = data
  const latest = rows[rows.length - 1]
  const latestStroke = strokes[strokes.length - 1]
  const latestSegment = segments[segments.length - 1]
  const latestCenter = centers[centers.length - 1]
  const latestSignal = signals[signals.length - 1]
  const firstSignalCount = signals.filter((signal) => signal.signalName === '一买' || signal.signalName === '一卖').length
  const divergenceCount = signals.filter((signal) => signal.signalName.includes('背驰')).length
  const accent = tradeResult.summary.holding ? '#059669' : latestSignal && latestSignal.type === 'sell' ? '#dc2626' : '#2563eb'

  setText('latest-close', formatNumber(latest.close))
  setText('latest-date', latest.date)
  setText('range-label', `${rows[0].date} 到 ${latest.date}`)
  setText('chan-signal', tradeResult.summary.holding ? '持仓中' : '空仓等待')
  setText(
    'chan-zone',
    latestSignal
      ? `最近信号：${latestSignal.executeDate} ${latestSignal.signalName}`
      : '等待二买或二卖'
  )

  document.documentElement.style.setProperty('--score-accent', accent)
  document.documentElement.style.setProperty('--score-progress', tradeResult.summary.holding ? '72%' : '38%')
  document.getElementById('chan-zone').style.color = accent

  setText('latest-stroke', latestStroke ? (latestStroke.direction === 'up' ? '上行笔' : '下行笔') : '--')
  setText(
    'latest-stroke-meta',
    latestStroke
      ? `${latestStroke.startDate} 到 ${latestStroke.endDate}，${formatNumber(latestStroke.changePct)}%；线段 ${latestSegment ? latestSegment.id : '--'}`
      : '暂无有效笔'
  )
  setText('latest-center', latestCenter ? `${formatCenterRange(latestCenter)}` : '--')
  setText(
    'latest-center-meta',
    latestCenter ? `${latestCenter.startDate} 到 ${latestCenter.endDate}，${formatCenterPhase(latestCenter)}` : '暂无有效中枢'
  )
  setText('structure-count', `${strokes.length} 笔 / ${segments.length} 线段 / ${centers.length} 中枢`)
  setText(
    'structure-meta',
    `分型 ${fractals.length} 个，一买/一卖 ${firstSignalCount} 个，背驰 ${divergenceCount} 个，包含处理后 ${data.bars.length} 根 K`
  )
  setText('latest-trade-signal', latestSignal ? latestSignal.signalName : '--')
  setText(
    'latest-trade-meta',
    latestSignal ? `${latestSignal.executeDate} ${latestSignal.description}` : '还没有可执行信号'
  )
}

function render (data) {
  const errorBox = document.getElementById('error')
  renderPageText(data.meta)

  if (!data.rows.length) {
    errorBox.hidden = false
    errorBox.textContent = '当前标的 / 日期范围没有可用日 K 数据。'
    return
  }

  errorBox.hidden = true
  setText(
    'chart-subtitle',
    '一买/一卖要求中枢离开后的背驰；二买/二卖看回踩/反抽不破；背驰用同向笔价格创新与 MACD 单位力度转弱判断。'
  )
  renderSummary(data)
  renderBacktestSummary(data.tradeResult.summary)
  renderTradeTable(data.tradeResult.records)
  renderStrokeTable(data.strokes, data.centers)
  renderChart(data)
}

function refresh () {
  render(getRangeData())
}

function syncDateControls (maxDate, { reset = false } = {}) {
  if (!maxDate) {
    return
  }

  currentMaxDate = maxDate
  const startInput = document.getElementById('start-date')
  const endInput = document.getElementById('end-date')

  if (reset || !currentStartDate) {
    currentStartDate = START_DATE
  }
  if (reset || !currentEndDate || currentEndDate > currentMaxDate) {
    currentEndDate = currentMaxDate
  }
  if (currentStartDate && currentEndDate && currentStartDate > currentEndDate) {
    currentStartDate = START_DATE <= currentEndDate ? START_DATE : historyRows[0]?.date || currentEndDate
  }

  startInput.value = currentStartDate
  endInput.value = currentEndDate
  startInput.max = currentMaxDate
  endInput.max = currentMaxDate
}

function initDateControls () {
  const startInput = document.getElementById('start-date')
  const endInput = document.getElementById('end-date')
  const applyButton = document.getElementById('apply-date-range')
  const resetButton = document.getElementById('reset-date-range')

  applyButton.addEventListener('click', () => {
    if (startInput.value && endInput.value && startInput.value > endInput.value) {
      const errorBox = document.getElementById('error')
      errorBox.hidden = false
      errorBox.textContent = '开始日期不能晚于结束日期。'
      return
    }

    currentStartDate = startInput.value || START_DATE
    currentEndDate = endInput.value || currentMaxDate
    refresh()
  })

  resetButton.addEventListener('click', () => {
    syncDateControls(currentMaxDate, { reset: true })
    refresh()
  })
}

function cleanHistoryRows (rows) {
  return rows.filter(
    (row) =>
      Number.isFinite(row.open) &&
      Number.isFinite(row.close) &&
      Number.isFinite(row.high) &&
      Number.isFinite(row.low)
  )
}

async function loadSymbolHistory (symbol) {
  if (historyPayload[symbol]) {
    return historyPayload[symbol]
  }

  const rows = cleanHistoryRows(await fetchIndexHistory(symbol))
  if (!rows.length) {
    throw new Error(`${symbolName(symbol)} 没有可用日 K 数据。`)
  }

  const payload = {
    rows,
    meta: { symbol, name: symbolName(symbol) }
  }
  historyPayload[symbol] = payload
  return payload
}

async function showSymbol (symbol, { force = false, resetDates = false } = {}) {
  if (isSwitching || (!force && symbol === currentSymbol)) {
    return
  }

  isSwitching = true
  updateActiveSymbol(symbol)
  setText('chan-zone', `正在加载 ${symbolName(symbol)} 日K...`)

  try {
    const payload = await loadSymbolHistory(symbol)
    currentSymbol = symbol
    currentMeta = payload.meta
    historyRows = payload.rows
    syncDateControls(historyRows[historyRows.length - 1].date, { reset: resetDates })
    updateActiveSymbol(symbol)
    refresh()
  } catch (error) {
    updateActiveSymbol(currentSymbol)
    const errorBox = document.getElementById('error')
    errorBox.hidden = false
    errorBox.textContent = `加载失败：${error.message}`
    setText('chan-zone', '加载失败')
  } finally {
    isSwitching = false
  }
}

async function init () {
  chartInstance = null
  historyRows = []
  historyPayload = {}
  currentSymbol = DEFAULT_SYMBOL
  currentMeta = { symbol: DEFAULT_SYMBOL, name: symbolName(DEFAULT_SYMBOL) }
  currentStartDate = START_DATE
  currentEndDate = null
  currentMaxDate = null
  isSwitching = false

  renderSymbolSwitcher()
  initDateControls()
  await showSymbol(DEFAULT_SYMBOL, { force: true, resetDates: true })
}

export {
  init,
  normalizeContainment,
  findFractals,
  buildStrokes,
  enrichStrokesWithStrength,
  buildSegments,
  buildCenters,
  buildSignals,
  buildFirstBuySellSignals,
  buildSecondBuySignals,
  buildSecondSellSignals,
  buildDivergenceSignals
}
