'use strict';
/**
 * 基于 node:http/https 的 HTTP 客户端。
 *
 * 关键行为：
 *  - 默认跟随重定向
 *  - 默认不自动压缩（不主动发 accept-encoding，交给对端决定）
 *  - 超时抛异常而非静默返回
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

/** 响应结果。 */
class Resp {
  constructor(status, body, headers) {
    this.status = status;
    this.body = body || Buffer.alloc(0);
    this.headers = headers || {};
  }

  text() { return this.body.toString(); }

  header(name) {
    const v = this.headers[String(name).toLowerCase()];
    if (v === undefined || v === null) return null;
    return Array.isArray(v) ? (v.length ? v[0] : null) : String(v);
  }

  ok() { return this.status >= 200 && this.status < 300; }
}

/**
 * 发起请求。
 * @param {object} req { method, url, headers, body, timeoutMs, followRedirect }
 * @returns {Promise<Resp>}
 */
function send(req) {
  const follow = req.followRedirect !== false;
  return sendOnce(req, follow ? 5 : 0);
}

function sendOnce(req, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(req.url);
    } catch (e) {
      reject(new Error('非法 URL: ' + req.url));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('仅支持 http/https，当前协议不支持：' + req.url));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const method = req.method || 'GET';
    const headers = Object.assign({}, req.headers || {});
    const body = req.body || null;
    const hasLen = Object.keys(headers).some((k) => k.toLowerCase() === 'content-length');
    if (body && !hasLen) headers['content-length'] = String(body.length);

    const r = mod.request(u, {
      method,
      headers,
      timeout: req.timeoutMs || 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const loc = res.headers.location;
        if (redirectsLeft > 0 && res.statusCode >= 300 && res.statusCode < 400 && loc) {
          let m = method;
          if (res.statusCode === 303 || m === 'POST') m = 'GET';
          const nextUrl = new URL(loc, u).toString();
          const nh = Object.assign({}, headers);
          let nb = body;
          if (m === 'GET') {
            nb = null;
            for (const k of Object.keys(nh)) {
              const kl = k.toLowerCase();
              if (kl === 'content-length' || kl === 'content-type') delete nh[k];
            }
          }
          resolve(sendOnce({ ...req, method: m, url: nextUrl, body: nb, headers: nh }, redirectsLeft - 1));
          return;
        }
        resolve(new Resp(res.statusCode, buf, res.headers));
      });
    });
    r.on('timeout', () => r.destroy(new Error('请求超时')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

/** 解码查询片段；非法百分号转义时原样返回（Node 内置 decodeURIComponent 会抛错）。 */
function urldecode(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '));
  } catch (e) {
    return String(s);
  }
}

/**
 * 解析查询串为对象。
 * 用 Node 内置 URLSearchParams 完成解码，再按出现顺序覆盖写入，
 * 从而保持「重复键取最后一个」的既有语义。
 */
function parseQuery(qs) {
  const out = {};
  if (qs === null || qs === undefined || qs === '') return out;
  for (const [k, v] of new URLSearchParams(String(qs))) out[k] = v;
  return out;
}

/** 把多行文本按逗号切分成去空白列表；null/空返回 null。 */
function splitCsv(v) {
  if (v === null || v === undefined || v === '') return null;
  const out = [];
  for (const s of String(v).split(',')) {
    const t = s.trim();
    if (t !== '') out.push(t);
  }
  return out;
}

module.exports = { Resp, send, urldecode, parseQuery, splitCsv };
