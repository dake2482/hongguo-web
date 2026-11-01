'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {filterDurationPage,validDuration}=require('../server/src/service/browse-filters');
const page={items:[0,null,3599,3600,10799,10800].map((duration,id)=>({series_id:String(id),duration})),hasMore:true,nextSkip:60};
test('duration boundaries use total seconds and exclude unknown durations',()=>{
 assert.deepEqual(filterDurationPage(page,'under60').items.map(x=>x.duration),[3599]);
 assert.deepEqual(filterDurationPage(page,'60to180').items.map(x=>x.duration),[3600,10799]);
 assert.deepEqual(filterDurationPage(page,'over180').items.map(x=>x.duration),[10800]);
 assert.equal(filterDurationPage(page,''),page);
 assert.equal(validDuration('invented'),false);
 assert.throws(()=>filterDurationPage(page,'invented'));
});
test('empty filtered pages preserve upstream cursor and continuation',()=>{
 const filtered=filterDurationPage({...page,items:[{duration:0}]},'over180');
 assert.deepEqual(filtered,{items:[],hasMore:true,nextSkip:60});
 assert.equal(filterDurationPage({...page,hasMore:false},'over180').hasMore,false);
 assert.equal(page.items.length,6);
});
