'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Http=require('../server/src/util/http');
const Safeguards=require('../server/src/core/safeguards');
const Client=require('../server/src/service/client');
const endpoint='/reading/distribution/category/landpage/v';
async function mock(t,payload,inspect=()=>{}) {
 t.mock.method(Safeguards,'sleep',async()=>{});
 t.mock.method(Safeguards,'throttle',()=>({wait:async()=>{}}));
 // 测试间互不串缓存（filters 30 分钟缓存会污染后续用例）
 t.mock.method(Safeguards,'cacheGet',()=>undefined);
 return t.mock.method(Http,'send',async req=>{
  inspect(JSON.parse(req.body));
  return new Http.Resp(200,Buffer.from(typeof payload==='string'?payload:JSON.stringify(payload)));
 });
}
test('landpage requests are signed by default (HG_SIGN_LIST on since upstream 1.3.1)',async t=>{
 let sawSigned=false;
 await mock(t,{code:0,data:{selector_rows:[{type:'category_dim_theme',row_name:'主题',items:[{selector_item_id:'cate_7',show_name:'玄幻'}]}]}});
 // mock 里不便于断言头，改为直接检查：同一 mock 下的请求头
 const orig=Http.send;
 // re-mock 带头断言
 t.mock.method(Safeguards,'throttle',()=>({wait:async()=>{}}));
 const m=t.mock.method(Http,'send',async req=>{
  sawSigned=!!(req.headers['x-gorgon']&&req.headers['x-khronos']);
  return new Http.Resp(200,Buffer.from(JSON.stringify({code:0,data:{selector_rows:[{type:'category_dim_theme',row_name:'主题',items:[]}]}})));
 });
 await Client.filters('comic_series');
 m.mock.restore();
 assert.equal(sawSigned,true);
});
test('landpage empty/non-JSON payloads resolve empty silently (upstream 1.3.1 semantics; warm loop retries)',async t=>{
 for(const payload of ['', ' ', 'null']) {
  const send=await mock(t,payload);
  const rows=await Client.filters('comic_series');
  assert.deepEqual(rows,[]);assert.equal(send.mock.callCount(),1);
 }
});
test('valid-JSON but empty landpage data resolves empty without retries (upstream 1.3.1 semantics)',async t=>{
 for(const payload of [{code:0}, {code:0,data:{}}, {code:0,data:{selector_rows:[]}}]) {
  const send=await mock(t,payload);
  const rows=await Client.filters('comic_series');
  assert.deepEqual(rows,[]);assert.equal(send.mock.callCount(),1);
 }
});
test('valid selector options retain upstream IDs and labels',async t=>{
 await mock(t,{code:0,data:{selector_rows:[{type:'category_dim_theme',row_name:'主题',items:[{selector_item_id:'cate_7',show_name:'玄幻'}]}]}},body=>assert.equal(body.need_selector_panel,true));
 assert.deepEqual((await Client.filters('comic_series'))[0].items,[{id:'cate_7',name:'玄幻'}]);
});
test('valid empty category results stay empty without retries',async t=>{
 const send=await mock(t,{code:0,data:{video_data:[],has_more:false}});
 const page=await Client.browsePage('comic_series',{limit:1},[],0);
 assert.deepEqual(page.items,[]);assert.equal(page.hasMore,false);assert.equal(send.mock.callCount(),1);
});
test('browse sends selected categories, audience, status, time and sort with a signature',async t=>{
 await mock(t,{code:0,data:{video_data:[{series_id:'123',title:'测试',video_desc:'保留完整剧情简介',duration:4000}],has_more:false}},body=>{
  assert.deepEqual(body.select_items.category_dim_theme,['cate_7']);
  assert.deepEqual(body.select_items.category_dim_role,['role_test']);
  assert.deepEqual(body.select_items.category_dim_epoch,['epoch_test']);
  assert.deepEqual(body.select_items.gender,['gender_test']);
  assert.deepEqual(body.select_items.creation_status,['status_test']);
  assert.deepEqual(body.select_items.online_time,['days_7']);
  assert.deepEqual(body.select_items.sort,['hot_score']);
 });
 const p=await Client.browsePage('comic_series',{limit:1,theme:'cate_7',setting:'role_test',background:'epoch_test',gender:'gender_test',status:'status_test',days:'7',sort:'hot_score'},[],0);
 assert.equal(p.items[0].abstract,'保留完整剧情简介');assert.equal(p.items[0].duration,4000);
});
test('browse dedupes upstream repeats and keeps later-page failure warning for retry',async t=>{
 t.mock.method(Safeguards,'sleep',async()=>{});
 t.mock.method(Safeguards,'throttle',()=>({wait:async()=>{}}));
 let calls=0;
 t.mock.method(Http,'send',async req=>{
  calls++;
  if(calls===1)return new Http.Resp(200,Buffer.from(JSON.stringify({code:0,data:{video_data:[{series_id:'a',title:'A'},{series_id:'a',title:'A'}],has_more:true}})));
  const b=JSON.parse(req.body);
  assert.equal(b.filter_ids,'a');
  return new Http.Resp(200,Buffer.from(''));
 });
 const p=await Client.browsePage('comic_series',{limit:60},[],0);
 assert.deepEqual(p.items.map(x=>x.series_id),['a']);
 assert.equal(p.hasMore,true);
});
test('browse continuation passes seen ids and preserves empty-page cursor (no session since 1.3.1)',async t=>{
 await mock(t,{code:0,data:{video_data:[],has_more:false}},b=>{
  assert.equal(b.filter_ids,'a');assert.equal(b.offset,18);
 });
 const p=await Client.browsePage('comic_series',{limit:60},['a'],18);
 assert.deepEqual(p.items,[]);assert.equal(p.hasMore,false);
});
