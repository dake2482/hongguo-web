/* Conservative text screening, not an age rating or a review of video frames. */
(function (root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  else root.HGYouthFilter = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '2026-11-02.2';

  /**
   * 2026-11-02 分级改版：旧版任一关键词命中即排除，实测 168 部真实作品被排除
   * 67%，其中约三成只命中一个词（单字「血/杀」误杀热血/血脉类，简介一句
   * 「灭门之祸」毙掉热播榜第 1 名，温馨奶爸文因提到「离婚」被拦）。改为两级：
   *  - strong：明确风险内容，正文任何位置命中即排除；
   *  - weak：题材套路词（总裁/复仇/丧尸等），命中标题/标签、或正文累计命中
   *    ≥2 个不同词才排除；仅简介深处出现单个弱词 → candidate（附原因说明）。
   * 另删除纯题材词：血/杀/诛 单字、妖魔、战神、甜宠、禁欲、偏执、占有——
   * 它们是品类本身的组成，不是适龄风险信号。
   */
  const RULES = [
    { name: '成人婚恋或性暗示',
      strong: ['情欲', '情趣', '床戏', '吻戏', '激情', '一夜情', '春宵', '洞房', '侍寝', '双修',
        '炉鼎', '娇喘', '露骨', '裸露', '情色', '色情', '擦边', '诱惑', '勾引', '成人向',
        '少儿不宜', '限制级', '18禁', 'r18', '叔侄恋', '师生恋', '禁忌之恋'],
      weak: ['总裁', '霸总', '豪门', '婚姻', '结婚', '离婚', '闪婚', '替嫁', '先婚', '契约婚',
        '婚约', '议亲', '入赘', '新婚', '新娘', '娇妻', '宠妻', '追妻', '人妻', '老公',
        '老婆', '赘婿', '王妃', '太子妃', '出轨', '婚外', '小三', '情人', '怀孕', '未婚先孕', '离异',
        '奉子', '带球跑', '生子', '生娃', '崽', '欲望'] },
    { name: '暴力、胁迫或虐待',
      strong: ['杀戮', '杀人', '杀死', '虐杀', '屠杀', '屠戮', '屠城', '灭门', '斩首', '砍头',
        '断肢', '食人', '吃人', '剥皮', '血腥', '血肉', '血祭', '凌辱', '羞辱', '霸凌',
        '家暴', '虐待', '强暴', '强奸', '性侵', '性骚扰', '猥亵', '绑架', '囚禁', '强制爱',
        '强扭', '逼婚', '强娶', '强吻', '掳走', '强取豪夺', '强占', '疯批', '病娇', '黑帮',
        '黑道', '杀手', '毒枭'],
      weak: ['鲜血', '血流', '流血', '斩杀', '尸体', '尸骨', '复仇', '报仇', '报复', '虐渣', '虐恋'] },
    { name: '惊悚恐怖或高风险行为',
      strong: ['自杀', '自残', '轻生', '割腕', '跳楼', '吸毒', '毒品', '贩毒', '赌博', '赌徒',
        '赌场', '诈骗', '捞偏门'],
      weak: ['恐怖', '惊悚', '丧尸', '僵尸', '恶鬼', '厉鬼', '闹鬼', '灵异', '邪祟', '夺舍',
        '灭顶之灾', '诡异', '诡秘', '冥婚', '献祭'] },
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

  /** 弱词扫描：返回 {hitTitle, words}，words 为命中的不同弱词（原文小写）。 */
  function scanWeak(titleText, text) {
    const words = [];
    let hitTitle = false;
    for (const rule of RULES) {
      for (const w of rule.weak) {
        if (!text.includes(w)) continue;
        words.push(w);
        if (titleText.includes(w)) hitTitle = true;
      }
    }
    return { hitTitle, words };
  }

  function classify(item) {
    const category = blockedCategory(item);
    if (category) return { status: 'excluded', reason: `已排除类别：${category}` };
    if (isBlocked(item)) return { status: 'excluded', reason: '已加入屏蔽名单' };
    if (!item || typeof item !== 'object') return { status: 'unknown', reason: '缺少作品资料' };
    const title = asText(item.title).trim();
    const abstract = asText(item.abstract).trim();
    const tags = Array.isArray(item.tags) ? item.tags.filter(t => typeof t === 'string').join(' ') : asText(item.tags);
    // 卡面上可见的文字全部纳入扫描：标题、标签、分类（卡片的标签行会展示分类）
    const catText = Array.isArray(item.category)
      ? item.category.filter(t => typeof t === 'string').join(' ') : asText(item.category);
    const raw = [title, tags, catText, abstract].join(' ').normalize('NFKC');
    if (/(?:18|十八)\s*[+＋]|(?:仅限|限)成人/.test(raw)) return { status: 'excluded', reason: '成人分级提示' };
    const titleText = normalize([title, tags, catText].join(' '));
    const text = normalize(raw);
    for (const rule of RULES) {
      for (const w of rule.strong) {
        if (text.includes(w)) return { status: 'excluded', reason: rule.name };
      }
    }
    const weak = scanWeak(titleText, text);
    if (weak.hitTitle) return { status: 'excluded', reason: '题材风险词出现在标题、标签或分类' };
    if (weak.words.length >= 2) return { status: 'excluded', reason: '多个风险词同时出现' };
    // 简介是主要判定依据之一：单个题材词只出现在简介里，不算干净候选，
    // 也不直接排除——进「待确认」，点开详情按完整简介复筛后升降级
    if (weak.words.length === 1)
      return { status: 'unknown', reason: `简介含题材词「${weak.words[0]}」，待人工确认` };
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
