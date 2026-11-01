'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Http = require('../server/src/util/http');
const SiteSource = require('../server/src/service/site-source');

function categoryHtml(over = {}) {
  const loader = {
    categoryRoute: { contentType: 'comic-drama' },
    isSuccess: true,
    recommendList: [
      { series_id: '7661620637298871321', series_name: '师尊无敌', series_cover: 'https://x/c1.jpg', episode_cnt: 97, tags: ['玄幻'] },
      { series_id: '123456', series_name: '  ', tags: [] },                          // 空标题应被过滤
      { series_id: 'abc', series_name: '坏ID', tags: [] },                           // 非数字ID应被过滤
      { series_id: '7661620637298871321', series_name: '重复ID', tags: [] },        // 去重
      { series_id: '7661620637298879999', series_name: '第二部', episode_right_text: '全 80 集', tags: ['都市', '恋爱'] },
    ],
    selectorList: [
      { items: [{ selector_item_id: 'xuanhuan', show_name: '玄幻' }, { selector_item_id: 'Bad Id', show_name: '坏slug' }] },
    ],
    pagination: { pageNum: 1, totalPages: 5 },
    ...over,
  };
  const router = { loaderData: { page: loader } };
  return '<html><script>window._ROUTER_DATA = ' + JSON.stringify(router) + ';</script></html>';
}

function rankHtmlEncoded(rankList, pagination) {
  const data = { isSuccess: true, rankList, pagination };
  const args = JSON.stringify([
    'rank_hot-comic-drama/page',
    [{ key: 'content', routerDataFnName: 'p', routerDataFnArgs: [JSON.stringify(data)] }],
  ]);
  const encoded = args.replace(/"/g, '&quot;');
  return '<html><script data-fn-name="mergeLoaderData" data-fn-args="' + encoded + '"></script></html>';
}

test('parseCategory 解析列表/题材/分页并过滤无效项', () => {
  const page = SiteSource.parseCategory(categoryHtml(), 1);
  assert.deepEqual(page.items.map((x) => x.series_id),
    ['7661620637298871321', '7661620637298879999']);
  assert.equal(page.items[0].title, '师尊无敌');
  assert.equal(page.items[1].episode_cnt, 0);
  assert.equal(page.items[1].heat, '全 80 集');
  assert.deepEqual(page.genres, [{ slug: 'xuanhuan', label: '玄幻' }]);
  assert.equal(page.totalPages, 5);
});

test('parseCategory 缺 _ROUTER_DATA 时抛错', () => {
  assert.throws(() => SiteSource.parseCategory('<html>empty</html>', 1), /未返回目录数据/);
});

test('parseRank 优先读流式 SSR 的 mergeLoaderData 参数', () => {
  const html = rankHtmlEncoded([
    { seriesId: '111111222222', title: '榜单第一', rank: 1, heatText: '1.2万热度', cover: 'https://x/c.jpg', tags: ['逆袭'] },
    { seriesId: '111111222222', title: '重复', rank: 2 },
    { seriesId: 'bad', title: '坏ID', rank: 3 },
  ], { pageNum: 2, totalPages: 4 });
  const page = SiteSource.parseRank(html, 2);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].rank, 1);
  assert.equal(page.items[0].heat, '1.2万热度');
  assert.equal(page.page, 2);
  assert.equal(page.totalPages, 4);
});

test('parseRank 无脚本数据时回退语义化 HTML 卡片', () => {
  const html = '<html><body>' +
    '<article><span>1</span><h2 id="rank-title-999999888888">回退标题</h2>' +
    '<a href="/detail?series_id=999999888888"></a>' +
    '<p class="pc-categories-x"><span>战神</span><span>逆袭</span></p></article>' +
    '</body></html>';
  const page = SiteSource.parseRank(html, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].series_id, '999999888888');
  assert.equal(page.items[0].title, '回退标题');
  assert.deepEqual(page.items[0].tags, ['战神', '逆袭']);
});

test('browsePage/rankPage 走 Http 拉取并按 TTL 缓存去重', async () => {
  const original = Http.send;
  let calls = 0;
  Http.send = async (req) => {
    calls++;
    assert.match(req.url, /hongguoduanju\.com\/category\/comic-drama/);
    return new Http.Resp(200, Buffer.from(categoryHtml()));
  };
  try {
    const first = await SiteSource.browsePage('comic_series', 1);
    assert.equal(first.items.length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextPage, 2);
    const second = await SiteSource.browsePage('comic_series', 1);
    assert.equal(calls, 1, '第二次应命中缓存不再发请求');
    assert.deepEqual(second.items.map((x) => x.series_id), first.items.map((x) => x.series_id));
  } finally {
    Http.send = original;
  }
});
