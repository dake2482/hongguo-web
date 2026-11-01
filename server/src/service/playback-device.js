'use strict';
/**
 * 匿名播放设备注册（恢复 App 取流的关键一步）。
 *
 * 背景（2026-10-27 实测）：播放接口 multi_video_model/v1 会校验请求中的
 * device_id / iid。此前每次请求随机生成一对互不关联的合成 ID，上游返回
 * 200 + 0 字节（软拦截）；改用平台注册的匿名设备身份后，同一接口正常
 * 返回 code=0 与完整片源（约 22KB）。
 *
 * 注册协议（ttEncrypt，移植自 tsukiyo-zero/hongguoTV 的 DeviceRegister.kt，
 * GPL-3.0-only，来源见 THIRD-PARTY-NOTICES）：
 *   payload = { magic_tag:'ss_app_log', header, _gen_time }
 *   body    = 746305100000(6B) + random(32B) + AES-128-CBC(sha512(gzip) + gzip)
 *   key/iv  = sha512(sha512(random) + KDF_SALT) 前 32 字节
 *
 * 身份只保留 device_id / iid / cdid，仅存进程内存；不保存设备令牌、
 * Cookie 或完整响应。
 *
 * 缓存策略：成功结果进程内永久复用（身份不变）；失败结果只复用
 * RETRY_COOLDOWN_MS，冷却期过后下次调用会重新注册 —— 否则开机时网络
 * 未就绪这类瞬时故障会让整个进程永久不可播放，只能重启。
 */
const crypto = require('crypto');
const zlib = require('zlib');
const Http = require('../util/http');

const REGISTER_URL = 'https://log5-applog-lf.fqnovel.com/service/2/device_register/'
  + '?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin'
  + '&use_store_region_cookie=1';

/** ttEncrypt 固定盐（与客户端 SDK 一致）。 */
const KDF_SALT = Buffer.from(
  '4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524'
  + 'f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');

/** 注册 UA 的版本号与 body 的 version_code（73932 / 7.3.9.32）保持一致。 */
const REGISTER_UA = 'com.phoenix.read/73932 (Linux; U; Android 16; zh_CN; 25053RT47C; '
  + 'Build/BP2A.250605.031.A3)';

/** 注册失败后的重试冷却（毫秒）：冷却期内复用失败结果，避免每个请求都去打上游。 */
const RETRY_COOLDOWN_MS = 60000;

/** 当前注册结果（Promise）。成功后复用至主动失效；失败仅在冷却期内复用。 */
let registration = null;

/** 当前缓存的失败时间戳（毫秒）；0 表示缓存的是成功结果。 */
let failedAt = 0;

/** 取 *_str 优先、数字兜底，仅接受正整数形式的 ID。 */
function responseId(response, name) {
  const preferred = response[`${name}_str`];
  const value = (preferred === undefined || preferred === null || preferred === '')
    ? response[name] : preferred;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  }
  return (typeof value === 'string' && /^\d{1,30}$/.test(value) && /[1-9]/.test(value))
    ? value : '';
}

/** 构造 ttEncrypt 加密后的注册请求体。 */
function buildBody(now, cdid) {
  const header = {
    display_name: '红果免费短剧', update_version_code: 73932, manifest_version_code: 73932,
    app_version_minor: '7.3.9.32', aid: 8662, channel: 'update_64', package: 'com.phoenix.read',
    app_version: '7.3.9.32', version_code: 73932, sdk_version: '3.7.0-rc.34-fanqie-xiaoshuo',
    sdk_target_version: 29, git_hash: '3a88f4e', os: 'Android', os_version: '16', os_api: 36,
    device_model: '25053RT47C', device_brand: 'Redmi', device_manufacturer: 'Redmi',
    cpu_abi: 'arm64-v8a', release_build: 'b5e187f', density_dpi: 520, display_density: 'mdpi',
    resolution: '1280x2772', language: 'zh', timezone: 8, access: 'wifi', not_request_sender: 0,
    carrier: 'CHINA MOBILE', mcc_mnc: '46000', rom: 'eng.root.20231116.160340',
    rom_version: 'W528JS release-keys', cdid,
    sig_hash: '56a962410c494bbaf0b58dba20cae56f', openudid: crypto.randomBytes(8).toString('hex'),
    clientudid: crypto.randomUUID(), ipv6_list: [], region: 'CN', tz_name: 'Asia/Shanghai',
    tz_offset: 28800, sim_region: 'cn', sim_serial_number: [], oaid_may_support: false,
    req_id: crypto.randomUUID(), device_platform: 'android',
    custom: { account_region_src: 'fallback', account_region: 'cn', host_bit: 64,
      dragon_device_type: 'phone' },
    pre_installed_channel: '',
    apk_first_install_time: now, is_system_app: 0, sdk_flavor: 'china', guest_mode: 0,
  };
  const compressed = zlib.gzipSync(
    Buffer.from(JSON.stringify({ magic_tag: 'ss_app_log', header, _gen_time: now })));
  const random = crypto.randomBytes(32);
  const derived = crypto.createHash('sha512').update(Buffer.concat([
    crypto.createHash('sha512').update(random).digest(), KDF_SALT,
  ])).digest();
  const cipher = crypto.createCipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
  const plaintext = Buffer.concat([crypto.createHash('sha512').update(compressed).digest(), compressed]);
  return Buffer.concat([Buffer.from('746305100000', 'hex'), random, cipher.update(plaintext), cipher.final()]);
}

/**
 * 注册匿名播放设备；成功后返回 Object.freeze({device_id, iid, cdid})。
 *
 * 成功结果进程内永久复用；失败结果只在 RETRY_COOLDOWN_MS 内复用，
 * 冷却结束后自动重新注册（无需重启应用）。
 */
function getPlaybackDevice() {
  if (registration !== null) {
    if (failedAt === 0) return registration;
    if (Date.now() - failedAt < RETRY_COOLDOWN_MS) return registration;
    // 冷却结束：丢弃失败缓存，重新注册
    registration = null;
    failedAt = 0;
  }
  const pending = (async () => {
    try {
      const now = Date.now();
      const cdid = crypto.randomUUID();
      const body = buildBody(now, cdid);
      const res = await Http.send({
        url: REGISTER_URL,
        method: 'POST',
        timeoutMs: 8000,
        followRedirect: false,
        headers: {
          'User-Agent': REGISTER_UA,
          Accept: 'application/json',
          'Content-Type': 'application/octet-stream;tt-data=a',
          'log-encode-type': 'gzip',
          'x-ss-dp': '8662',
          'x-ss-req-ticket': String(now),
          'x-vc-bdturing-sdk-version': '4.0.3.cn',
          lc: '101',
          'sdk-version': '2',
          'passport-sdk-version': '5051452',
          'x-neptune': '-8|50:51:59:30:40:47:49:39',
          'x-ss-stub': crypto.createHash('md5').update(body).digest('hex').toUpperCase(),
        },
        body,
      });
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      let j = null;
      try { j = JSON.parse(res.text()); } catch (e) { j = null; }
      const deviceId = j === null ? '' : responseId(j, 'device_id');
      const iid = j === null ? '' : responseId(j, 'install_id');
      const code = Number((j === null ? 0 : (j.code !== undefined ? j.code : j.Code)) || 0);
      if (deviceId === '' || iid === '' || code !== 0) throw new Error('无效的注册响应');
      return Object.freeze({ device_id: deviceId, iid, cdid });
    } catch (e) {
      throw Object.assign(new Error('匿名播放设备注册失败，请稍后重试'), {
        code: 'DEVICE_REGISTRATION_FAILED', cause: e,
      });
    }
  })();
  // 记录失败时刻（只标记「当前」这次，避免被 reset 后的新注册覆盖）
  pending.catch(() => {
    if (registration === pending) failedAt = Date.now();
  });
  registration = pending;
  return pending;
}

/**
 * 清空注册缓存；传入被拒绝的 ID 时仅失效匹配的注册结果，避免并发误清新身份。
 * 下一次 getPlaybackDevice() 将重新发起注册。
 */
async function resetPlaybackDevice(rejectedDeviceId) {
  const pending = registration;
  if (pending === null) return;
  let current = null;
  try { current = await pending; } catch (e) { /* 清除失败的注册结果 */ }
  if (registration !== pending) return;
  if (rejectedDeviceId !== undefined && rejectedDeviceId !== null
      && current !== null && current.device_id !== String(rejectedDeviceId)) return;
  registration = null;
  failedAt = 0;
}

module.exports = { getPlaybackDevice, resetPlaybackDevice };
