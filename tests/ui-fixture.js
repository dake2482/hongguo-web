// Local-only synthetic API for browser verification. Never deploy this server.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {filterDurationPage}=require('../server/src/service/browse-filters');
const plot = '几位来自不同地方的同学一起参加学校的科技社团，在准备展览的过程中学会分工合作，认真面对失误，最终找到各自的兴趣和目标。';
const items = [
 {series_id:'fixture-growth',title:'测试：一起向前走',abstract:plot,tags:['青春'],episode_cnt:2,duration:1800},
 {series_id:'fixture-adult',title:'测试：总裁的契约婚姻',abstract:plot,tags:['成长'],episode_cnt:2},
 {series_id:'fixture-unknown',title:'测试：资料缺失',abstract:'暂无简介',tags:[],episode_cnt:2},
 {series_id:'fixture-detail',title:'测试：旅途的秘密',abstract:plot,tags:[],episode_cnt:2,duration:7200},
];
const root = path.resolve(__dirname,'../web');
http.createServer((req,res)=>{
 const url = new URL(req.url,'http://localhost');
 let data;
 if(url.pathname==='/health')data={ok:true,sign_backends:[{ready:true}]};
 else if(url.pathname==='/api-key')data={api_key:'fixture-key'};
 else if(url.pathname==='/filters')data={rows:[
  {type:'gender',items:[{id:'1',name:'男频'},{id:'0',name:'女频'}]},
  {type:'category_dim_theme',items:[{id:'cate_316',name:'剧情'},{id:'cate_936',name:'豪门'},{id:'cate_6',name:'奇幻'},{id:'cate_1092',name:'科幻'}]},
  {type:'category_dim_role',items:[{id:'cate_19',name:'系统'},{id:'cate_37',name:'穿越'}]},
  {type:'category_dim_epoch',items:[{id:'cate_599',name:'异界'},{id:'cate_4',name:'校园'}]},
  ...(url.searchParams.get('genre')==='ai_series'?[]:[{type:'creation_status',items:[{id:'creation_status_0',name:'已完结'},{id:'creation_status_1',name:'连载中'}]}]),
  {type:'online_time',items:[{id:'days_7',name:'7天内上新'}]}
 ]};
 else if(['/rank','/search','/latest','/browse'].includes(url.pathname)){
  const offset=Number(url.searchParams.get('offset')||0);
  let rows=url.searchParams.get('q')==='全隐藏'?items.slice(1,3):offset===0?items:offset===4?[{...items[1],series_id:'fixture-hidden-page'}]:offset===5?[{...items[0],series_id:'fixture-page3',title:'测试：第三页成长'}]:[];
  if(url.pathname==='/browse') {
    const genre=url.searchParams.get('genre'); const theme=url.searchParams.get('theme');
    console.log(JSON.stringify(Object.fromEntries([...url.searchParams].filter(([key])=>key!=='api_key'))));
    if(theme) rows = theme===(genre==='short_play'?'cate_1020':'cate_6') ? [{...items[0],title:'测试：奇幻旅程'}] : [];
  }
  const pg=filterDurationPage({items:rows,hasMore:offset<5,nextSkip:offset+rows.length},url.searchParams.get('duration'));
  data={items:pg.items,results:pg.items,has_more:pg.hasMore,next_offset:pg.nextSkip};
 } else if(url.pathname==='/episodes') {
  const item=items.find(x=>x.series_id===url.searchParams.get('series_id'))||items[0];
  data={meta:{...item,abstract:item.series_id==='fixture-detail'?plot+'后来发生了绑架。':plot+'在社团活动结束后，他们仍然坚持每周互相分享新的学习成果。'},episodes:[{vid:'fixture-video',index:1,title:'测试集'}]};
 } else if(url.pathname==='/prewarm')data={state:'cached'};
 if(data){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));return;}
 const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
 const file=path.resolve(root,name);
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);
}).listen(18866,'127.0.0.1',()=>console.log('Synthetic UI fixtures: http://127.0.0.1:18866'));
