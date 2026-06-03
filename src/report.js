'use strict';

const Table = require('cli-table3');
const chalk = require('chalk');

function printFearGreed(fg) {
  const { latestScore, latestDate, latestSubs, label } = fg;

  if (latestScore === null) {
    console.log(chalk.gray('\n  恐贪值：数据不足，无法计算\n'));
    return;
  }

  const scoreColor =
    latestScore >= 80 ? chalk.red :
    latestScore >= 60 ? chalk.yellow :
    latestScore >= 40 ? chalk.white :
    latestScore >= 20 ? chalk.cyan :
                        chalk.blue;

  console.log(chalk.bold.magenta('\n╔══════════════════════════════════════════════════════╗'));
  console.log(chalk.bold.magenta('║           上证指数 市场恐贪指数（简化版）            ║'));
  console.log(chalk.bold.magenta('╚══════════════════════════════════════════════════════╝\n'));

  const bar = buildBar(latestScore);
  console.log(`  最新日期：${chalk.bold(latestDate)}`);
  console.log(`  综合得分：${scoreColor(chalk.bold(`${latestScore.toFixed(1)} / 100`))}  ${scoreColor(chalk.bold(label))}`);
  console.log(`  情绪量表：${bar}\n`);

  const t = new Table({
    head: [chalk.bold('子指标'), chalk.bold('原始值'), chalk.bold('得分'), chalk.bold('说明')],
    colWidths: [16, 14, 10, 26],
    style: { border: ['magenta'] },
  });

  t.push(
    ['① 价格动能',   `${latestSubs.rawMomentumPct > 0 ? '+' : ''}${latestSubs.rawMomentumPct}%`, fmtSub(latestSubs.s1_momentum),      '收盘偏离MA60幅度'],
    ['② 历史波动率↓', `${latestSubs.rawVolatilityPct}%`,                                           fmtSub(latestSubs.s2_volatility),     '20日波动率（反向）'],
    ['③ RSI(14)',    `${latestSubs.rawRSI}`,                                                       fmtSub(latestSubs.s3_rsi),            '相对强弱百分位'],
    ['④ 方向成交量', `量比×${latestSubs.rawVolRatio > 0 ? '+' : ''}${latestSubs.rawVolRatio}`,      fmtSub(latestSubs.s4_volMomentum),    '量比×涨跌方向'],
    ['⑤ 价格位置',   '120日区间内',                                                                  fmtSub(latestSubs.s5_pricePosition),  '偏高点=贪婪'],
  );

  console.log(t.toString());
  console.log(chalk.gray('  区间说明：0–20 极度恐慌 | 20–40 恐慌 | 40–60 中性 | 60–80 贪婪 | 80–100 极度贪婪\n'));
}

function buildBar(score) {
  const filled = Math.round(score / 5);
  const bar    = '█'.repeat(filled) + '░'.repeat(20 - filled);
  if (score >= 80) return chalk.red(bar);
  if (score >= 60) return chalk.yellow(bar);
  if (score >= 40) return chalk.white(bar);
  if (score >= 20) return chalk.cyan(bar);
  return chalk.blue(bar);
}

function fmtSub(score) {
  const s = score.toFixed(1);
  if (score >= 70) return chalk.red(s);
  if (score >= 55) return chalk.yellow(s);
  if (score >= 45) return chalk.white(s);
  if (score >= 30) return chalk.cyan(s);
  return chalk.blue(s);
}

module.exports = { printFearGreed };
