'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Http=require('../server/src/util/http');
const Safeguards=require('../server/src/core/safeguards');
const Client=require('../server/src/service/client');
const cell=(id,extra={})=>({video_data:{series_id:id,title:'作品'+id,...extra}});
function response(ids,more=true){
 return new Http.Resp(200,Buffer.from(JSON.stringify({data:{cell_view:{cell_data:ids.map(i=>Array.isArray(i)?i:cell(i)),has_more:more}}})));
}
test('rankPage 首页取 limit 条并去重上游重复',async t=>{
 t.mock.method(Safeguards,'sleep',async()=>{});
 t.mock.method(Safeguards,'throttle',()=>({wait:async()=>{}}));
 t.mock.method(Safeguards,'cacheGet',()=>undefined);
 const send=t.mock.method(Http,'send',async()=>response(['a','b','b','c']));
 const p=await Client.rankPage('hot',3,0);
 assert.deepEqual(p.items.map(x=>x.series_id),['a','b','c']);
 assert.equal(send.mock.callCount(),1);
 send.mock.restore();
});
test('rankPage 续页跳过已取条数并去重上游重复（filter_ids 机制，无 session）',async t=>{
 t.mock.method(Safeguards,'sleep',async()=>{});
 t.mock.method(Safeguards,'throttle',()=>({wait:async()=>{}}));
 t.mock.method(Safeguards,'cacheGet',()=>undefined);
 let calls=0;
 const filterIdsSeen=[];
 t.mock.method(Http,'send',async req=>{
  calls++;
  const q=new URL(req.url).searchParams;
  if(q.get('filter_ids')) filterIdsSeen.push(q.get('filter_ids'));
  // 第 1 轮 a,b,c（还有更多）；第 2 轮重复 c + 新 d（到头）
  return calls===1 ? response(['a','b','c']) : response(['c','d'],false);
 });
 const second=await Client.rankPage('hot',3,3);
 assert.deepEqual(second.items.map(x=>x.series_id),['d']);
 assert.equal(second.hasMore,false);
 // 续页确实通过 filter_ids 回传了已展示 id（去重靠它而非 session）
 assert.ok(filterIdsSeen.length>0 && filterIdsSeen[0].includes('a'));
});
