/* ============================================================
 * 数据层：本机存储（localStorage）+ 导入导出
 * ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'geo_monitor_v1';
  var SCHEMA = 1;

  var DEFAULT_KEYWORDS = [
    ['数据中心机柜租赁价格', '比价选型'],
    ['IDC 机房托管哪家好', '比价选型'],
    ['数据中心运维服务商推荐', '决策风险'],
    ['机柜租赁和自建机房哪个划算', '比价选型'],
    ['数据中心 PUE 是什么', '概念算法'],
    ['IDC 机房等级怎么划分', '概念算法'],
    ['数据中心电费怎么算', '概念算法'],
    ['机房托管合同要注意什么', '决策风险'],
    ['数据中心灾备方案怎么选', '决策风险'],
    ['第三方数据中心和运营商机房的区别', '决策风险']
  ];

  var DEFAULT_PLATFORMS = [
    ['DeepSeek', 'https://chat.deepseek.com/'],
    ['豆包', 'https://www.doubao.com/chat/'],
    ['Kimi', 'https://www.kimi.com/'],
    ['腾讯元宝', 'https://yuanbao.tencent.com/chat/'],
    ['文心一言', 'https://yiyan.baidu.com/']
  ];

  var DEFAULT_COMPETITORS = [
    '世纪互联', '光环新网', '数据港', '润泽科技', '宝信软件', '科华数据', '奥飞数据',
    '网宿科技', '鹏博士', '秦淮数据', '有孚网络', '腾龙控股', '中金数据', '浩云网络',
    'Equinix', 'Digital Realty', 'Vantage Data Centers', 'AirTrunk'
  ];

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function defaults() {
    return {
      schema: SCHEMA,
      brand: '示例品牌',
      aliases: ['示例品牌', 'ExampleBrand'],
      competitors: DEFAULT_COMPETITORS.slice(),
      keywords: DEFAULT_KEYWORDS.map(function (k) {
        return { id: uid(), keyword: k[0], category: k[1] };
      }),
      platforms: DEFAULT_PLATFORMS.map(function (p) {
        return { id: uid(), name: p[0], url: p[1] };
      }),
      rounds: ['第1轮', '第2轮', '第3轮'],
      records: []
    };
  }

  var cache = null;

  function load() {
    if (cache) return cache;
    var data = null;
    try {
      var raw = global.localStorage.getItem(KEY);
      if (raw) data = JSON.parse(raw);
    } catch (e) { data = null; }
    var base = defaults();
    if (!data || typeof data !== 'object') {
      cache = base;
    } else {
      cache = {
        schema: SCHEMA,
        brand: typeof data.brand === 'string' ? data.brand : base.brand,
        aliases: Array.isArray(data.aliases) ? data.aliases : base.aliases,
        competitors: Array.isArray(data.competitors) && data.competitors.length ? data.competitors : base.competitors,
        keywords: Array.isArray(data.keywords) && data.keywords.length ? data.keywords : base.keywords,
        platforms: Array.isArray(data.platforms) && data.platforms.length ? data.platforms : base.platforms,
        rounds: Array.isArray(data.rounds) && data.rounds.length ? data.rounds : base.rounds,
        records: Array.isArray(data.records) ? data.records : []
      };
    }
    return cache;
  }

  function save() {
    if (!cache) return false;
    try {
      global.localStorage.setItem(KEY, JSON.stringify(cache));
      return true;
    } catch (e) {
      return false;
    }
  }

  function get() { return load(); }

  function update(patch) {
    var d = load();
    Object.keys(patch || {}).forEach(function (k) { d[k] = patch[k]; });
    save();
    return d;
  }

  function reset() {
    cache = defaults();
    save();
    return cache;
  }

  /* ---------- 记录 ---------- */

  function addRecord(rec) {
    var d = load();
    var row = Object.assign({
      id: uid(),
      createdAt: new Date().toISOString()
    }, rec);
    d.records.push(row);
    save();
    return row;
  }

  function addRecords(list) {
    var d = load(), out = [];
    (list || []).forEach(function (rec) {
      var row = Object.assign({ id: uid(), createdAt: new Date().toISOString() }, rec);
      d.records.push(row);
      out.push(row);
    });
    save();
    return out;
  }

  function updateRecord(id, patch) {
    var d = load();
    for (var i = 0; i < d.records.length; i++) {
      if (d.records[i].id === id) {
        Object.assign(d.records[i], patch);
        save();
        return d.records[i];
      }
    }
    return null;
  }

  function removeRecord(id) {
    var d = load();
    var before = d.records.length;
    d.records = d.records.filter(function (r) { return r.id !== id; });
    save();
    return before - d.records.length;
  }

  function clearRecords() {
    var d = load();
    var n = d.records.length;
    d.records = [];
    save();
    return n;
  }

  /* ---------- 导入导出 ---------- */

  function exportJSON() {
    var d = load();
    return JSON.stringify({
      schema: SCHEMA,
      exportedAt: new Date().toISOString(),
      app: 'AI 可见度监测台',
      brand: d.brand,
      aliases: d.aliases,
      competitors: d.competitors,
      keywords: d.keywords,
      platforms: d.platforms,
      rounds: d.rounds,
      records: d.records
    }, null, 2);
  }

  function importJSON(text) {
    var data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('文件内容不是有效的备份数据');
    var d = load();
    if (typeof data.brand === 'string' && data.brand) d.brand = data.brand;
    if (Array.isArray(data.aliases)) d.aliases = data.aliases;
    if (Array.isArray(data.competitors) && data.competitors.length) d.competitors = data.competitors;
    if (Array.isArray(data.keywords) && data.keywords.length) d.keywords = data.keywords;
    if (Array.isArray(data.platforms) && data.platforms.length) d.platforms = data.platforms;
    if (Array.isArray(data.rounds) && data.rounds.length) d.rounds = data.rounds;

    var incoming = Array.isArray(data.records) ? data.records : [];
    var seen = {};
    d.records.forEach(function (r) {
      seen[[r.keyword, r.platform, r.round, r.testedAt].join('|')] = true;
    });
    var added = 0;
    incoming.forEach(function (r) {
      var key = [r.keyword, r.platform, r.round, r.testedAt].join('|');
      if (seen[key]) return;
      seen[key] = true;
      d.records.push(Object.assign({ id: uid(), createdAt: new Date().toISOString() }, r));
      added++;
    });
    save();
    return { added: added, total: incoming.length };
  }

  var CSV_HEAD = ['测试日期', '轮次', '关键词/提问', '平台', '是否提到目标品牌', '首次出现位次',
    '同时提到的其他品牌', '引用来源', '态度倾向', '是否存在明显错误', '备注与优化灵感'];

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    s = s.replace(/\r?\n/g, ' ').replace(/"/g, '""');
    return '"' + s + '"';
  }

  function exportCSV(records) {
    var rows = [CSV_HEAD.map(csvCell).join(',')];
    (records || load().records).forEach(function (r) {
      rows.push([
        r.testedAt, r.round, r.keyword, r.platform, r.mentioned,
        r.firstRank, r.competitors, r.sources, r.sentiment, r.hasError, r.note
      ].map(csvCell).join(','));
    });
    return '\ufeff' + rows.join('\r\n');
  }

  /* ---------- 示例数据（体验用） ---------- */

  function seedDemo() {
    var d = load();
    if (!d.keywords.length || !d.platforms.length) return 0;
    var today = new Date();
    function day(offset) {
      var t = new Date(today.getTime() + offset * 86400000);
      return t.toISOString().slice(0, 10);
    }
    var demo = [
      { k: 0, p: 0, mentioned: '是', firstRank: 1, sources: '百度百科; 知乎', sentiment: '正向', note: 'AI 排我们在首位，但引的是百科词条，不是官网' },
      { k: 0, p: 1, mentioned: '是', firstRank: 3, sources: '36氪; 中国IDC圈', sentiment: '中性', note: '被放在第三位，前面两家是世纪互联和数据港' },
      { k: 0, p: 2, mentioned: '否', firstRank: '', sources: '', sentiment: '中性', note: '完全没提到，只讲了报价区间 —— 纯内容缺口' },
      { k: 1, p: 0, mentioned: '是', firstRank: 2, sources: '知乎; 搜狐', sentiment: '正向', note: '知乎那篇旧帖口径偏旧，需要更新机柜规模数据' },
      { k: 1, p: 1, mentioned: '否', firstRank: '', sources: '百度百科', sentiment: '中性', note: '只列了运营商机房，第三方只提到世纪互联' }
    ];
    var out = [];
    demo.forEach(function (x, i) {
      out.push({
        keyword: d.keywords[x.k].keyword,
        platform: d.platforms[x.p].name,
        round: d.rounds[0],
        testedAt: day(-1),
        mentioned: x.mentioned,
        firstRank: x.firstRank,
        competitors: x.mentioned === '是' ? '世纪互联; 数据港' : '世纪互联',
        sources: x.sources,
        sentiment: x.sentiment,
        hasError: '无',
        rawAnswer: '',
        note: x.note
      });
    });
    return addRecords(out).length;
  }

  /* ---------- 本机采集器文件同步 ----------
     采集器把每次采集结果存成 out/*.json，本地服务会把它们喂进来。
     匹配键：关键词+平台+轮次（同一天重采同一问题视为同一条）。
       · 没见过 → 新增
       · 回答变了（重采过）→ 用文件里的新数据整体替换（保留 id）
       · 回答相同 → 只把空字段补上（例如旧数据缺 sources） */
  var SYNC_FIELDS = ['testedAt', 'mentioned', 'firstRank', 'competitors', 'sources',
    'sentiment', 'hasError', 'rawAnswer', 'note', 'links'];

  function syncRecords(list) {
    var d = load();
    var added = 0, updated = 0;
    (list || []).forEach(function (inc) {
      if (!inc || !inc.keyword || !inc.platform) return;
      var found = null;
      for (var i = 0; i < d.records.length; i++) {
        var r = d.records[i];
        if (r.keyword === inc.keyword && r.platform === inc.platform && r.round === inc.round) {
          found = r; break;
        }
      }
      if (!found) {
        d.records.push(Object.assign({ id: uid(), createdAt: new Date().toISOString() }, inc));
        added++;
      } else if (String(found.rawAnswer || '') !== String(inc.rawAnswer || '')) {
        SYNC_FIELDS.forEach(function (k) {
          if (inc[k] !== undefined) found[k] = inc[k];
        });
        updated++;
      } else {
        var touched = false;
        SYNC_FIELDS.forEach(function (k) {
          if (inc[k] === undefined) return;
          if (found[k] === undefined || found[k] === '' || found[k] == null) {
            found[k] = inc[k]; touched = true;
          }
        });
        if (touched) updated++;
      }
    });
    save();
    return { added: added, updated: updated };
  }

  var api = {
    KEY: KEY,
    uid: uid,
    get: get,
    update: update,
    save: save,
    reset: reset,
    addRecord: addRecord,
    addRecords: addRecords,
    updateRecord: updateRecord,
    removeRecord: removeRecord,
    clearRecords: clearRecords,
    exportJSON: exportJSON,
    importJSON: importJSON,
    syncRecords: syncRecords,
    exportCSV: exportCSV,
    seedDemo: seedDemo,
    defaults: defaults
  };

  global.GeoStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
