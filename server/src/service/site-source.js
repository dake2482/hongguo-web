'use strict';

/**
 * 官网数据源：直接抓 hongguoduanju.com 的服务端渲染页面。
 *
 * App 签名接口一次最多返回 18 条且要逐页轮询，默认浏览一批要
 * 串行 4 轮上游请求（15s+）；官网分类页/榜单页一次 HTML 就带
 * 「列表 + 题材筛选 + 分页」，单次约 0.4s。解析思路移植自
 * jackotom/hongguo-drama 的 src/native/catalog.js，适配本仓库的
 * Http/Log/Safeguards 工具，保持零第三方依赖。
 *
 * 只读页面里内嵌的 JSON 字面量，绝不执行来源站的任何脚本。
 */

const Http = require('../util/http');
const Log = require('../util/log');
const Config = require('../util/config');
const Safeguards = require('../core/safeguards');

const DEFAULT_SITE = 'https://hongguoduanju.com';
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10000;
// 官网页缓存 240s：大于 server 的预热间隔(120s)，常规情况下缓存不会空窗。
const CACHE_TTL_SEC = 240;

/** 前端 genre → 官网分类路径段。short_play 供后续扩展，当前前端只暴露漫剧/AI。 */
const GENRE_TO_CATEGORY = {
  comic_series: 'comic-drama',
  ai_series: 'ai-drama',
  short_play: 'real-drama',
};

/** 官网只有各内容线的热播榜；推荐榜/新剧榜仍走 App 接口。 */
const BOARD_TO_RANK = {
  hot: 'hot-comic-drama',
};

/** 续页会话标记：路由层据此识别「这一页该继续向官网翻页」。 */
const SITE_SESSION = 'site';

const pending = new Map();

function siteHost() {
  return Config.str('site_source.host', DEFAULT_SITE).replace(/\/+$/, '');
}

function enabled() {
  return Config.bool('site_source.enabled', true);
}

function decodeHtml(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi,
    (all, key) => {
      if (key[0] !== '#') {
        return ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' })[key.toLowerCase()] || all;
      }
      const code = key[1].toLowerCase() === 'x'
        ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    });
}

/**
 * 读页面里的 window._ROUTER_DATA = {...}。只做括号配平切片后
 * JSON.parse，取到的永远是数据字面量，不会执行脚本。
 */
function readRouterData(html) {
  const match = String(html).match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{)/);
  if (!match) throw new Error('来源页面未返回目录数据');
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('来源目录数据不完整');
}

function normalizeCategoryItem(item, seen) {
  const id = String(item && item.series_id !== undefined ? item.series_id : '');
  const title = item && typeof item.series_name === 'string' ? item.series_name.trim() : '';
  if (!/^\d{6,}$/.test(id) || !title || seen.has(id)) return null;
  seen.add(id);
  const row = {
    series_id: id,
    title,
    cover: (item && typeof item.series_cover === 'string') ? item.series_cover : '',
    episode_cnt: Number(item && item.episode_cnt) || 0,
    score: '',
    play_cnt: 0,
    heat: item && typeof item.episode_right_text === 'string' ? item.episode_right_text.trim().slice(0, 40) : '',
    tags: Array.isArray(item && item.tags)
      ? item.tags.filter((t) => typeof t === 'string').slice(0, 4) : [],
    // 剧情简介与首集 vid：官网 SSR 页自带，供青少年文字初筛与直连播放使用
    category: '',
    abstract: (item && typeof item.series_intro === 'string')
      ? item.series_intro.trim().slice(0, 4000) : '',
    vid: (item && Array.isArray(item.vid_list) && item.vid_list[0]) ? String(item.vid_list[0]) : '',
  };
  return row;
}

/** 解析分类页：列表 + 题材(selectorList) + 分页。 */
function parseCategory(html, page) {
  const router = readRouterData(html);
  const data = Object.values(router.loaderData || {})
    .find((v) => v && v.categoryRoute && typeof v.categoryRoute.contentType === 'string'
      && v.categoryRoute.contentType.length > 0
      && typeof v.recommendList !== 'undefined') || Object.values(router.loaderData || {})
    .find((v) => v && Array.isArray(v.recommendList));
  if (!data || data.isSuccess === false) throw new Error('来源分类页暂不可用');
  const seen = new Set();
  const items = (Array.isArray(data.recommendList) ? data.recommendList : [])
    .map((it) => normalizeCategoryItem(it, seen)).filter(Boolean);
  if (items.length === 0) throw new Error('来源分类页没有可用作品');
  const genres = (Array.isArray(data.selectorList) ? data.selectorList : [])
    .flatMap((row) => (Array.isArray(row && row.items) ? row.items : []))
    .filter((it) => it && /^[a-z0-9-]+$/.test(String(it.selector_item_id || ''))
      && typeof it.show_name === 'string')
    .map((it) => ({ slug: it.selector_item_id, label: it.show_name }));
  const totalPages = Number(data.pagination && data.pagination.totalPages) || 1;
  const current = Number(data.pagination && data.pagination.pageNum) || page;
  return { items, genres, page: current, totalPages };
}

function normalizeRankItem(item, seen) {
  const id = String(item && (item.seriesId || item.series_id) || '');
  const title = item && typeof item.title === 'string' ? item.title.trim() : '';
  const rank = Number(item && item.rank);
  if (!/^\d{6,}$/.test(id) || !title || !Number.isSafeInteger(rank) || rank < 1 || seen.has(id)) return null;
  seen.add(id);
  return {
    rank,
    series_id: id,
    title,
    cover: (item && typeof item.cover === 'string' && /^https?:\/\//.test(item.cover)) ? item.cover : '',
    episode_cnt: Array.isArray(item && item.episodeVids) ? item.episodeVids.length
      : (Number(item && item.episode_cnt) || 0),
    score: '', play_cnt: 0,
    heat: (item && typeof item.heatText === 'string') ? item.heatText.trim().slice(0, 40) : '',
    tags: Array.isArray(item && item.tags)
      ? item.tags.filter((t) => typeof t === 'string').slice(0, 4) : [],
    category: '',
    abstract: (item && typeof item.abstract === 'string') ? item.abstract.trim().slice(0, 4000) : '',
    vid: '',
  };
}

/** 解析榜单页：优先流式 SSR 里的 mergeLoaderData 参数，缺失时回退语义化 HTML。 */
function parseRank(html, page) {
  let data;
  for (const script of String(html).matchAll(/<script\b([^>]*)>/gi)) {
    if (!/data-fn-name=["']mergeLoaderData["']/.test(script[1])) continue;
    const encoded = script[1].match(/data-fn-args=(?:"([^"]*)"|'([^']*)')/);
    if (!encoded) continue;
    try {
      const args = JSON.parse(decodeHtml(encoded[1] || encoded[2] || ''));
      if (!Array.isArray(args) || !Array.isArray(args[1])) continue;
      const content = args[1].find((it) => it && it.key === 'content'
        && it.routerDataFnName === 'p');
      if (content && content.routerDataFnArgs && content.routerDataFnArgs[0]) {
        data = JSON.parse(content.routerDataFnArgs[0]);
      }
    } catch (e) { /* 部分流式响应只有渲染后的卡片，走 HTML 回退 */ }
  }
  const seen = new Set();
  let items = (data && data.isSuccess !== false && Array.isArray(data.rankList))
    ? data.rankList.map((it) => normalizeRankItem(it, seen)).filter(Boolean) : [];
  if (items.length === 0) {
    const text = (v) => decodeHtml(String(v).replace(/<[^>]*>/g, ' ')).trim();
    for (const match of String(html).matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
      const article = match[1];
      const heading = article.match(/<h2\b[^>]*\bid=["']rank-title-(\d+)["'][^>]*>([\s\S]*?)<\/h2>/i);
      if (!heading || !article.includes('/detail?series_id=' + heading[1])) continue;
      const cover = article.match(/<img\b[^>]*\bsrc=(?:"([^"]*)"|'([^']*)')/i);
      const tags = article.match(/<p\b[^>]*class=["'][^"']*pc-categories-[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
      // 简介取正文里最长的 <p>：实测榜单卡片 p 依次为 热度 / 分类+集数 / 剧情简介
      let intro = '';
      for (const pm of article.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
        const pt = text(pm[1]);
        if (pt.length > 40 && pt.length > intro.length) intro = pt;
      }
      const it = normalizeRankItem({
        seriesId: heading[1],
        title: text(heading[2]),
        rank: (article.match(/<span\b[^>]*>\s*(\d+)\s*<\/span>/i) || [])[1],
        heatText: (text(article).match(/[\d.,]+\s*[万亿]?\s*热度/) || [])[0] || '',
        cover: cover ? decodeHtml(cover[1] || cover[2]) : '',
        tags: tags ? Array.from(tags[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi),
          (t) => text(t[1])) : [],
        abstract: intro,
      }, seen);
      if (it) items.push(it);
    }
  }
  if (items.length === 0) throw new Error('来源榜单页没有可用作品');
  const totalPages = Number(data && data.pagination && data.pagination.totalPages)
    || (items.length >= 20 ? Math.max(2, page) : page);
  const current = Number(data && data.pagination && data.pagination.pageNum) || page;
  return { items, page: current, totalPages };
}

async function fetchPage(url) {
  const res = await Http.send({
    url,
    method: 'GET',
    headers: {
      // 官网按浏览器 UA 返回 SSR 页面；带上常见头降低被风控概率
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    timeoutMs: TIMEOUT_MS,
  });
  const text = res.text();
  if (text.length > MAX_PAGE_BYTES) throw new Error('来源页面过大');
  return text;
}

/** 同 URL 并发去重 + TTL 缓存；每个 URL 独立请求，慢分类不排队。 */
async function cachedFetch(key, url, parse) {
  const cached = Safeguards.cacheGet(key);
  if (cached !== undefined && cached !== null) return cached;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    try {
      const data = parse(await fetchPage(url));
      Safeguards.cacheSet(key, data, CACHE_TTL_SEC);
      return data;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, task);
  return task;
}

/**
 * 官网分类页一页。返回 {items, page, totalPages, hasMore, nextPage}。
 */
async function browsePage(genre, pageArg) {
  const category = GENRE_TO_CATEGORY[genre];
  if (category === undefined) throw new Error('该体裁没有官网分类页');
  const page = Math.max(1, pageArg || 1);
  const url = siteHost() + '/category/' + category + (page > 1 ? '?page=' + page : '');
  const data = await cachedFetch(
    Safeguards.cacheKey('sitebrowse', genre, page), url,
    (html) => parseCategory(html, page));
  return {
    items: data.items,
    page: data.page,
    totalPages: data.totalPages,
    hasMore: data.page < data.totalPages,
    nextPage: data.page + 1,
  };
}

/** 官网榜单页一页，形状同 browsePage。 */
async function rankPage(board, pageArg) {
  const category = BOARD_TO_RANK[board];
  if (category === undefined) throw new Error('该榜单没有官网对应页');
  const page = Math.max(1, pageArg || 1);
  const url = siteHost() + '/rank/' + category + (page > 1 ? '?page=' + page : '');
  const data = await cachedFetch(
    Safeguards.cacheKey('siterank', board, page), url,
    (html) => parseRank(html, page));
  return {
    items: data.items,
    page: data.page,
    totalPages: data.totalPages,
    hasMore: data.page < data.totalPages,
    nextPage: data.page + 1,
  };
}

function logAndSwallow(prefix, err) {
  Log.warn(prefix + (err && err.message ? err.message : err));
}

module.exports = {
  SITE_SESSION,
  GENRE_TO_CATEGORY,
  BOARD_TO_RANK,
  enabled,
  browsePage,
  rankPage,
  logAndSwallow,
  // 供测试直接验证解析器
  readRouterData,
  parseCategory,
  parseRank,
  decodeHtml,
};
