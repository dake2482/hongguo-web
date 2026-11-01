'use strict';
/**
 * 统一日志输出与环境变量读取。
 * 输出格式：yyyy-MM-dd HH:mm:ss [INFO|WARN] msg
 */

function two(n) { return String(n).padStart(2, '0'); }

function ts() {
  const d = new Date();
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} `
    + `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function write(stream, msg, isWarn) {
  stream.write(`${ts()} [${isWarn ? 'WARN' : 'INFO'}] ${msg}\n`);
}

function info(msg) { write(process.stdout, msg, false); }
function warn(msg) { write(process.stdout, msg, true); }
function error(msg, t) {
  write(process.stderr, msg, true);
  if (t) {
    if (t.stack) process.stderr.write(t.stack + '\n');
    else process.stderr.write(String(t) + '\n');
  }
}

/**
 * 读取配置项：环境变量优先，空字符串视为未设置（等价于 process.env.X || default）。
 */
function env(name, def = null) {
  const v = process.env[name];
  if (v === undefined || v === null) return def;
  const t = String(v).trim();
  return t === '' ? def : t;
}

function envInt(name, def = 0) {
  const v = env(name, null);
  if (v === null) return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

module.exports = { env, envInt, info, warn, error };
