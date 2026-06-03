'use strict';

const chalk                  = require('chalk');
const { fetchShangHaiIndex } = require('./fetchData');
const { calcFearGreed }      = require('./fearGreed');
const { printFearGreed }     = require('./report');
const { generateHTML }       = require('./chart');

async function main() {
  console.log(chalk.bold.cyan('='.repeat(52)));
  console.log(chalk.bold.cyan('  上证指数 市场恐贪指数分析'));
  console.log(chalk.bold.cyan('='.repeat(52)));

  const data      = await fetchShangHaiIndex();
  const fearGreed = calcFearGreed(data);

  printFearGreed(fearGreed);

  const htmlPath = generateHTML({
    dates:  data.map((d) => d.date),
    closes: data.map((d) => d.close),
    fearGreed,
  });
  console.log(chalk.bold.green(`\n  HTML 报告已生成：${htmlPath}`));
  console.log(chalk.gray('  在浏览器中打开查看图表。\n'));
}

main().catch((err) => {
  console.error(chalk.red('\n运行出错：'), err.message);
  process.exit(1);
});
