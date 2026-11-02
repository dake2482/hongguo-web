'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, summarize } = require('../web/youth-filter');
const plot = '几位来自不同地方的同学一起参加学校的科技社团，在准备展览的过程中学会分工合作，认真面对失误，最终找到各自的兴趣和目标。';
const base = { title: '一起向前走', abstract: plot, tags: ['青春', '成长'] };
for (const [name, item, expected] of [
  ['growth candidate', base, 'candidate'],
  ['fantasy is not excluded by genre', {...base,title:'星际旅行',tags:['科幻','冒险']},'candidate'],
  ['adult trope wins over positive tags', {...base,title:'总裁的校园甜宠',score:9.9},'excluded'],
  ['risk late in full synopsis', {...base,abstract:plot.repeat(2)+'故事后期出现了绑架和虐待。'},'excluded'],
  ['risk in tags', {...base,tags:['青春','强制爱']},'excluded'],
  ['punctuation evasions', {...base,title:'强 制 爱：校园篇'},'excluded'],
  ['adult age marker', {...base,title:'成长故事 １８＋'},'excluded'],
  ['fantasy genre prose is not excluded since genre words dropped', {...base,title:'万妖图录传第一季',abstract:'以妖魔之血为墨，以百妖谱为卷，可摹画其形，夺其神通。姜月初一朝醒来，却成了盛世大唐的一介少女。'},'candidate'],
  ['single-char blood/kill no longer matches hot-blooded prose', {...base,title:'热血战神归来',abstract:'主角觉醒血脉之力，在宗门大比中一路杀伐果断，热血迎战各路天骄，最终守护住师门荣耀。'},'candidate'],
  ['single weak trope word deep in synopsis stays candidate with note', {...base,title:'天降萌娃，奶爸开店致富',abstract:plot+'离异后他独自带着孩子生活，把小店经营得有声有色。'},'candidate'],
  ['two distinct weak words in synopsis are excluded', {...base,abstract:plot+'离异后前妻追妻火葬场，剧情围绕婚姻展开。'},'excluded'],
  ['horror trope word in title is excluded', {...base,title:'末日丧尸围城'},'excluded'],
  ['single horror trope word in synopsis stays candidate', {...base,abstract:plot+'途中偶遇一支丧尸题材剧组，闹出不少笑话。'},'candidate'],
  ['comment instead of synopsis', {...base,abstract:'太好看了，这部剧我看完真的觉得画面特别不错，男主女主的表现我都很喜欢。'},'unknown'],
  ['short data', {...base,abstract:'青春成长'},'unknown'],
  ['missing synopsis regardless of popularity', {title:'学校日记',score:9.9,play_cnt:9999999,tags:['适合青少年','女频']},'unknown'],
  ['missing title', {abstract:plot},'unknown'],
  ['malformed metadata', {title:[],abstract:{},tags:[null,{}]},'unknown'],
  ['null metadata', null,'unknown'],
  ['no authoritative rating implied by negation', {...base,abstract:plot+'本片反对校园霸凌。'},'excluded'],
]) test(name,()=>assert.equal(classify(item).status,expected));
test('screening is read-only and counts unknown separately',()=>{
 const input=[Object.freeze(base),{...base,title:'惊悚故事'},{title:'资料缺失'}];
 assert.deepEqual(summarize(input),{candidate:1,excluded:1,unknown:1});
 assert.equal(input.length,3);
});
test('search parsing preserves risk text past the old 60-character cutoff',()=>{
 const {parseSearchCell}=require('../server/src/service/client');
 const intro=plot.repeat(2)+'随后卷入了绑架事件。';
 const result=parseSearchCell({book_id:'fixture',video_detail:{episode_cnt:2,series_title:'同学的旅途',series_intro:intro}});
 assert.equal(result.abstract,intro);
 assert.equal(classify(result).status,'excluded');
});
test('coercive romance and arranged marriage wording stays out of candidates',()=>{
 for(const term of ['强扭','婚约','入赘','逼婚','强吻']) assert.equal(classify({...base,title:term+'的故事'}).status,'excluded');
});
test('body possession and mass disaster signals are excluded conservatively',()=>{
 assert.equal(classify({...base,abstract:plot+'随后发生夺舍与宗门灭顶之灾。'}).status,'excluded');
});

test('explicit title block matches stable ID and normalized title',()=>{
 const {isBlocked}=require('../web/youth-filter');
 for (const item of [
  {...base,series_id:'7696705177721523225'},
  {sid:'7696705177721523225'},
  {...base,title:'万人迷的男主们，开始为她失控第一季'},
  {...base,title:'万人迷的男主们, 开始为她失控第一季'},
 ]) { assert.equal(isBlocked(item),true); assert.equal(classify(item).reason,'已加入屏蔽名单'); }
 assert.equal(isBlocked(base),false);
 assert.equal(isBlocked({...base,title:'万人迷的男主们，开始为她失控第二季'}),false);
});

test('category exclusions match whole labels across list and detail metadata',()=>{
 const {isBlocked,blockedCategory}=require('../web/youth-filter');
 for(const category of ['剧情 / 校园','玄幻 / 豪门',['奇幻','剧情'],['豪门']]) {
  assert.equal(isBlocked({...base,category}),true);
  assert.match(classify({...base,category}).reason,/已排除类别/);
 }
 assert.equal(isBlocked({...base,tags:['剧情']}),true);
 assert.equal(blockedCategory({...base,category:'奇幻 / 冒险',abstract:plot+'剧情介绍完整。'}),'');
 assert.equal(isBlocked({...base,category:'剧情片段赏析'}),false);
});
test('search retains all category sources for exclusion checks',()=>{
 const {parseSearchCell}=require('../server/src/service/client');
 const row=parseSearchCell({book_id:'category-test',video_detail:{episode_cnt:2,series_title:base.title,series_intro:plot,category_schema:'[{"name":"剧情"}]'},video_data:{category_schema:'[{"name":"校园"}]'}});
 assert.equal(row.category,'剧情 / 校园');
 assert.match(classify(row).reason,/已排除类别/);
});
