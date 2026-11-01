'use strict';
/**
 * 红果短剧 Web 服务。
 *
 * 基于 Node 内置 http 模块实现，零第三方依赖。
 *
 * 路由：/ /health /api-key /search /rank /latest /filters
 *       /browse /episodes /play /stream /video_url /img
 *       /download /prewarm /stats /metrics/batch /admin/keys
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const KeyStore = require('./core/keystore');
const Safeguards = require('./core/safeguards');
const Client = require('./service/client');
const Download = require('./service/download');
const BrowseFilters = require('./service/browse-filters');
const SiteSource = require('./service/site-source');
const Res = require('./service/res');
const Stream = require('./service/stream');
const Http = require('./util/http');
const Json = require('./util/json');
const Config = require('./util/config');
const Log = require('./util/log');
const { LruCache } = require('./util/common');

/** 免鉴权路径。 */
const EXEMPT = new Set(['/', '/ui', '/img', '/favicon.ico', '/health', '/api-key']);

/** 触发空闲清理的桶数量阈值：HG_RATE_BUCKETS_MAX，默认 4096。 */
const RATE_BUCKETS_MAX = Config.num('runtime.rate_buckets_max', 4096);

/** 桶空闲多久后回收：HG_RATE_BUCKET_IDLE_MS，默认 10 分钟。 */
const RATE_BUCKET_IDLE_MS = Config.num('runtime.rate_bucket_idle_ms', 600) * 1000;

/** 图片代理允许的域名。 */
const IMG_HOSTS = ['fqnovelpic.com', 'byteimg.com', 'qznovelvod.com', 'douyinpic.com', 'pstatp.com'];

/**
 * 图片字节缓存（访问序 LRU + 字节上限）。
 *
 * 历史问题：只按「条数 < 1000」判断能否写入，却从不淘汰，且完全不考虑单张
 * 图片的字节大小（HEIC 封面可达数百 KB）。现在改为 LRU + 字节上限。
 */
/** 图片缓存字节上限：HG_IMG_CACHE_MAX_MB，默认 64MB。 */
const IMG_CACHE_MAX_BYTES = Config.num('runtime.cache.img_max_mb', 64) * 1024 * 1024;

/** 单张图片上限：HG_IMG_MAX_KB，默认 4MB，超限不缓存。 */
const IMG_MAX_BYTES = Config.num('runtime.cache.img_max_kb', 4096) * 1024;

/** 图片缓存：无 TTL，仅受字节上限约束（实现见 util/common.LruCache）。 */
const imgCache = new LruCache({
  maxBytes: IMG_CACHE_MAX_BYTES,
  maxItemBytes: IMG_MAX_BYTES,
  weigh: (b) => b.length,
});

function imgCacheGet(url) {
  return imgCache.get(url);
}

function imgCachePut(url, data) {
  imgCache.setForever(url, data);
}

class Server {
  constructor() {
    this.keys = KeyStore.store();

    // 管理口令优先级：环境变量 > apikeys.json 的 admin_token > 首次生成并写回文件。
    // 不设环境变量时以文件为准，重启后沿用同一个值（早期版本每次启动
    // 随机生成，重启即失效，脚本化的管理调用无法稳定使用）。
    const tok = Log.env('ADMIN_TOKEN', null);
    let fresh = false;
    if (tok !== null && tok !== undefined && tok !== '') {
      this._adminToken = tok;
    } else {
      this._adminToken = this.keys.ensureAdminToken();
      fresh = this.keys.adminTokenFresh();
    }
    this._adminTokenFresh = fresh;
    this.ratePerMin = Log.envInt('RATE_PER_MIN', 120);

    const wd = Log.env('WEB_DIR', null);
    this.webDir = (wd !== null && wd !== undefined) ? wd : path.join(process.cwd(), 'web');

    this.startTime = Date.now();
    this.buckets = new Map();
    this.stats = { requests: 0, errors: 0, risk: 0, authFail: 0 };
    this.httpServer = null;
  }

  /** 管理口令。 */
  adminToken() { return this._adminToken; }

  /** 本次启动的管理口令是否为新生成（控制台据此决定是否提示）。 */
  adminTokenFresh() { return this._adminTokenFresh; }

  /**
   * 首次启动自动签发一把本地链路密钥，避免用户手动配置。
   * 已有密钥时返回 null（不打扰）。
   */
  ensureBootstrap() {
    return this.keys.ensureBootstrap();
  }

  // ==================== 启动 ====================

  /**
   * 创建并启动 HTTP 服务。
   * 返回 Promise，resolve 出底层 http.Server（listen 成功后）。
   */
  start(host, port) {
    this.httpServer = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        Log.error('未捕获的处理异常: ' + (e && e.message ? e.message : e), e);
        try { Res.fail(req, res, 500, 'internal error'); } catch (e2) { /* headers sent */ }
      });
    });
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, () => {
        Log.info('红果短剧 Web API  http://' + host + ':' + port);
        Log.info('前端页面        http://' + host + ':' + port + '/ui');
        this.scheduleWarm();
        resolve(this.httpServer);
      });
    });
  }

  /**
   * 后台预热：让「筛选面板 / 默认浏览 / 热播榜」几乎总是命中缓存，
   * 用户进页即出数据。间隔小于官网页缓存 TTL，缓存不会出现空窗。
   * 单项失败只记日志；定时器 unref，不阻止进程退出。
   */
  scheduleWarm() {
    const warm = async () => {
      const jobs = [
        ['filters:comic', () => Client.filters('comic_series')],
        ['filters:ai', () => Client.filters('ai_series')],
      ];
      if (SiteSource.enabled()) {
        jobs.push(['site:browse:comic', () => SiteSource.browsePage('comic_series', 1)]);
        jobs.push(['site:browse:ai', () => SiteSource.browsePage('ai_series', 1)]);
        jobs.push(['site:rank:hot', () => SiteSource.rankPage('hot', 1)]);
      }
      for (const [name, job] of jobs) {
        try {
          await job();
        } catch (e) {
          SiteSource.logAndSwallow('预热失败 ' + name + ': ', e);
        }
      }
    };
    const WARM_INTERVAL_MS = 120000;
    const timer = setInterval(() => { warm(); }, WARM_INTERVAL_MS);
    timer.unref();
    // 启动后稍等网络/上游就绪再预热首轮
    const first = setTimeout(() => { warm(); }, 1500);
    first.unref();
  }

  /**
   * 签名后端状态（/health 与 /stats 用）。
   *
   * 保持「数组 + ready 字段」的形状：签名恒由进程内 PureSign 纯代码计算，
   * 因此只有一个恒就绪的条目。
   */
  static signBackends() {
    const m = Json.obj();
    m.url = 'local';
    m.ready = true;
    m.probe = 'pure-sign';
    return [m];
  }

  // ==================== 主处理 ====================

  async handle(req, res) {
    try {
      const rawUrl = req.url || '/';
      const qIdx = rawUrl.indexOf('?');
      const rawPath = qIdx >= 0 ? rawUrl.substring(0, qIdx) : rawUrl;
      const rawQuery = qIdx >= 0 ? rawUrl.substring(qIdx + 1) : null;
      let pathname;
      try {
        pathname = Http.urldecode(rawPath);
      } catch (e) {
        pathname = rawPath;
      }
      const method = req.method;
      const q = Http.parseQuery(rawQuery);

      // CORS 预检
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,HEAD,POST,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'content-type,x-api-key,x-admin-token,range',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }

      // 静态资源优先：前端页面与 JS/CSS 不参与 API 鉴权
      if (method === 'GET' && Res.isStaticPath(pathname)) {
        await Res.serveStatic(req, res, pathname, this.webDir);
        return;
      }

      // 鉴权：管理/统计自行校验；静态资源与健康检查免鉴权
      if (!EXEMPT.has(pathname) && !pathname.startsWith('/admin')
          && pathname !== '/stats') {
        let key = header(req, 'x-api-key');
        if (key === null || key === '') key = q.api_key !== undefined ? q.api_key : '';
        if (!this.keys.isValid(key)) {
          this.stats.authFail++;
          Res.fail(req, res, 401, '缺少或无效的 api_key'
            + '（请在客户端配置本地链路密钥；首次访问可先请求 /api-key）');
          return;
        }
        if (!this.rateLimit(key)) {
          Res.fail(req, res, 429, '超过限流 ' + this.ratePerMin + '/分钟');
          return;
        }
        this.stats.requests++;
      }

      await this.route(req, res, method, pathname, q);

    } catch (e) {
      this.stats.errors++;
      if (e instanceof Safeguards.RiskControlError) this.stats.risk++;
      const isAuth = e instanceof Safeguards.AuthExpiredError;
      const m = Json.obj();
      m.detail = String(e && e.message !== null && e.message !== undefined ? e.message : e);
      if (e instanceof Safeguards.ApiError) {
        if (e.safeResponse !== null && e.safeResponse !== undefined) m.safe_response = e.safeResponse;
        if (e.diagnostic !== null && e.diagnostic !== undefined) m.response = e.diagnostic;
        if (e.modelShape !== null && e.modelShape !== undefined) m.model_shape = e.modelShape;
      }
      Res.json(req, res, isAuth ? 401 : 502, m);
    }
  }

  /**
   * 限流。
   *
   * key 为 api_key；每个桶保存最近 60s 的时间戳。桶数超阈值时顺带淘汰空闲桶。
   */
  rateLimit(key) {
    const now = Date.now();
    if (this.buckets.size > RATE_BUCKETS_MAX) this.sweepBuckets(now);

    let arr = this.buckets.get(key);
    if (arr === undefined) {
      arr = [];
      this.buckets.set(key, arr);
    }
    // 原地压缩：保留最近 60s 内的记录
    let n = 0;
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i];
      if (t > now - 60000) arr[n++] = t;
    }
    arr.length = n;
    if (n >= this.ratePerMin) {
      // 已超限
      return false;
    }
    arr.push(now);
    return true;
  }

  /** 淘汰空闲超时的桶。 */
  sweepBuckets(now) {
    for (const [k, arr] of this.buckets) {
      let newest = 0;
      for (const t of arr) if (t > newest) newest = t;
      if (now - newest > RATE_BUCKET_IDLE_MS) this.buckets.delete(k);
    }
  }

  checkAdmin(req, q) {
    let tok = header(req, 'x-admin-token');
    if (tok === null || tok === '') tok = q.admin_token !== undefined ? q.admin_token : '';
    return tok !== '' && tok === this._adminToken;
  }

  // ==================== 路由分发 ====================

  async route(req, res, method, pathname, q) {
    // ---- 无需鉴权的基础接口 ----
    if (method === 'GET' && pathname === '/') {
      const m = Json.obj();
      m.service = '红果短剧 Web API';
      m.ui = '/ui';
      m.managed = Client.MANAGED;
      m.endpoints = [
        '/search?q=', '/rank?board=recommend|hot|new&limit=',
        '/latest?genre=short_play|comic_series|ai_series&only_today=true',
        '/filters?genre=short_play',
        '/browse?genre=ai_series&theme=玄幻&sort=hot_score&days=7',
        '/episodes?series_id=', '/play?series_id=&ep=1-10',
        '/stream?series_id=&ep=1', '/stream?vid=&quality=1080p',
        '/prewarm?vid=', '/stats',
        '/download/task（POST {series_id,start,end} 批量下载剧集）',
      ];
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/health') {
      const m = Json.obj();
      m.ok = true;
      m.uptime_s = Math.floor((Date.now() - this.startTime) / 1000);
      m.sign_backends = Server.signBackends();
      m.api_host = Client.HOST;
      m.ffmpeg = Stream.ffmpegAvailable();
      m.transcode = Stream.transcodeEnabled();
      m.h264_encoder = Stream.h264EncoderName();
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/api-key') {
      let k = this.keys.firstEnabled();
      if (k === null) {
        const nk = this.keys.generate('auto');
        k = this.keys.get(nk);
      }
      const m = Json.obj();
      m.api_key = k.key;
      m.note = k.note;
      m.rate_per_min = this.ratePerMin;
      Res.json(req, res, 200, m);
      return;
    }

    // ---- 数据接口 ----
    if (method === 'GET' && (pathname === '/search' || pathname === '/search/page')) {
      const query = q.q !== undefined ? q.q : '';
      if (query === '') {
        Res.fail(req, res, 400, '缺少 q');
        return;
      }
      const lim = q.limit;
      const searchOff = Number.parseInt(q.offset !== undefined ? q.offset : '0', 10);
      const searchLimit = (lim === null || lim === undefined || lim === '')
        ? 0 : Number.parseInt(lim, 10);
      const m = Json.obj();
      m.query = query;
      // 首屏与续页走同一套逻辑，避免首屏拿不到 has_more 时前端只能乐观假设
      // 「还有更多」，结果总数不足一页时要多点一次才知道到底。
      const pg = await Client.searchPage(query, searchLimit, searchOff);
      m.count = pg.items.length;
      m.results = pg.items;
      m.has_more = pg.hasMore;
      m.next_offset = pg.nextSkip;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/rank') {
      const board = q.board !== undefined ? q.board : 'recommend';
      const limit = Number.parseInt(q.limit !== undefined ? q.limit : '30', 10);
      if (!Object.prototype.hasOwnProperty.call(Client.RANK_BOARDS, board)) {
        Res.fail(req, res, 400, 'board 必须是 ' + Object.keys(Client.RANK_BOARDS).join('|'));
        return;
      }
      // 首屏也返回上游游标与会话，续页必须沿用同一榜单快照。
      const offset = Number.parseInt(q.offset !== undefined ? q.offset : '0', 10);
      // 官网热播榜快路径：单次 SSR 请求拿整页（0.4s 级），替代 App 接口
      // 的多轮串行分页；续页沿用 site 会话，offset 即官网页码。
      // 首页失败安全回落 App 接口；翻页失败如实报错，避免两套分页混用。
      const siteSession = q.session_id === SiteSource.SITE_SESSION;
      if (SiteSource.enabled()
        && (siteSession || SiteSource.BOARD_TO_RANK[board] !== undefined)) {
        try {
          const pageNo = siteSession ? Math.max(1, Math.max(0, offset || 0)) : 1;
          const sp = await SiteSource.rankPage(board, pageNo);
          const sm = Json.obj();
          sm.board = board;
          sm.name = Client.RANK_NAMES[board];
          sm.items = sp.items;
          sm.has_more = sp.hasMore;
          sm.next_offset = sp.nextPage;
          sm.session_id = SiteSource.SITE_SESSION;
          sm.source = 'site';
          Res.json(req, res, 200, sm);
          return;
        } catch (e) {
          if (siteSession) {
            Res.fail(req, res, 502, '官网榜单页加载失败，请稍后重试');
            return;
          }
          SiteSource.logAndSwallow('官网榜单快路径失败，回落 App 接口: ', e);
        }
      }
      const m = Json.obj();
      m.board = board;
      m.name = Client.RANK_NAMES[board];
      const pg = await Client.rankPage(board, limit, Math.max(0, offset || 0), q.session_id || '');
      m.items = pg.items;
      m.has_more = pg.hasMore;
      m.next_offset = pg.nextOffset;
      m.session_id = pg.sessionId;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/latest') {
      const genre = q.genre !== undefined ? q.genre : 'short_play';
      if (!Object.prototype.hasOwnProperty.call(Client.GENRES, genre)) {
        Res.fail(req, res, 400, 'genre 必须是 ' + Object.keys(Client.GENRES).join('|'));
        return;
      }
      const onlyToday = q.only_today !== 'false';
      const limit = Number.parseInt(q.limit !== undefined ? q.limit : '120', 10);
      const refresh = q.refresh === 'true' || q.no_cache === 'true';
      const mode = genre === 'short_play'
        ? (onlyToday ? '今日上新' : '最新上架')
        : '7天内上新·最新上架';
      const m = Json.obj();
      m.genre = genre;
      m.name = Client.GENRE_NAMES[genre];
      m.mode = mode;
      m.only_today = onlyToday;
      // offset>0 或带 seen 走分页路径；前端把已看过的 series_id 以逗号串回传，
      // 上游据此去重，因此续页内容不会与前面重复
      const offset = Number.parseInt(q.offset !== undefined ? q.offset : '0', 10);
      const seenRaw = q.seen;
      let seen = null;
      if (seenRaw !== undefined && seenRaw !== null && seenRaw !== '') {
        seen = seenRaw.split(',');
      }
      if (offset > 0 || seen !== null) {
        const pg = await Client.latestPage(genre, onlyToday, limit, refresh, seen, offset);
        m.count = pg.items.length;
        m.items = pg.items;
        m.has_more = pg.hasMore;
        m.next_offset = pg.nextSkip;
      } else {
        const items = await Client.latest(genre, onlyToday, limit, refresh);
        m.count = items.length;
        m.items = items;
      }
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/filters') {
      const genre = q.genre !== undefined ? q.genre : 'short_play';
      if (!Object.prototype.hasOwnProperty.call(Client.GENRES, genre)) {
        Res.fail(req, res, 400, 'genre 必须是 ' + Object.keys(Client.GENRES).join('|'));
        return;
      }
      const rows = await Client.filters(genre);
      const m = Json.obj();
      m.genre = genre;
      m.name = Client.GENRE_NAMES[genre];
      m.rows = rows;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/browse') {
      const genre = q.genre !== undefined ? q.genre : 'short_play';
      if (!Object.prototype.hasOwnProperty.call(Client.GENRES, genre)) {
        Res.fail(req, res, 400, 'genre 必须是 ' + Object.keys(Client.GENRES).join('|'));
        return;
      }
      // 官网快路径：只选体裁且按「最热」排序时，单次 SSR 页面即拿到整页
      // 结果（0.4s 级），替代 App 接口凑 60 条要串行 4 轮的上游分页。
      // 一旦带细筛选条件（主题/设定/背景/受众/完结/上新/时长）或收藏排序，
      // 自动回落 App 接口，8 维筛选能力保持不变。
      const siteSession = q.session_id === SiteSource.SITE_SESSION;
      const hasDetailed = ['theme', 'setting', 'background', 'gender', 'days', 'status', 'duration']
        .some((k) => q[k] !== undefined && q[k] !== '');
      if (SiteSource.enabled() && q.sort === 'hot_score' && !hasDetailed
        && (siteSession || SiteSource.GENRE_TO_CATEGORY[genre] !== undefined)) {
        try {
          const pageNo = siteSession
            ? Math.max(1, Math.max(0, Number.parseInt(q.offset || '0', 10) || 0))
            : 1;
          const sp = await SiteSource.browsePage(genre, pageNo);
          for (const it of sp.items) {
            it.stream_url = it.vid !== ''
              ? '/stream?vid=' + it.vid
              : '/stream?series_id=' + it.series_id + '&ep=1';
            it.episodes_url = '/episodes?series_id=' + it.series_id;
          }
          const sm = Json.obj();
          sm.genre = genre;
          sm.name = Client.GENRE_NAMES[genre];
          sm.count = sp.items.length;
          sm.items = sp.items;
          sm.has_more = sp.hasMore;
          sm.next_offset = sp.nextPage;
          sm.session_id = SiteSource.SITE_SESSION;
          sm.source = 'site';
          Res.json(req, res, 200, sm);
          return;
        } catch (e) {
          if (siteSession) {
            Res.fail(req, res, 502, '官网分类页加载失败，请稍后重试');
            return;
          }
          SiteSource.logAndSwallow('官网分类页快路径失败，回落 App 接口: ', e);
        }
      }
      const opts = {};
      for (const k of ['theme', 'setting', 'background', 'sort',
        'gender', 'days', 'status', 'limit']) {
        if (Object.prototype.hasOwnProperty.call(q, k)) opts[k] = q[k];
      }
      if (!BrowseFilters.validDuration(q.duration)) {
        Res.fail(req, res, 400, '无效时长范围'); return;
      }
      const offset = Math.max(0, Number.parseInt(q.offset || '0', 10) || 0);
      const seen = q.seen ? q.seen.split(',') : [];
      const rawPage = await Client.browsePage(genre, opts, seen, offset, q.session_id || '');
      const page = BrowseFilters.filterDurationPage(rawPage, q.duration);
      const items = page.items, hasMore = page.hasMore, nextOffset = page.nextSkip;
      // 补上播放与剧集入口
      for (const itObj of items) {
        const it = Json.optObj(itObj);
        if (it === null) continue;
        const sid = Json.optStr(it.series_id, '');
        const vid = Json.optStr(it.vid, '');
        it.stream_url = vid !== '' ? '/stream?vid=' + vid
          : '/stream?series_id=' + sid + '&ep=1';
        it.episodes_url = '/episodes?series_id=' + sid;
      }
      const m = Json.obj();
      m.genre = genre;
      m.name = Client.GENRE_NAMES[genre];
      m.count = items.length;
      m.items = items;
      m.has_more = hasMore;
      m.next_offset = nextOffset;
      m.session_id = page.sessionId || '';
      if (page.warning) m.warning = page.warning;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/episodes') {
      const sid = q.series_id;
      if (sid === undefined || sid === null || sid === '') {
        Res.fail(req, res, 400, '缺少 series_id');
        return;
      }
      Res.json(req, res, 200, await Client.getEpisodes(sid));
      return;
    }

    if (method === 'POST' && pathname === '/metrics/batch') {
      const payload = await readJson(req);
      let raw = Object.prototype.hasOwnProperty.call(payload, 'series_ids')
        ? payload.series_ids : payload.series_id;
      if (raw === undefined) raw = null;
      const ids = [];
      if (Array.isArray(raw)) {
        for (const o of raw) ids.push(String(o).trim());
      } else {
        const sp = Http.splitCsv(String(raw));
        if (sp !== null) ids.push(...sp);
      }
      const filtered = ids.filter((s) => s !== '');
      if (filtered.length === 0) {
        Res.fail(req, res, 400, 'series_ids 不能为空');
        return;
      }
      if (filtered.length > 200) {
        Res.fail(req, res, 400, 'series_ids 最多 200 个');
        return;
      }
      const r = await Client.getEpisodesBatch(filtered, Json.optInt(payload.batch_size, 20));
      const items = r[0];
      const rows = [];
      for (const sid of filtered) {
        if (Object.prototype.hasOwnProperty.call(items, sid)) rows.push(items[sid]);
      }
      const m = Json.obj();
      m.count = rows.length;
      m.items = rows;
      m.failed = r[1];
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/play') {
      const sid = q.series_id;
      if (sid === undefined || sid === null || sid === '') {
        Res.fail(req, res, 400, '缺少 series_id');
        return;
      }
      const meta = await Client.getEpisodes(sid);
      const eps = Json.optArr(meta.episodes);
      const want = parseRange(q.ep !== undefined ? q.ep : 'all', eps.length);

      const sel = [];
      for (const eObj of eps) {
        const e = Json.optObj(eObj);
        if (e !== null && want.has(Json.optLong(e.index, 0))) {
          sel.push(e);
        }
      }
      const out = [];
      for (const e of sel) {
        const vid = Json.optStr(e.vid, '');
        const info = await urlInfo(vid);
        const row = Json.obj();
        row.index = Json.optLong(e.index, 0);
        row.vid = vid;
        row.title = Json.optStr(e.title, '');
        row.duration = Json.optLong(e.duration, 0);
        row.encrypted_url = info.url;
        row.backup = info.backup;
        row.size = info.size;
        row.definition = info.definition;
        row.url_is_http = info.url_is_http;
        row.stream_url = '/stream?vid=' + vid;
        out.push(row);
      }
      const m = Json.obj();
      m.series_id = sid;
      m.title = Json.optStr((Json.optObj(meta.meta) || {}).title, '');
      m.note = 'encrypted_url 为上游直链（加密集为 CENC 密文）；'
        + '可播放用 stream_url（服务端纯离线解密）';
      m.episodes = out;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/prewarm') {
      const vid = q.vid;
      if (vid === undefined || vid === null || vid === '') {
        Res.fail(req, res, 400, '需 vid');
        return;
      }
      const state = await Stream.prewarm(vid, q.quality !== undefined ? q.quality : 'best');
      const m = Json.obj();
      m.ok = true;
      m.vid = vid;
      m.state = state;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/video_url') {
      const vid = q.vid;
      if (vid === undefined || vid === null || vid === '') {
        Res.fail(req, res, 400, '缺少 vid');
        return;
      }
      const info = await urlInfo(vid);
      if (info.url === null || info.url === undefined) {
        Res.fail(req, res, 404, '无直链');
        return;
      }
      const m = Json.obj();
      m.vid = vid;
      m.url = info.url;
      m.size = info.size;
      m.definition = info.definition;
      Res.json(req, res, 200, m);
      return;
    }

    if (method === 'GET' && pathname === '/stream') {
      await this.handleStream(req, res, q);
      return;
    }

    if (method === 'GET' && pathname === '/img') {
      await handleImg(req, res, q);
      return;
    }

    if (method === 'GET' && pathname === '/download') {
      let vid = q.vid;
      const sid = q.series_id;
      if ((vid === undefined || vid === null || vid === '')
          && (sid === undefined || sid === null || sid === '')) {
        Res.fail(req, res, 400, '需 vid 或 series_id');
        return;
      }
      if (sid !== undefined && sid !== null && sid !== '' && (vid === undefined || vid === null || vid === '')) {
        const meta = await Client.getEpisodes(sid);
        const idx = Number.parseInt(q.ep !== undefined ? q.ep : '1', 10);
        for (const eObj of Json.optArr(meta.episodes)) {
          const e = Json.optObj(eObj);
          if (e !== null && Json.optLong(e.index, 0) === idx) {
            vid = Json.optStr(e.vid, '');
            break;
          }
        }
      }
      const file = await Stream.ensureDecrypted(vid, q.quality !== undefined ? q.quality : 'best');
      const m = Json.obj();
      m.ok = true;
      m.path = file;
      m.size = fs.statSync(file).size;
      Res.json(req, res, 200, m);
      return;
    }

    // ---- 批量下载剧集（任务制）----
    // POST /download/task  启动任务：{series_id, start?, end?}，后台执行，立即返回任务快照
    // GET  /download/task?id=  查询进度：done/total/failed/status
    if (pathname === '/download/task') {
      if (method === 'POST') {
        const payload = await readJson(req);
        const sid = payload.series_id !== undefined && payload.series_id !== null
          ? String(payload.series_id).trim() : '';
        if (sid === '') {
          Res.fail(req, res, 400, '缺少 series_id');
          return;
        }
        const startEp = intOrNull(payload.start);
        const endEp = intOrNull(payload.end);
        let t;
        try {
          t = await Download.start(sid, startEp, endEp);
        } catch (e) {
          Res.fail(req, res, 400, String(e && e.message !== undefined ? e.message : e));
          return;
        }
        const m = Json.obj();
        m.ok = true;
        m.task = Download.snapshot(t);
        Res.json(req, res, 200, m);
        return;
      }
      if (method === 'GET') {
        const id = q.id !== undefined ? q.id : '';
        const t = Download.get(String(id));
        if (t === null) {
          Res.fail(req, res, 404, '任务不存在或已过期');
          return;
        }
        const m = Json.obj();
        m.ok = true;
        m.task = Download.snapshot(t);
        Res.json(req, res, 200, m);
        return;
      }
    }

    if (method === 'GET' && pathname === '/stats') {
      if (!this.checkAdmin(req, q)) {
        Res.fail(req, res, 401, '需要 admin_token');
        return;
      }
      const m = Json.obj();
      m.uptime_s = Math.floor((Date.now() - this.startTime) / 1000);
      m.requests = this.stats.requests;
      m.errors = this.stats.errors;
      m.risk = this.stats.risk;
      m.auth_fail = this.stats.authFail;
      m.cache_backend = 'memory';
      m.sign_backends = Server.signBackends();
      m.enabled_keys = this.keys.countEnabled();
      Res.json(req, res, 200, m);
      return;
    }

    // ---- 管理接口 ----
    if (pathname.startsWith('/admin/keys')) {
      if (!this.checkAdmin(req, q)) {
        Res.fail(req, res, 401, 'admin_token 无效');
        return;
      }
      if (method === 'GET' && pathname === '/admin/keys') {
        const m = Json.obj();
        m.keys = this.keys.list();
        m.enabled_count = this.keys.countEnabled();
        Res.json(req, res, 200, m);
        return;
      }
      if (method === 'POST' && pathname === '/admin/keys') {
        const note = q.note !== undefined ? q.note : '';
        const key = this.keys.generate(note);
        const m = Json.obj();
        m.ok = true;
        m.key = key;
        m.note = note;
        Res.json(req, res, 200, m);
        return;
      }
      if (method === 'POST' && pathname === '/admin/keys/revoke') {
        const k = q.key !== undefined ? q.key : '';
        const enable = q.enable === 'true';
        const m = Json.obj();
        m.ok = this.keys.revoke(k, enable);
        Res.json(req, res, 200, m);
        return;
      }
      if (method === 'DELETE' && pathname === '/admin/keys') {
        const m = Json.obj();
        m.ok = this.keys.delete(q.key !== undefined ? q.key : '');
        Res.json(req, res, 200, m);
        return;
      }
    }

    // GET 兜底：静态资源 / 404
    if (method === 'GET') {
      await Res.serveStatic(req, res, pathname, this.webDir);
      return;
    }
    Res.fail(req, res, 404, 'not found');
  }

  /**
   * 处理 /stream：定位集号 -> 确保解密 -> Range 串流。
   */
  async handleStream(req, res, q) {
    let vid = q.vid;
    let filename = null;

    if (vid === undefined || vid === null || vid === '') {
      const sid = q.series_id;
      if (sid === undefined || sid === null || sid === '') {
        Res.fail(req, res, 400, '需 series_id+ep 或 vid');
        return;
      }
      const meta = await Client.getEpisodes(sid);
      const epStr = q.ep !== undefined ? q.ep : '1';
      const idx = /^\d+$/.test(epStr) ? Number.parseInt(epStr, 10) : 1;
      let targetVid = null;
      let title = '';
      for (const eObj of Json.optArr(meta.episodes)) {
        const e = Json.optObj(eObj);
        if (e !== null && Json.optLong(e.index, 0) === idx) {
          targetVid = Json.optStr(e.vid, '');
          break;
        }
      }
      if (targetVid === null) {
        Res.fail(req, res, 404, '集号不存在');
        return;
      }
      vid = targetVid;
      title = Json.optStr((Json.optObj(meta.meta) || {}).title, '');
      filename = Client.sanitize(title) + '_第'
        + String(idx).padStart(3, '0') + '集.mp4';
    }

    const quality = q.quality !== undefined ? q.quality : 'best';
    const file = await Stream.ensureDecrypted(vid, quality);
    if (filename === null) filename = vid + '.mp4';
    await Res.streamFile(req, res, file, vid, filename);
  }
}

/**
 * 单集取直链信息（url / size / definition / url_is_http）。
 *
 * 统一走 Stream.videoTrack（AppSource 的 b 域名 multi_video_model/v1 链路）。
 * 取不到时返回空对象（调用方按「无直链」处理），异常只记日志不外抛，
 * 避免一个坏集带垮整个 /play 列表。
 */
async function urlInfo(vid) {
  const info = Json.obj();
  if (vid === null || vid === undefined || vid === '') return info;
  try {
    const t = await Stream.videoTrack(vid, 'best');
    if (t === null || t === undefined || t.url === null || t.url === undefined || t.url === '') {
      return info;
    }
    info.url = t.url;
    info.size = t.size;
    info.definition = t.definition;
    info.url_is_http = String(t.url).startsWith('http');
  } catch (e) {
    Log.warn('取直链失败 (' + vid + '): ' + (e && e.message ? e.message : e));
  }
  return info;
}

/**
 * 图片代理：红果封面常为 HEIC，浏览器不支持；此处透传。
 */
async function handleImg(req, res, q) {
  const raw = (q.url !== undefined ? q.url : '').trim();
  let uri;
  try {
    uri = new URL(raw);
  } catch (e) {
    Res.fail(req, res, 400, '图片 URL 非法');
    return;
  }
  const scheme = uri.protocol;
  const host = (uri.hostname || '').toLowerCase();
  let hostOk = false;
  for (const h of IMG_HOSTS) {
    if (host === h || host.endsWith('.' + h)) {
      hostOk = true;
      break;
    }
  }
  if ((scheme !== 'http:' && scheme !== 'https:') || !hostOk) {
    Res.fail(req, res, 400, '图片域名不允许');
    return;
  }
  const hit = imgCacheGet(raw);
  if (hit !== null) {
    Res.send(req, res, 200, hit, Res.headers('image/jpeg', 'max-age=86400'));
    return;
  }
  try {
    const r = await Http.send({
      url: raw,
      method: 'GET',
      headers: { 'user-agent': 'Mozilla/5.0' },
      timeoutMs: 30000,
    });
    if (!r.ok()) {
      Res.fail(req, res, 404, '图片读取失败 HTTP ' + r.status);
      return;
    }
    let ct = r.header('content-type');
    if (ct === null || ct === undefined) ct = 'image/jpeg';
    ct = ct.toLowerCase();
    const data = r.body;
    imgCachePut(raw, data);
    Res.send(req, res, 200, data, Res.headers(
      ct.includes('heic') ? 'image/jpeg' : ct, 'max-age=86400'));
  } catch (e) {
    Res.fail(req, res, 404, '图片读取失败: ' + (e && e.message ? e.message : e));
  }
}

/** 解析集号参数：'1' / '1-10' / 'all' -> 集号集合。 */
function parseRange(ep, total) {
  const out = new Set();
  if (ep === null || ep === undefined || ep === '' || ep === 'all') {
    for (let i = 1; i <= total; i++) out.add(i);
    return out;
  }
  const m = /^(\d+)-(\d+)$/.exec(ep);
  if (m) {
    const a = Number.parseInt(m[1], 10);
    const b = Number.parseInt(m[2], 10);
    for (let i = a; i <= b; i++) out.add(i);
    return out;
  }
  if (/^\d+$/.test(ep)) {
    out.add(Number.parseInt(ep, 10));
  }
  return out;
}

/** 读取并解析 JSON 请求体。 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 1000000) {
        reject(new Error('body 过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (body.length === 0) {
        resolve(Json.obj());
        return;
      }
      try {
        resolve(Json.parseObject(body.toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** 取请求头的首个值；缺失返回 null。 */
function header(req, name) {
  const v = req.headers ? req.headers[String(name).toLowerCase()] : undefined;
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.length > 0 ? v[0] : null;
  return String(v);
}

/** 把请求体/参数里的集号转成整数；缺失或非法返回 null（调用方按「不限制」处理）。 */
function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

module.exports = { Server };
