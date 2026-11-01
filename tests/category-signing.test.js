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
 return t.mock.method(Http,'send',async req=>{
  assert.ok(req.headers['x-gorgon']); assert.ok(req.headers['x-khronos']);
  inspect(JSON.parse(req.body));
  return new Http.Resp(200,Buffer.from(typeof payload==='string'?payload:JSON.stringify(payload)));
 });
}
test('category requests are signed even when list signing is disabled',async t=>{
 await mock(t,{code:0,data:{video_data:[],has_more:false}});
 const j=await Client.apiOnce('POST',endpoint,{need_selector_panel:false},null,false);
 assert.deepEqual(j.data.video_data,[]);
});
test('category failures are reported after bounded retries, not parsed as no results',async t=>{
 for(const payload of ['', ' ', 'null', {}, {code:0}, {code:0,data:{}}, {code:0,data:{video_data:{}}}, {code:0,data:{selector_rows:[]}}]) {
  await t.test(JSON.stringify(payload),async st=>{
   const send=await mock(st,payload);
   const action=payload?.data?.selector_rows ? ()=>Client.filters('comic_series') : ()=>Client.browsePage('comic_series',{limit:1},[],0);
   await assert.rejects(action,{name:'UpstreamResponseError'});
   assert.equal(send.mock.callCount(),3);
  });
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
test('browse uses upstream cursor and session, deduplicates and retains later-page failures for retry',async t=>{
 t.mock.method(Safeguards,'sleep',async()=>{});
 t.mock.method(Safeguards,'throttle',()=>({wait:async()=>{}}));
 let calls=0;
 t.mock.method(Http,'send',async req=>{
  const b=JSON.parse(req.body);calls++;
  if(calls===1)return new Http.Resp(200,Buffer.from(JSON.stringify({code:0,data:{session_id:'browse-session',next_offset:18,has_more:true,video_data:[{series_id:'a',title:'A'},{series_id:'a',title:'A'}]}})));
  assert.equal(b.offset,18);assert.equal(b.session_id,'browse-session');assert.equal(b.filter_ids,'a');
  return new Http.Resp(200,Buffer.from(''));
 });
 const p=await Client.browsePage('comic_series',{limit:60},[],0);
 assert.deepEqual(p.items.map(x=>x.series_id),['a']);assert.equal(p.nextSkip,18);
 assert.equal(p.sessionId,'browse-session');assert.equal(p.hasMore,true);assert.match(p.warning,/重试/);assert.equal(calls,4);
});
test('browse carries session into an explicit continuation and preserves an empty-page cursor',async t=>{
 await mock(t,{code:0,data:{video_data:[],next_offset:36,session_id:'browse-session',has_more:false}},b=>{
  assert.equal(b.offset,18);assert.equal(b.session_id,'browse-session');assert.equal(b.filter_ids,'a');
 });
 const p=await Client.browsePage('comic_series',{limit:60},['a'],18,'browse-session');
 assert.deepEqual(p.items,[]);assert.equal(p.nextSkip,36);assert.equal(p.hasMore,false);
});
