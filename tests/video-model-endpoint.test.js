'use strict';
/**
 * 播放取流端点选择（2026-11-25）：
 *   首选 POST reading.snssdk.com/novel/player/video_model/v1/（单集模型，tsukiyo-zero PR #142），
 *   仅当它回 HTTP 200 空响应时才回退旧的「批量 POST player/v1 → GET video_tab」链路。
 * 全程 mock Http.send，不触网。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Http = require('../server/src/util/http');
const Safeguards = require('../server/src/core/safeguards');
const AppSource = require('../server/src/service/app-source');
const Guard = require('../server/src/service/upstream-guard');

const VID = '7709114791150767128';
const CDN = 'https://v81-reading-video.qznovelvod.com/fixture.mp4';
const MODEL = {
  status: 10, video_id: VID, media_type: 'video', video_duration: 89.3,
  video_list: [{ codec_type: 'bytevc1', definition: '1080p', quality_desc: '1080p',
    vwidth: 1920, vheight: 1080, size: 16405714, main_url: CDN, backup_url: [], encrypt: '0' }],
};
const json = (obj) => new Http.Resp(200, Buffer.from(JSON.stringify(obj)));

function setup(t, handler) {
  t.mock.method(Safeguards, 'throttle', () => ({ wait: async () => {} }));
  // app-source 解构持有了 getPlaybackDevice 的引用，改其内部依赖：
  // 注册请求走真实网络（只读匿名注册，与线上取流前的步骤相同），播放请求全部 mock
  const realSend = Http.send;
  const calls = [];
  t.mock.method(Http, 'send', async (req) => {
    const url = new URL(req.url);
    if (url.host.endsWith('fqnovel.com') && url.pathname.includes('device_register')) return realSend(req);
    const body = req.body ? JSON.parse(require('zlib').gunzipSync(req.body).toString()) : null;
    const c = { host: url.host, path: url.pathname, method: req.method, body, stub: req.headers['x-ss-stub'] };
    calls.push(c);
    return handler(c, calls.length);
  });
  return calls;
}

const post = (path) => (c) => c.method === 'POST' && c.path === path;

test('首选单集模型接口：命中后不再请求旧批量链路', async (t) => {
  const calls = setup(t, (c) => post('/novel/player/video_model/v1/')(c)
    ? json({ code: 0, data: { video_id: VID, video_model: MODEL } })
    : new Http.Resp(200, Buffer.from('')));
  const row = await AppSource.fetch(VID, 'best', {});
  assert.equal(row.url, CDN);
  assert.equal(calls.length, 1, '不应再打旧的批量 POST / video_tab GET');
  const c = calls[0];
  assert.equal(c.host, 'reading.snssdk.com');
  assert.deepEqual(Object.keys(c.body), ['video_id', 'biz_param']);
  assert.equal(c.body.video_id, VID);
  assert.equal(c.body.biz_param.device_level, 2);
  assert.match(c.stub, /^[0-9A-F]{32}$/);
});

test('单集接口 video_model 为 JSON 字符串时同样可解析', async (t) => {
  setup(t, (c) => post('/novel/player/video_model/v1/')(c)
    ? json({ code: 0, data: { video_id: VID, video_model: JSON.stringify(MODEL) } })
    : new Http.Resp(200, Buffer.from('')));
  const row = await AppSource.fetch(VID, 'best', {});
  assert.equal(row.url, CDN);
});

test('单集接口返回 HTTP 200 空响应时回退旧批量链路', async (t) => {
  const calls = setup(t, (c, n) => post('/novel/player/video_model/v1/')(c)
    ? new Http.Resp(200, Buffer.from(''))
    : json({ code: 0, data: { [VID]: { video_model: MODEL } } }));
  const row = await AppSource.fetch(VID, 'best', {});
  assert.equal(row.url, CDN);
  assert.ok(calls.some((c) => c.path === '/novel/player/multi_video_model/player/v1'), '应回退到批量 POST');
  Guard.reportOk();
});

test('单集接口返回了别的分集时拒绝，不拿它顶替', async (t) => {
  setup(t, () => json({ code: 0, data: { video_id: '999', video_model: { ...MODEL, video_id: '999' } } }));
  await assert.rejects(() => AppSource.fetch(VID, 'best', {}), /分集与请求不符|未返回/);
});
