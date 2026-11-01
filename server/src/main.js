'use strict';
/**
 * 入口。
 *
 * 用法：
 *   node server/src/main.js                启动服务（默认 127.0.0.1:8000）
 *   node server/src/main.js --config       查看生效配置
 *   node server/src/main.js --stop         停掉在跑的实例
 *   node server/src/main.js --selftest     跑自检（算法回归 + 环境探测）
 *   node server/src/main.js --version      显示版本
 *
 * 启动即跑 API 服务：签名与解密都在进程内完成，没有第二个组件，
 * 也不存在任何启停开关。编排逻辑见 launcher；
 * 这里只保留版本号与自检两项轻量入口（外加把其余参数交给 launcher）。
 */

const Config = require('./util/config');
const Log = require('./util/log');

/**
 * 程序入口。
 *
 * @param {string[]} [argv] 命令行参数，默认取 process.argv.slice(2)
 * @returns {Promise<number>} 退出码（0 成功）
 */
async function main(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);

  for (const a of args) {
    if (a === '--version' || a === '-v') {
      // 版本号取自 package.json，详见 Config.version()
      console.log('hongguo-api ' + Config.version());
      return 0;
    }
  }

  for (const a of args) {
    if (a === '--selftest') {
      // 惰性 require：--version 等轻量入口无需拉起完整自检依赖。
      const SelfTest = require('./selftest');
      const code = await SelfTest.run();
      if (typeof code === 'number') process.exitCode = code;
      return typeof code === 'number' ? code : 0;
    }
  }

  const Launcher = require('./launcher');
  await Launcher.main(args);
  return 0;
}

module.exports = { main };

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2)))
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code;
    })
    .catch((e) => {
      Log.error('启动失败：' + (e && e.message ? e.message : e), e);
      process.exitCode = 1;
    });
}
