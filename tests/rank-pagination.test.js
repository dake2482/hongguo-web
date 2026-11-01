'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Http=require('../server/src/util/http');
const Client=require('../server/src/service/client');
const {uniqueSeries}=require('../web/list-utils');
const cell=id=>({video_data:{series_id:id,title:'作品'+id}});
function response(ids,next,more,session='rank-session') {
 return new Http.Resp(200,Buffer.from(JSON.stringify({data:{session_id:session,next_offset:next,has_more:more,
  cell_view:{cell_data:ids.map(cell),next_offset:999,has_more:true}}})));
}
test('rank follows server session within a page and across API pages, including cache',async()=>{
 const original=Http.send, calls=[];
 Http.send=async req=>{
  const q=new URL(req.url).searchParams;calls.push(q);
  if(calls.length===1)return response(['a','b'],2,true);
  assert.equal(q.get('session_id'),'rank-session');
  if(calls.length===2){assert.equal(q.get('offset'),'2');return response(['b','c'],4,true);}
  assert.equal(q.get('offset'),'4');return response(['d'],5,false);
 };
 try{
  const first=await Client.rankPage('fixture-session',3,0);
  assert.deepEqual(first.items.map(x=>x.series_id),['a','b','c']);
  assert.equal(first.nextOffset,4);assert.equal(first.hasMore,true);assert.equal(first.sessionId,'rank-session');
  const cached=await Client.rankPage('fixture-session',3,0);
  assert.equal(cached.sessionId,'rank-session');assert.equal(calls.length,2);
  const second=await Client.rankPage('fixture-session',3,first.nextOffset,first.sessionId);
  assert.deepEqual(second.items.map(x=>x.series_id),['d']);assert.equal(second.hasMore,false);
 }finally{Http.send=original;}
});
test('repeating upstream pages terminate instead of filling a page with duplicates',async()=>{
 const original=Http.send;let calls=0;
 Http.send=async()=>response(['a','a'],++calls*2,true);
 try{
  const page=await Client.rankPage('fixture-repeat',30,0);
  assert.deepEqual(page.items.map(x=>x.series_id),['a']);assert.equal(page.hasMore,false);assert.equal(calls,2);
 }finally{Http.send=original;}
});
test('first-page and incremental display deduplicate IDs without changing screening metadata',()=>{
 const a={series_id:'1',title:'同一部剧',abstract:'保留风险信息'}, b={series_id:'2',title:'同名不同剧'};
 assert.deepEqual(uniqueSeries([a,a,{series_id:1},null,b,b]),[a,b]);
 const seen=new Set(['1']);assert.deepEqual(uniqueSeries([a,b,b],seen),[b]);assert.deepEqual([...seen],['1']);
});
