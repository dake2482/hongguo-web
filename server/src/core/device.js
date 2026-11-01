'use strict';
/**
 * 本机稳定设备身份。
 *
 * 背景（实测结论）：
 *   红果的 search/tab/v 接口会校验 query 里的 device_id。缺失时上游直接返回
 *   code=100103 PARAM_INVALID —— 与签名是否正确无关。
 *   有 device_id + 不匹配的 iid -> 空响应（风控拦截）；iid=0 -> code=0。
 *   结论：device_id 是必需项；iid 反而不能乱填，因此本模块只生成 device_id。
 *
 * 优先级：
 *   1. 环境变量 HONGGUO_DEVICE_ID / HG_DEVICE_ID（便于多实例隔离）
 *   2. 配置里已有的 device_id（config.json 的 upstream.base_query）
 *   3. apikeys.json 中持久化的值
 *   4. 以上都没有时生成新的并写回 apikeys.json
 */
const crypto = require('crypto');
const Json = require('../util/json');
const Config = require('../util/config');
const Log = require('../util/log');
const KeyStore = require('./keystore');

/** 设备 ID 取值范围：与抓包一致，16 位十进制（1e15 ~ 1e16-1）。 */
function randomDeviceId() {
  const n = crypto.randomBytes(8).readBigUInt64BE() % 9000000000000000n;
  return String(n + 1000000000000000n);
}

/** 校验格式：仅接受 10~20 位十进制数字，避免把脏值带进 query。 */
function isValidId(v) {
  if (v === null || v === undefined) return false;
  const t = String(v).trim();
  if (t.length < 10 || t.length > 20) return false;
  return /^\d+$/.test(t);
}

/**
 * 取得本机稳定 device_id。
 * @param {object|null} baseQuery 上游配置里的 base_query（可能被就地补全）
 * @returns {{deviceId: string, source: string}}
 */
function ensureDeviceId(baseQuery) {
  // 1) 环境变量优先：支持同一台机器跑多个实例并各自隔离身份
  const fromEnv = (Log.env('HONGGUO_DEVICE_ID', Config.str('runtime.device_id', '')) || '').trim();
  if (fromEnv !== '' && isValidId(fromEnv)) {
    if (baseQuery && !isValidId(Json.optStr(baseQuery.device_id, ''))) baseQuery.device_id = fromEnv;
    return { deviceId: fromEnv, source: 'env' };
  }

  // 2) 配置里已显式提供：尊重配置，不覆盖
  if (baseQuery) {
    const cfg = Json.optStr(baseQuery.device_id, '').trim();
    if (isValidId(cfg)) return { deviceId: cfg, source: 'config' };
  }

  // 3) 复用 apikeys.json 里持久化的值
  const saved = KeyStore.store().deviceId();
  if (isValidId(saved)) {
    if (baseQuery) baseQuery.device_id = saved;
    return { deviceId: saved, source: 'stored' };
  }

  // 4) 首次生成并写回 apikeys.json
  const id = randomDeviceId();
  if (baseQuery) baseQuery.device_id = id;
  KeyStore.store().setDeviceId(id);
  return { deviceId: id, source: 'generated' };
}

/**
 * 轮换被上游明确拒绝的本地身份；环境变量与配置文件指定的身份不覆盖。
 * 并发请求若已有请求完成轮换，则复用新值而不再生成第二个。
 */
function rotateDeviceId(baseQuery, identity, rejectedId) {
  if (identity === null || identity === undefined
      || !['stored', 'generated', 'rotated'].includes(identity.source)) return null;

  const store = KeyStore.store();
  const saved = store.deviceId();
  if (isValidId(saved) && saved !== String(rejectedId)) {
    if (baseQuery) baseQuery.device_id = saved;
    identity.deviceId = saved;
    identity.source = 'stored';
    return saved;
  }

  let id = randomDeviceId();
  while (id === String(rejectedId)) id = randomDeviceId();
  if (baseQuery) baseQuery.device_id = id;
  store.setDeviceId(id);
  identity.deviceId = id;
  identity.source = 'rotated';
  return id;
}

module.exports = { randomDeviceId, isValidId, ensureDeviceId, rotateDeviceId };
