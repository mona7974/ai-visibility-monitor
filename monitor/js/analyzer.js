/* ============================================================
 * 自动判定引擎（纯函数，无依赖）
 * 输入：AI 回答原文 + 监测配置
 * 输出：是否提及 / 首次位次 / 点名品牌顺序 / 引用来源 / 态度 / 自检提示
 * ============================================================ */
(function (global) {
  'use strict';

  /* 常见信源站点：域名片段 → 展示名。按顺序匹配，先具体后笼统 */
  var KNOWN_SITES = [
    ['baike.baidu.com', '百度百科'],
    ['mp.weixin.qq.com', '微信公众号'],
    ['aiqicha.baidu.com', '爱企查'],
    ['weixin.qq.com', '微信'],
    ['zhihu.com', '知乎'],
    ['wikipedia.org', '维基百科'],
    ['36kr.com', '36氪'],
    ['toutiao.com', '今日头条'],
    ['xiaohongshu.com', '小红书'],
    ['bilibili.com', '哔哩哔哩'],
    ['douyin.com', '抖音'],
    ['csdn.net', 'CSDN'],
    ['juejin.cn', '掘金'],
    ['cnblogs.com', '博客园'],
    ['oschina.net', '开源中国'],
    ['jianshu.com', '简书'],
    ['sohu.com', '搜狐'],
    ['163.com', '网易'],
    ['sina.com.cn', '新浪'],
    ['ifeng.com', '凤凰网'],
    ['qq.com', '腾讯网'],
    ['idcquan.com', '中国IDC圈'],
    ['c114.com.cn', 'C114通信网'],
    ['c114.net', 'C114通信网'],
    ['ithome.com', 'IT之家'],
    ['tmtpost.com', '钛媒体'],
    ['geekpark.net', '极客公园'],
    ['leiphone.com', '雷峰网'],
    ['iyiou.com', '亿欧'],
    ['ebrun.com', '亿邦动力'],
    ['doit.com.cn', 'DOIT'],
    ['datacenterknowledge.com', 'Data Center Knowledge'],
    ['uptimeinstitute.com', 'Uptime Institute'],
    ['synergyrg.com', 'Synergy Research'],
    ['gartner.com', 'Gartner'],
    ['idc.com', 'IDC'],
    ['qcc.com', '企查查'],
    ['tianyancha.com', '天眼查'],
    ['miit.gov.cn', '工信部'],
    ['stats.gov.cn', '国家统计局'],
    ['gov.cn', '政府网站'],
    ['baidu.com', '百度']
  ];

  /* 中文站点名 / 口头引用（回答里常只写名字不写链接）。
     顺序：更具体、更长的放前面，短的会被「覆盖去重」跳过 */
  var SITE_NAMES = ['百度百科', '维基百科', '微信公众号', '官方网站', '官网',
    '中国IDC圈', '中国信通院', '信通院', '艾瑞咨询', '艾媒咨询',
    '前瞻产业研究院', '头豹研究院', '赛迪顾问', 'QuestMobile', '易观分析', '199IT',
    '知乎', '百科', '36氪', '今日头条', '小红书', '公众号', '哔哩哔哩', 'B站', '抖音',
    'CSDN', '掘金', '简书', '搜狐', '网易', '新浪', '凤凰网', '腾讯网', '中国IDC圈',
    'C114', 'IT之家', '钛媒体', '极客公园', '雷峰网', '亿欧', '企查查', '天眼查', '爱企查',
    '工信部', '国家统计局', '招股说明书', '招股书', '白皮书', '行业报告', '财报', '年报',
    '官方财报', '公开资料', '政府网站'];

  var POS_WORDS = ['推荐', '领先', '头部', '规模最大', '龙头', '第一', '首选', '稳定', '可靠',
    '成熟', '专业', '标杆', '值得', '优势', '优质', '入选', '连续多年', '市场份额高', '值得信赖'];
  var NEG_WORDS = ['风险', '亏损', '下滑', '诉讼', '处罚', '裁员', '暴雷', '事故', '宕机',
    '故障', '不推荐', '性价比低', '劣势', '争议', '监管问询', '退市', '债务', '经营困难',
    '增长乏力', '口碑差', '投诉', '谨慎'];

  var REFUSE_WORDS = ['抱歉', '无法回答', '不能提供', '没有相关信息', '不太清楚', '无法确定', '不便透露'];

  /* ---------- 小工具 ---------- */

  function asciiLower(s) {
    // 只把 ASCII 大写转小写，保证索引与原文一一对应
    return String(s).replace(/[A-Z]/g, function (c) { return c.toLowerCase(); });
  }

  function uniq(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (x) {
      var v = String(x == null ? '' : x).trim();
      if (!v) return;
      var k = v.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1;
      out.push(v);
    });
    return out;
  }

  function buildConfig(cfg) {
    cfg = cfg || {};
    var self = uniq([cfg.brand].concat(cfg.aliases || [])).filter(function (s) {
      return s.length >= 2;
    });
    var selfLower = self.map(function (s) { return s.toLowerCase(); });
    var comps = uniq(cfg.competitors || []).filter(function (s) {
      return s.length >= 2 && selfLower.indexOf(s.toLowerCase()) < 0;
    });
    return { self: self, comps: comps };
  }

  function findAll(hay, names) {
    var hits = [];
    names.forEach(function (name) {
      var needle = asciiLower(name), from = 0, idx;
      while ((idx = hay.indexOf(needle, from)) !== -1) {
        hits.push({ name: name, index: idx, end: idx + needle.length });
        from = idx + needle.length;
      }
    });
    return hits;
  }

  function mergeSpans(hits) {
    var spans = hits.map(function (h) { return [h.index, h.end]; });
    spans.sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    spans.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && s[0] <= last[1]) { last[1] = Math.max(last[1], s[1]); }
      else { out.push([s[0], s[1]]); }
    });
    return out;
  }

  function inSpans(index, spans) {
    for (var i = 0; i < spans.length; i++) {
      if (index >= spans[i][0] && index < spans[i][1]) return true;
    }
    return false;
  }

  /* ---------- 引用来源 ---------- */

  function hostOf(raw) {
    var s = String(raw).replace(/^[a-zA-Z]+:\/\//, '');
    s = s.split(/[/?#]/)[0];
    s = s.replace(/^www\./i, '').replace(/[.,;:]+$/, '');
    return asciiLower(s);
  }

  function labelOf(domain) {
    for (var i = 0; i < KNOWN_SITES.length; i++) {
      var pat = KNOWN_SITES[i][0];
      if (domain === pat || domain.slice(-(pat.length + 1)) === '.' + pat) return KNOWN_SITES[i][1];
    }
    return domain;
  }

  function extractSources(text) {
    var out = {}, order = [];
    var re = /(https?:\/\/[^\s)\]}"'，。、；：）】》]+)|(\b(?:[a-zA-Z0-9-]+\.)+(?:com|cn|net|org|io|co|edu|gov|info|biz|top|xyz|tech|ai|app|dev|cc|vip|site|online|club|ltd|group|mobi|pro|wang|link|me|tv)(?:\.[a-z]{2})?\b)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var host = hostOf(m[0]);
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) continue;
      var key = labelOf(host);
      if (!out[key]) { out[key] = { label: key, domain: host, kind: '链接', count: 0 }; order.push(key); }
      out[key].count++;
    }
    // 文内提及站点名（无链接，兼容「中国 IDC 圈」这类带空格的写法）
    var flat = String(text).replace(/[\s\u3000]/g, '');
    SITE_NAMES.forEach(function (nm) {
      if (text.indexOf(nm) === -1 && flat.indexOf(nm) === -1) return;
      var covered = false;
      for (var k in out) {
        var lb = out[k].label;
        // 已被更长/更具体的站点名覆盖（如「百度百科」覆盖「百科」）就不重复计
        if (lb.indexOf(nm) !== -1 || nm.indexOf(lb) !== -1) { covered = true; break; }
      }
      if (covered) return;
      if (!out[nm]) { out[nm] = { label: nm, domain: '', kind: '文内提及', count: 0 }; order.push(nm); }
      out[nm].count++;
    });
    return order.map(function (k) { return out[k]; }).sort(function (a, b) {
      return b.count - a.count;
    });
  }

  /* ---------- 态度 ---------- */

  function judgeSentiment(text) {
    var pos = 0, neg = 0;
    POS_WORDS.forEach(function (w) { if (text.indexOf(w) !== -1) pos++; });
    NEG_WORDS.forEach(function (w) { if (text.indexOf(w) !== -1) neg++; });
    if (pos > neg) return '正向';
    if (neg > pos) return '负向';
    return '中性';
  }

  /* ---------- 主分析 ---------- */

  function analyze(answer, cfg) {
    var text = String(answer == null ? '' : answer);
    var conf = buildConfig(cfg);
    var hay = asciiLower(text);

    var selfHits = findAll(hay, conf.self);
    var compHits = findAll(hay, conf.comps);
    var selfSpans = mergeSpans(selfHits);

    var mentioned = selfHits.length > 0;
    var firstSelf = mentioned ? Math.min.apply(null, selfHits.map(function (h) { return h.index; })) : null;
    var matchName = null;
    if (mentioned) {
      selfHits.forEach(function (h) { if (h.index === firstSelf && !matchName) matchName = h.name; });
    }

    // 每个竞品最早出现的位置（排除落在品牌名内部的命中）
    var compFirst = {}, compOrderHits = [];
    compHits.forEach(function (h) {
      if (inSpans(h.index, selfSpans)) return;
      if (compFirst[h.name] == null || h.index < compFirst[h.name]) compFirst[h.name] = h.index;
    });
    Object.keys(compFirst).forEach(function (n) {
      compOrderHits.push({ name: n, index: compFirst[n], type: 'comp' });
    });

    var rank = null;
    if (mentioned) {
      var before = compOrderHits.filter(function (h) { return h.index < firstSelf; });
      rank = before.length + 1;
    }

    // 被点名品牌顺序
    var brands = compOrderHits.slice();
    if (mentioned) brands.push({ name: matchName, index: firstSelf, type: 'self' });
    brands.sort(function (a, b) { return a.index - b.index; });

    var competitors = compOrderHits.sort(function (a, b) { return a.index - b.index; })
      .map(function (h) { return h.name; });

    var sources = extractSources(text);
    /* 态度只在「提到了我们」时才有意义：没提到时回答里的负面措辞
       （比如讲合同风险必然多负面词）是说这个行业，不是说我们。 */
    var sentiment = mentioned ? judgeSentiment(text) : '不适用';
    var charCount = text.replace(/\s/g, '').length;

    /* ---- 自检提示 ---- */
    var flags = [];
    var refused = REFUSE_WORDS.some(function (w) { return text.indexOf(w) !== -1; });

    if (!text.trim()) {
      flags.push({ level: 'warn', text: '还没有粘贴回答内容。把 AI 的整段回答复制进来才能自动判定。' });
    } else {
      if (charCount > 0 && charCount < 120) {
        flags.push({ level: 'warn', text: '回答偏短（' + charCount + ' 字），可能是泛泛而谈或拒答，建议重测一次。' });
      }
      if (refused) {
        flags.push({
          level: 'warn',
          text: '回答里出现拒答信号（抱歉/无法回答等），这条结果不可靠——建议换个更具体的问法重测，不要计入本轮结论。'
        });
      } else if (mentioned) {
        if (rank === 1) {
          flags.push({ level: 'good', text: 'AI 第一个点名的品牌就是我们（位次 1）。' });
        } else if (rank > 1) {
          flags.push({ level: 'info', text: 'AI 点名了 ' + brands.length + ' 个品牌，我们排在第 ' + rank + ' 位。' });
        }
        if (sources.length === 0) {
          flags.push({
            level: 'warn',
            text: '回答里没有提取到链接或站点名。如果 AI 口头提到了来源（如官网、行业报告、某媒体），点「引用来源」下方的快捷按钮补记；确实没有就留空——这条更像是靠模型记忆答的，不是可优化的检索路径。'
          });
        }
      } else {
        if (sources.length > 0) {
          var top = sources.slice(0, 3).map(function (s) { return s.label; }).join('、');
          flags.push({ level: 'info', text: '没提到我们，但引用了：' + top + '。优先去这些信源里补我们的内容。' });
        } else {
          flags.push({ level: 'bad', text: '完全没提到我们，也没有任何引用来源——这是纯内容缺口，最该优先补。' });
        }
      }
      if (!refused && brands.length > 1) {
        flags.push({
          level: 'info',
          text: 'AI 点名的品牌顺序：' + brands.map(function (b) {
            return b.name + (b.type === 'self' ? '（我们）' : '');
          }).join(' → ')
        });
      }
      if (sentiment === '负向') {
        flags.push({ level: 'bad', text: '回答中出现了针对我们的负面表述，建议人工确认是行业共性还是针对我们。' });
      }
    }

    return {
      mentioned: mentioned,
      rank: rank,
      matchName: matchName,
      brands: brands,
      competitors: competitors,
      sources: sources,
      sourceText: sources.map(function (s) { return s.label; }).join('; '),
      sentiment: sentiment,
      charCount: charCount,
      refused: refused,
      flags: flags
    };
  }

  /* ---------- 批量拆分 ---------- */

  function splitBatch(text) {
    return String(text == null ? '' : text)
      .split(/\n[ \t]*-{3,}[ \t]*(?=\n|$)/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  var api = {
    analyze: analyze,
    extractSources: extractSources,
    judgeSentiment: judgeSentiment,
    splitBatch: splitBatch,
    buildConfig: buildConfig,
    KNOWN_SITES: KNOWN_SITES
  };

  global.GeoAnalyzer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
