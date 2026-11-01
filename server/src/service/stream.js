'use strict';
/**
 * 下载 + 纯离线解密流水线。
 *
 * 流程：videoTrack 取 spade_a 与直链（AppSource 取址，见 videoTrack 注释）
 *      -> 下载密文 mp4
 *      -> spade 解包 content key（纯字节变换）
 *      -> AES-128-CTR 全轨解密（视频+音频各用自身逐样本 IV）
 *      -> 纯 JS 减壳剥离 CENC 信令成普通 mp4（布局不符时回落 ffmpeg remux）
 *      -> 缓存复用
 *
 * 同步 / 异步：凡发网络或文件异步 IO 的入口（videoTrack / download /
 * offlineDecrypt / ensureDecrypted / prewarm）都是 async（返回 Promise）；
 * 路径计算、缓存清理、ffmpeg 探测等纯计算保持同步。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const Mp4 = require('../core/mp4');
const Spade = require('../core/spade');
const Config = require('../util/config');
const Log = require('../util/log');
const Http = require('../util/http');
const Safeguards = require('../core/safeguards');
const AppSource = require('../service/app-source');
const { readFullySync, escapeRe } = require('../util/common');

/** 默认保留的缓存文件数上限。 */
const CACHE_MAX_FILES = 30;

/** 缓存根目录：
 *  1) 环境变量 HONGGUO_STREAM_CACHE 直接指定缓存目录（自检/临时覆盖用）；
 *  2) 否则取 runtime.data_dir（视频缓存根，可为空），再拼 stream-cache；
 *  3) 都为空则退回 'server'（即 server/stream-cache）。
 *  统一转绝对路径：/download 会把落盘路径回给调用方，相对路径不便定位文件。 */
function cacheDir() {
  const d = Log.env('HONGGUO_STREAM_CACHE', null);
  if (d !== null) return path.resolve(d);
  const dd = Config.str('runtime.data_dir', null);
  // 默认落在 server/stream-cache（data 目录已撤销，缓存直接挂到 server 下）。
  // runtime.data_dir 语义收窄为「视频缓存根目录」，设了就以它为根。
  const base = (dd !== null) ? dd : 'server';
  return path.resolve(base, 'stream-cache');
}

/** 同键并发去重：同一集并发请求只解密一次。键为 out 路径，值为 Promise<string>。 */
const INFLIGHT = new Map();

/** 取该集指定清晰度的轨道信息。 */
async function videoTrack(vid, quality) {
  // 播放直链统一走 App 取址：b 域名 multi_video_model/v1 + fallback_api 二次请求。
  // 上游 a 域名 preload/v1 已对部分分集（后集高发）不再返回 video_model；
  // 官网播放页曾是明文直链来源，但改版后 SSR 不再输出 main_url，
  // 仅剩 360p 预览 contentUrl（付费集下载即 404），故不再走官网。
  // 拿不到时返回 null，由 ensureDecrypted 报「无直链 / video_model」。
  return AppSource.fetch(String(vid), quality);
}

// ==================== 下载 ====================

/** 带临时文件的下载（失败自动清理），返回写入的字节数。 */
async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const res = await Http.send({
    url,
    method: 'GET',
    timeoutMs: 120000,
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
  if (res.status >= 400) {
    throw new Error('下载失败 HTTP ' + res.status);
  }
  try {
    fs.writeFileSync(tmp, res.body);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (ignore) { /* 忽略 */ }
    throw e;
  }
  fs.renameSync(tmp, dest);
  return res.body.length;
}

// ==================== 离线解密 ====================

/** 解密结果。 */
class DecryptOut {
  constructor(path = null, key = null, tracks = 0, size = 0) {
    this.path = path;
    this.key = key;
    this.tracks = tracks;
    this.size = size;
  }
}

/**
 * 纯离线解密：spadeA(base64) + 密文 mp4 -> 明文 mp4。
 *
 * 内存策略（关键）：**全程不把整个 MP4 读进堆**。
 * 1) 16 字节盒头顺读定位 moov，仅把 moov 段（几 MB）载入内存解析索引；
 * 2) 流式 copy 密文 -> outPath（调用方已把密文落在 outPath 时跳过）；
 * 3) 用 outPath 的随机读写句柄逐样本解密。
 * 因此峰值堆内存只与「moov 段大小 + 单个样本大小」有关，
 * 与视频总时长/文件大小无关（历史实现是 50~200MB/集，32 并发时会撑爆堆）。
 *
 * @returns {Promise<DecryptOut>}
 */
async function offlineDecrypt(spadeAB64, ctPath, outPath) {
  const sp = Spade.spadeToKey(spadeAB64, 0);
  const key = sp.key;
  if (!Spade.isValidKey(key)) {
    throw new Error('spade 解包失败（可能为 ver2/AES-GCM 或格式异常）');
  }

  const outSize = fs.statSync(ctPath).size;

  // ---- 1. 定位并仅加载 moov 段 ----
  let analysis;
  const raf = fs.openSync(ctPath, 'r');
  try {
    const fileLen = fs.fstatSync(raf).size;
    const moov = Mp4.findMoov(new Mp4.FileHeadReader(raf), fileLen);
    if (moov === null) throw new Error('密文文件无moov 盒（不是有效的 MP4）');
    if (moov.size > 0x7FFFFFFF - 8) {
      throw new Error('moov 段异常过大，无法载入内存');
    }
    const moovBuf = Buffer.alloc(moov.size);
    readFullySync(raf, moovBuf, 0, moovBuf.length, moov.start);
    analysis = Mp4.analyzeEncryptedTracks(new Mp4.ByteView(moovBuf, moov.start));
  } finally {
    fs.closeSync(raf);
  }
  if (analysis.tracks.length === 0) throw new Error('密文文件无加密轨');

  // 视频轨用于 IV 自证；随后所有加密轨（视频+音频）统一用同一 content key 解密
  let video = null;
  for (const t of analysis.tracks) {
    if (t.handler === 'vide') { video = t; break; }
  }
  if (video === null) video = analysis.tracks[0];

  // ---- 2. 复制密文到 outPath（同路径时跳过：调用方已直接落在 outPath）----
  // fs.copyFileSync 由内核完成复制，无需手写 64KB 循环。
  if (ctPath !== outPath) fs.copyFileSync(ctPath, outPath);

  // ---- 3. 逐样本原地解密 ----
  let decrypted = 0;
  // 样本缓冲取 256KB：足够覆盖绝大多数样本，又不会让并发时堆占用膨胀
  const out = fs.openSync(outPath, 'r+');
  try {
    const store = new Mp4.RafStore(out, 256 * 1024);

    // ⚠️ 必须先verify 再 decrypt：若顺序颠倒，样本 0 已是明文，
    // avccSelfOk 仍会通过，导致错误的 content key 被误判为合法。
    const cands = Mp4.trackBaseIvCandidates(video);
    const vIv = Mp4.verifyVideoIv(store, video, key, cands);
    if (vIv === null) {
      throw new Error('content key 与密文不匹配（spade 与该密文不对应，或为 ver2 视频）');
    }

    for (const t of analysis.tracks) {
      // 每条轨用各自的逐样本 IV；缺失时才回退到该轨的 base_iv
      let iv;
      if (t === video) {
        iv = vIv;
      } else {
        const tc = Mp4.trackBaseIvCandidates(t);
        iv = tc.length === 0 ? vIv : tc[0];
      }
      decrypted += Mp4.decryptTrack(store, t, key, iv).decrypted;
    }
  } finally {
    fs.closeSync(out);
  }

  // 尝试生成可播放成品：纯 JS 减壳，失败回落 ffmpeg remux；
  // 两条路都失败则保留已解密的原始容器（raw），调用方按 raw 返回。
  const playable = await toPlayable(outPath);

  return new DecryptOut(playable, key, decrypted, outSize);
}

/** 编码器描述。 */
class Encoder {
  constructor(name, args) {
    this.name = name;
    this.args = args;
  }
}

let cachedEncoder = null;
let encoderProbed = false;

/**
 * 探测本机可用的 H.264 编码器（结果缓存）。
 * 优先级：环境变量指定 > libx264 > libopenh264 > h264_qsv / h264_v4l2m2m。
 */
function h264Encoder() {
  if (encoderProbed) return cachedEncoder;
  encoderProbed = true;

  const preset = Log.env('HG_H264_ENCODER', '').trim();
  let list = '';
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], {
      encoding: 'utf8', maxBuffer: 8 << 20,
    });
    if (r.error) return null;
    list = r.stdout || '';
  } catch (e) {
    return null;
  }
  const fl = list;
  const has = (n) => new RegExp('\\s' + escapeRe(n) + '\\s').test(fl);

  const table = [];
  if (preset !== '' && has(preset)) {
    table.push(new Encoder(preset, []));
  } else {
    table.push(new Encoder('libx264', ['-preset', 'veryfast', '-crf', '23']));
    table.push(new Encoder('libopenh264', ['-b:v', '2500k']));
    table.push(new Encoder('h264_qsv', ['-preset', 'veryfast']));
    table.push(new Encoder('h264_v4l2m2m', []));
  }
  for (const e of table) {
    if (has(e.name)) {
      // pix_fmt 与 crf 只对 x264/openh264 有意义
      e.args.push('-pix_fmt', 'yuv420p');
      cachedEncoder = e;
      return cachedEncoder;
    }
  }
  return null;
}

/** 是否开启转码：仅 HG_TRANSCODE=1（默认关闭）。 */
function transcodeWanted() {
  return Log.env('HG_TRANSCODE', '') === '1';
}

/** 删除文件，失败仅忽略（调用方都已有兜底路径）。 */
function deleteQuietly(f) {
  try {
    fs.unlinkSync(f);
  } catch (ignore) {
    // 忽略
  }
}

/**
 * 生成可播放成品（同步执行）。
 *
 * 默认路径：纯 JS 减壳（见 mp4.js 的 stripEncryption）——样本数据此时
 * 已是明文，只需从 moov 删掉加密信令盒（sinf/senc/saio/saiz/pssh）并把
 * chunk 偏移平移过来，mdat 原样拷贝，不依赖 ffmpeg。
 * 减壳不适用（布局异常等）或显式开启转码时，回落 ffmpeg remux；
 * 两条路都失败返回 null，由调用方保留已解密的 raw 文件。
 *
 * HONGGUO_PURE_STRIP=0 可强制走 ffmpeg（A/B 对比或应急回退）。
 *
 * 本函数是内部实现：等 ffmpeg 时不阻塞事件循环，故为 async。
 */
async function toPlayable(rawPath) {
  const name = path.basename(rawPath);
  const dir = path.dirname(rawPath);
  // 对齐 Node 的 path.parse().name：先剥掉最后一段扩展名，再剥 .raw 段。
  // 顺序不能反——raw 文件名是 <vid>_<q>.raw.mp4，
  // 若只去 .raw 会得到 <vid>_<q>.raw.mp4.play.mp4 这种双后缀名。
  let stem = name;
  const dot = stem.lastIndexOf('.');
  if (dot > 0) stem = stem.substring(0, dot);
  if (stem.endsWith('.raw')) stem = stem.substring(0, stem.length - 4);
  if (stem === '') stem = name;
  const out = path.join(dir, stem + '.play.mp4');

  // 转码默认关闭（HG_TRANSCODE=1 才开）
  const want = transcodeWanted();

  // ---- 默认路径：纯 JS 减壳 ----
  if (!want && Log.env('HONGGUO_PURE_STRIP', '') !== '0') {
    try {
      if (Mp4.stripEncryption(rawPath, out)) {
        deleteQuietly(rawPath);
        return out;
      }
      Log.warn('纯 JS 减壳不适用，回落 ffmpeg remux：' + path.basename(rawPath));
    } catch (e) {
      Log.warn('纯 JS 减壳异常，回落 ffmpeg remux：' + e);
    }
  }

  const enc = want ? h264Encoder() : null;
  if (want && enc === null) {
    Log.info('HG_TRANSCODE=1 但未找到可用的 H.264 编码器，本集退回 -c copy；'
      + '若浏览器不支持 HEVC 会黑屏');
  }

  const cmd = [
    '-y', '-loglevel', 'error', '-i', rawPath,
    '-c:v', enc !== null ? enc.name : 'copy',
  ];
  if (enc !== null) cmd.push(...enc.args);
  cmd.push('-c:a', enc !== null ? 'aac' : 'copy');
  if (enc !== null) cmd.push('-b:a', '128k');
  cmd.push('-movflags', '+faststart', out);

  try {
    // stderr 已合并进 stdout：限长收集（4KB），仅失败时用于诊断——
    // 旧实现整段丢弃，remux 失败时控制台只剩「remux 失败」无线索。
    const p = spawn('ffmpeg', cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errChunks = [];
    let errLen = 0;
    const collect = (chunk) => {
      if (errLen >= 4096) return;
      const take = chunk.length > (4096 - errLen)
        ? chunk.subarray(0, 4096 - errLen) : chunk;
      errChunks.push(Buffer.from(take));
      errLen += take.length;
    };
    p.stderr.on('data', collect);
    // stdout 读掉即可，防止管道写满挂死 ffmpeg
    p.stdout.on('data', () => { /* discard */ });

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 无超时的等待会让卡死的 ffmpeg 永久挂住请求线程
        try { p.kill('SIGKILL'); } catch (ignore) { /* 忽略 */ }
        resolve({ timeout: true });
      }, 60000);
      p.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ error: true });
      });
      p.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code });
      });
    });

    if (outcome.timeout) {
      Log.warn('ffmpeg remux 超时（60s）已强杀：' + path.basename(rawPath));
      return null;
    }
    if (outcome.error) {
      Log.warn('ffmpeg remux 异常（' + path.basename(rawPath) + '）');
      return null;
    }

    const ok = outcome.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0;
    if (!ok) {
      const detail = Buffer.concat(errChunks).toString().trim();
      Log.warn('ffmpeg remux 失败（' + path.basename(rawPath) + '）'
        + (detail === '' ? '' : '：' + detail));
      return null;
    }
    deleteQuietly(rawPath);
    return out;
  } catch (e) {
    Log.warn('ffmpeg remux 异常（' + path.basename(rawPath) + '）：' + e);
    return null;
  }
}

// ==================== 缓存 ====================

/** 缓存路径三变体（均为字符串路径）。 */
class Paths3 {
  constructor(out, play, raw) {
    this.out = out;    // 未加密直下的成品
    this.play = play;  // 加密解密 + remux 后的成品
    this.raw = raw;    // remux 前的解密产物
  }
}

/**
 * 计算某集指定清晰度的缓存路径。
 *
 * 注意 play 路径：offlineDecrypt 末尾会 remux 出「基名.play.mp4」（并删掉 raw），
 * 而基名不含.raw 段，所以加密内容最终落盘的是 <vid>_<q>.play.mp4。
 * 三个变体都必须参与命中判定，否则加密集永远命中不了缓存。
 */
function cachePaths(vid, quality) {
  const q = (quality === null || quality === undefined) ? '' : String(quality);
  let safeQ = q.replace(/[^\w]/g, '');
  if (safeQ === '') safeQ = 'best';
  const base = path.join(cacheDir(), vid + '_' + safeQ);
  return new Paths3(base + '.mp4', base + '.play.mp4', base + '.raw.mp4');
}

/** 命中缓存则返回可播放文件路径，否则 null。 */
function cachedPath(vid, quality) {
  const p = cachePaths(vid, quality);
  for (const c of [p.play, p.out, p.raw]) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).size > 0) return c;
    } catch (e) {
      // 忽略
    }
  }
  return null;
}

/** 预热失败后的最大重试次数（不含首次尝试），即最多共尝试 3 次。 */
const PREWARM_MAX_RETRIES = 2;

/** 两次预热重试之间的间隔（毫秒）。 */
const PREWARM_RETRY_DELAY_MS = 500;

/** 预热执行体：失败时按 PREWARM_MAX_RETRIES 重试，全数失败才抛出。 */
async function prewarmOnce(vid, quality) {
  let last = null;
  for (let attempt = 0; attempt <= PREWARM_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // 注册失败或播放接口空响应都需要重新注册；空响应只清理对应 ID，
      // 避免并发请求误清除另一请求刚注册成功的新身份。
      if (last !== null && (last.code === 'DEVICE_REGISTRATION_FAILED'
          || last.code === 'PLAYBACK_EMPTY_RESPONSE')) {
        await AppSource.resetPlaybackDevice(last.deviceId);
        if (last.code === 'PLAYBACK_EMPTY_RESPONSE') {
          Log.warn('播放接口返回空响应，重新注册匿名播放设备后重试');
        }
      }
      // 重试前稍作等待，给瞬时故障一个恢复窗口
      await Safeguards.sleep(PREWARM_RETRY_DELAY_MS);
    }
    try {
      return await ensureDecrypted(vid, quality);
    } catch (e) {
      last = e;
      Log.warn('预热失败 ' + vid + '（第 ' + (attempt + 1) + '/'
        + (PREWARM_MAX_RETRIES + 1) + ' 次尝试）：' + errMsg(e));
    }
  }
  throw last;
}

/** 取异常文案。 */
function errMsg(e) {
  if (e === null || e === undefined) return 'null';
  return (e.message !== undefined && e.message !== null) ? String(e.message) : String(e);
}

/**
 * 预热执行位：有界，避免高频调用 /prewarm 时无限堆积。
 *
 * 背景：每次预热都会跑完整的下载 + 解密（各自持一份样本缓冲），
 * 若不加限制，高频调用会让并发数与内存同步膨胀。
 * Node 用「有界执行位 + 队列」实现限流，队列写满时退化为
 * 调用方直接执行（队列满就不再排队，避免无限堆积）。
 */
const PREWARM_MAX_CONCURRENCY = 4;
const PREWARM_QUEUE_MAX = 64;
let prewarmActive = 0;
const prewarmQueue = [];

function runPrewarm(vid, quality) {
  prewarmActive++;
  prewarmOnce(vid, quality)
    .catch((e) => {
      Log.warn('预热最终失败 ' + vid + '：已重试 ' + PREWARM_MAX_RETRIES
        + ' 次仍不成功，' + errMsg(e));
    })
    .finally(() => {
      prewarmActive--;
      const next = prewarmQueue.shift();
      if (next !== undefined) next();
    });
}

/** 预热：后台触发解密，不阻塞响应。 */
async function prewarm(vid, quality) {
  const hit = cachedPath(vid, quality);
  if (hit !== null) return 'cached';
  // 故意不等待：让解密在后台跑
  if (prewarmActive >= PREWARM_MAX_CONCURRENCY && prewarmQueue.length >= PREWARM_QUEUE_MAX) {
    // 执行位与队列都满：退化为当前调用同步执行，保证预热仍然生效
    try {
      await prewarmOnce(vid, quality);
    } catch (e) {
      Log.warn('预热最终失败 ' + vid + '：已重试 ' + PREWARM_MAX_RETRIES
        + ' 次仍不成功，' + errMsg(e));
      return 'failed';
    }
    return 'warming';
  }
  const schedule = () => runPrewarm(vid, quality);
  if (prewarmActive < PREWARM_MAX_CONCURRENCY) schedule();
  else prewarmQueue.push(schedule);
  return 'warming';
}

/** 确保某集已解密并落盘缓存，返回可播放 mp4 路径。 */
async function ensureDecrypted(vid, quality) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const p = cachePaths(vid, quality);

  const hit = cachedPath(vid, quality);
  if (hit !== null) {
    // 只有残留的 raw（缺 play 成品）才需要补一次减壳/remux
    if (hit !== p.raw) return hit;
    const r = await toPlayable(p.raw);
    if (r !== null) return r;
  }

  const outKey = p.out;
  const exist = INFLIGHT.get(outKey);
  if (exist !== undefined) return exist; // 同集并发只解一次

  const task = (async () => {
    const again = cachedPath(vid, quality);
    if (again !== null && again !== p.raw) return again;

    const t = await videoTrack(vid, quality);
    if (t === null || t === undefined || t.url === null
        || t.url === undefined || t.url === '') {
      throw new Error('无直链 / video_model');
    }
    if (!t.encrypt) {
      await download(t.url, p.out);
      pruneCache();
      return p.out;
    }
    // 密文直接落在 raw 路径：offlineDecrypt 原地解密后原地减壳，
    // 省去旧实现里 .enc -> raw 的那次整文件拷贝（13MB/集的纯浪费）。
    await download(t.url, p.raw);
    const r = await offlineDecrypt(t.spadeA, p.raw, p.raw);
    // 减壳/remux 成功时返回 .play.mp4，失败时回退 raw
    const res = (r.path !== null && r.path !== undefined) ? r.path : p.raw;
    // 落盘完成后再清理：此时 play/raw 已是成品，不会误删半成品
    pruneCache();
    return res;
  })();
  INFLIGHT.set(outKey, task);
  try {
    return await task;
  } finally {
    INFLIGHT.delete(outKey);
  }
}

// ==================== 缓存上限清理 ====================

/**
 * 清理缓存目录，只保留最新的 limit 个成品文件。
 *
 * 按**最后修改时间**倒序保留，最旧的先删。每个 `<vid>_<q>` 最多留下
 * 一个成品（play > out > raw），因此实际删除数会略多于「超出的个数」。
 *
 * 两种文件不参与清理、也不会被删：
 * - `*.part`：下载临时文件，仍在被写；
 * - `*.enc`：密文临时文件，解密中且 finally 还要用。
 *
 * 上限取自 `runtime.cache.max_files`（配置文件，默认 CACHE_MAX_FILES），
 * 可被环境变量 `HONGGUO_CACHE_MAX_FILES` 覆盖；设为 0 或负数即关闭清理。
 *
 * @returns {number} 被删除的文件数
 */
function pruneCache(limit) {
  if (limit === undefined || limit === null) {
    const v = Log.env('HONGGUO_CACHE_MAX_FILES',
      Config.num('runtime.cache.max_files', CACHE_MAX_FILES));
    limit = (typeof v === 'number') ? v : parseInt(String(v).trim(), 10);
    if (Number.isNaN(limit)) limit = Config.num('runtime.cache.max_files', CACHE_MAX_FILES);
  }
  if (limit <= 0) return 0;

  const dir = cacheDir();
  // 目录不存在说明还没落过盘，无需清理
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch (e) { isDir = false; }
  if (!isDir) return 0;

  try {
    const keepable = [];
    for (const n of fs.readdirSync(dir)) {
      // 只统计成品文件（.play.mp4 / .mp4）；.raw.mp4 也以 .mp4 结尾，故一并纳入。
      if (!n.endsWith('.play.mp4') && !n.endsWith('.mp4')) continue;
      // 跳过下载/密文临时文件，避免删掉正在写或解密仍要用的
      if (n.endsWith('.part') || n.endsWith('.enc')) continue;
      const full = path.join(dir, n);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile()) continue;
      keepable.push({ p: full, name: n, mtime: st.mtimeMs });
    }
    if (keepable.length <= limit) return 0;

    // 最后修改时间倒序：靠前的保留，靠后的（更旧）删除
    keepable.sort((a, b) => b.mtime - a.mtime);

    let deleted = 0;
    for (let i = limit; i < keepable.length; i++) {
      const victim = keepable[i];
      try {
        fs.unlinkSync(victim.p);
        deleted++;
      } catch (e) {
        // 单个失败不影响其余，照常删；仅记录，不中断
        Log.warn('缓存清理：删除 ' + victim.name + ' 失败：' + errMsg(e));
      }
    }
    // 正常清理不打印日志（此前每次清理都会向控制台输出一行）
    return deleted;
  } catch (e) {
    // 清理是尽力而为，失败不应影响播放
    Log.warn('缓存清理失败：' + errMsg(e));
    return 0;
  }
}

// ==================== 环境探测 ====================

let cachedFfmpeg = null;

/** ffmpeg 是否可用（同步检查一次并缓存）。 */
function ffmpegAvailable() {
  if (cachedFfmpeg !== null) return cachedFfmpeg;
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    cachedFfmpeg = !r.error && r.status === 0;
  } catch (e) {
    cachedFfmpeg = false;
  }
  return cachedFfmpeg;
}

/** 转码是否启用（HG_TRANSCODE=1 且找到编码器）。 */
function transcodeEnabled() {
  return transcodeWanted() && h264EncoderName() !== null;
}

/** 当前实际使用的 H.264 编码器名（未启用/不可用时返回 null）。 */
function h264EncoderName() {
  if (!transcodeWanted()) return null;
  if (!ffmpegAvailable()) return null;
  const e = h264Encoder();
  return e !== null ? e.name : null;
}

module.exports = {
  videoTrack,
  download,
  offlineDecrypt,
  cachePaths,
  cachedPath,
  ensureDecrypted,
  prewarm,
  pruneCache,
  ffmpegAvailable,
  transcodeEnabled,
  h264EncoderName,
  DecryptOut,
  Paths3,
  CACHE_MAX_FILES,
};
