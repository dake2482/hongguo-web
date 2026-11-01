/* Conservative text screening, not an age rating or a review of video frames. */
(function (root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  else root.HGYouthFilter = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '2026-10-18.4';
  const groups = [
    ['成人婚恋或性暗示', /总裁|霸总|豪门|婚姻|结婚|离婚|闪婚|替嫁|先婚|契约婚|婚约|议亲|入赘|新婚|新娘|娇妻|宠妻|追妻|人妻|老公|老婆|赘婿|王妃|太子妃|出轨|婚外|小三|情人|怀孕|未婚先孕|奉子|带球跑|生子|生娃|崽|欲望|情欲|情趣|床戏|吻戏|激情|一夜情|春宵|洞房|侍寝|双修|炉鼎|娇喘|露骨|裸露|情色|色情|擦边|诱惑|勾引|禁欲|甜宠|偏执|占有|禁忌之恋|叔侄恋|师生恋|成人向|少儿不宜|限制级|18禁|r18/i],
    ['暴力、胁迫或虐待', /血|妖魔|杀|诛|战神|鲜血|血流|流血|血肉|血祭|杀戮|杀人|杀死|虐杀|屠杀|屠戮|屠城|灭门|斩杀|斩首|砍头|断肢|尸体|尸骨|食人|吃人|剥皮|复仇|报仇|报复|虐渣|虐恋|凌辱|羞辱|霸凌|家暴|虐待|强暴|强奸|性侵|性骚扰|猥亵|绑架|囚禁|强制爱|强扭|逼婚|强娶|强吻|掳走|疯批|强取豪夺|强占|病娇|黑帮|黑道|杀手|毒枭/],
    ['惊悚恐怖或高风险行为', /恐怖|惊悚|丧尸|僵尸|恶鬼|厉鬼|闹鬼|灵异|邪祟|夺舍|灭顶之灾|诡异|诡秘|冥婚|献祭|自杀|自残|轻生|割腕|跳楼|吸毒|毒品|贩毒|赌博|赌徒|赌场|诈骗|捞偏门/],
  ];
  const asText = value => typeof value === 'string' ? value : '';
  const normalize = value => asText(value).normalize('NFKC').replace(/[\s\p{P}\p{Cf}]/gu, '').toLowerCase();
  // Explicit user block: independent of the optional text-screening switch.
  const blockedIds = new Set(['7696705177721523225']);
  const blockedTitles = new Set([normalize('万人迷的男主们，开始为她失控第一季')]);
  function blockedCategory(item) {
    const values = [item?.category || [], item?.tags || []].flat(Infinity)
      .filter(value => typeof value === 'string')
      .flatMap(value => value.split(/[\/、,，|;；]/)).map(value => normalize(value));
    return ['豪门', '剧情'].find(name => values.includes(name)) || '';
  }
  function isBlocked(item) {
    return !!item && (!!blockedCategory(item) || blockedIds.has(String(item.series_id || item.sid || ''))
      || blockedTitles.has(normalize(item.title)));
  }
  function classify(item) {
    const category = blockedCategory(item);
    if (category) return { status: 'excluded', reason: `已排除类别：${category}` };
    if (isBlocked(item)) return { status: 'excluded', reason: '已加入屏蔽名单' };
    if (!item || typeof item !== 'object') return { status: 'unknown', reason: '缺少作品资料' };
    const title = asText(item.title).trim();
    const abstract = asText(item.abstract).trim();
    const tags = Array.isArray(item.tags) ? item.tags.filter(t => typeof t === 'string').join(' ') : asText(item.tags);
    const raw = [title, tags, abstract].join(' ').normalize('NFKC');
    if (/(?:18|十八)\s*[+＋]|(?:仅限|限)成人/.test(raw)) return { status: 'excluded', reason: '成人分级提示' };
    const text = normalize(raw);
    for (const [reason, pattern] of groups) {
      if (pattern.test(text)) return { status: 'excluded', reason };
    }
    // Popularity, female audience, genre and positive tags are never age evidence.
    if (!title || /^(未命名|播放|未知)$/.test(title) || normalize(abstract).length < 30)
      return { status: 'unknown', reason: '缺少足够的剧情简介' };
    if (/评论|回评|网友|观众|好看|爱看|看了|看完|追剧|刷到|点赞|五星|哈哈|笑哭|短剧是生活|精神代餐|男主.*女主|女主.*男主/.test(abstract)
        || /\[[^\]]{1,8}\]|[\p{Extended_Pictographic}]/u.test(abstract))
      return { status: 'unknown', reason: '简介可能是评论，待核实剧情' };
    if (/暂无|待补充|敬请期待|简介不详|未知剧情/.test(abstract))
      return { status: 'unknown', reason: '剧情信息不完整' };
    return { status: 'candidate', reason: '文字未命中已设风险规则，仍需人工确认' };
  }
  function summarize(items) {
    const counts = { candidate: 0, excluded: 0, unknown: 0 };
    for (const item of items || []) counts[classify(item).status]++;
    return counts;
  }
  return { VERSION, classify, summarize, isBlocked, blockedCategory };
});
