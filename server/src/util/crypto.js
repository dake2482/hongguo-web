'use strict';
/**
 * 摘要与对称加密工具（基于 Node crypto）。
 * 提供 hex/unhex/MD5/AES-128-CTR/popcount 等最小能力。
 */
const crypto = require('crypto');

function toBuf(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data);
  return Buffer.from(data);
}

/** 小写十六进制。 */
function hex(data) {
  return toBuf(data).toString('hex');
}

/** 十六进制解码，非法字符/奇数长度直接抛错。 */
function unhex(s) {
  const t = String(s).trim();
  if (t.length % 2 !== 0) throw new Error('十六进制长度必须为偶数');
  if (!/^[0-9a-fA-F]*$/.test(t)) throw new Error('非法十六进制字符');
  return Buffer.from(t, 'hex');
}

/** MD5 摘要。 */
function md5(data) {
  return crypto.createHash('md5').update(toBuf(data)).digest();
}

/** MD5 大写十六进制，对应 Node createHash('md5').update(d).digest('hex').toUpperCase()。 */
function md5HexUpper(data) {
  return md5(data).toString('hex').toUpperCase();
}

/**
 * base64 解码。Node 的 Buffer.from(s,'base64') 已内置容错：
 * 忽略空白、截断非法尾部，无需再手写解码器。
 */
function base64Decode(s) {
  return Buffer.from(String(s).trim(), 'base64');
}

/**
 * AES-128-CTR 加解密（同一函数，加解密对称）。
 * @param {Buffer} key 16 字节密钥
 * @param {Buffer} counter 16 字节初始计数器
 * @param {Buffer} data 待处理数据
 */
function aes128Ctr(key, counter, data) {
  if (key.length !== 16) throw new Error('content key 长度非法');
  if (counter.length !== 16) throw new Error('CTR 计数器必须 16 字节');
  const c = crypto.createCipheriv('aes-128-ctr', key, counter);
  return Buffer.concat([c.update(data), c.final()]);
}

/** 32 位无符号整数的二进制 1 的个数（对应 spade 解包的 popcount）。 */
function popcount(x) {
  let v = x >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

module.exports = { hex, unhex, md5, md5HexUpper, base64Decode, aes128Ctr, popcount };
