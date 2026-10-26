/* ============================================================
 * 把采集器产出的原始回答跑一遍判定引擎，生成「已判定」备份文件
 *   - 输入：collector/out/答案_<平台>_<轮次>_<日期>.json
 *   - 输出：同目录下「_已判定.json」，可直接在监测台「导入备份」
 * 用法：node judge_collected.js <输入文件>
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');

/* ---- 用沙箱加载浏览器端的 IIFE 模块 ---- */
function loadModule(file) {
  var sandbox = { window: {}, console: console };
  sandbox.window.localStorage = {
    _m: {},
    getItem: function (k) { return k in this._m ? this._m[k] : null; },
    setItem: function (k, v) { this._m[k] = String(v); },
    removeItem: function (k) { delete this._m[k]; }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.window;
}

var W = loadModule(path.join(ROOT, 'monitor/js/analyzer.js'));
var WStore = loadModule(path.join(ROOT, 'monitor/js/store.js'));

/* 每个 IIFE 模块把 API 挂在 window 上（GeoAnalyzer / GeoStats / GeoStore），
   所以这里要再取一层，不能直接用 window。 */
var A = W.GeoAnalyzer;
var Store = WStore.GeoStore;

if (!A) throw new Error('找不到判定引擎导出（analyzer.js 的 window.GeoAnalyzer）');
if (!Store) throw new Error('找不到数据层导出（store.js 的 window.GeoStore）');

var inFile = process.argv[2];
if (!inFile) {
  console.error('用法：node judge_collected.js <采集结果.json>');
  process.exit(1);
}

var data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
var d = Store.defaults();
var cfg = {
  brand: data.brand || '示例品牌',
  aliases: (data.aliases && data.aliases.length ? data.aliases : d.aliases),
  competitors: (data.competitors && data.competitors.length ? data.competitors : d.competitors)
};

console.log('品牌：' + cfg.brand + '　别名 ' + cfg.aliases.length + ' 个　竞品库 ' + cfg.competitors.length + ' 个');
console.log('平台：' + (data.records[0] ? data.records[0].platform : '?') + '　轮次：' + data.round);
console.log('待判定：' + data.records.length + ' 条');
console.log('');

var judged = [];
var hits = 0, noSrc = 0;

data.records.forEach(function (r, i) {
  var ans = String(r.rawAnswer || '');
  var res = A.analyze(ans, cfg);
  if (res.mentioned) hits++;

  /* 引用来源：采集器抓到的页面链接最准，判定引擎从文字里认出来的作补充，合并去重 */
  var srcList = [], seenSrc = {};
  function addSrc(s) {
    s = String(s == null ? '' : s).trim();
    if (!s || seenSrc[s]) return;
    seenSrc[s] = 1; srcList.push(s);
  }
  String(r.sources || '').split(/[;；,，、]/).forEach(addSrc);
  res.sourceText.split(/[;；,，、]/).forEach(addSrc);
  var mergedSources = srcList.join('; ');
  if (!mergedSources) noSrc++;

  var note;
  if (!ans.trim()) {
    note = '未抓到回答内容，需要重采';
  } else if (res.refused) {
    note = 'AI 拒答/未正面回答';
  } else if (res.mentioned) {
    note = mergedSources ? 'AI 引用：' + mergedSources : 'AI 提到了我们，但没给出可追溯的信源';
  } else if (mergedSources) {
    note = '没提到我们，但引用了：' + srcList.slice(0, 3).join('、') + ' —— 优先去这些信源补内容';
  } else {
    note = '完全没提到目标品牌 —— 纯内容缺口';
  }
  var warnTexts = (res.flags || []).filter(function (f) { return f.level !== 'good'; })
    .map(function (f) { return f.text; });
  /* 「没提取到链接」的提示只针对回答正文；采集器已经抓到页面引用时它就不再成立 */
  if (mergedSources) {
    warnTexts = warnTexts.filter(function (t) {
      return t.indexOf('没有提取到链接') === -1;
    });
  }
  if (warnTexts.length) note += '｜自检：' + warnTexts.join('；');

  judged.push({
    keyword: r.keyword,
    platform: r.platform,
    round: r.round || data.round,
    testedAt: r.testedAt || new Date().toISOString().slice(0, 10),
    mentioned: res.mentioned ? '是' : '否',
    firstRank: res.rank || '',
    competitors: res.competitors.join('; '),
    sources: mergedSources,
    sentiment: res.sentiment,
    hasError: '无',
    rawAnswer: ans,
    note: note,
    links: r.links || []
  });

  var mark = res.mentioned ? '✅提到' : '❌未提';
  console.log(
    String(i + 1).padStart(2) + '. ' + mark +
    '　位次 ' + (res.rank || '-') +
    '　态度 ' + res.sentiment +
    '　' + r.keyword
  );
  console.log('     竞品：' + (res.competitors.length ? res.competitors.join('、') : '（无）'));
  console.log('     来源：' + (mergedSources || '（未识别到信源）'));
  console.log('     长度：' + ans.length + ' 字');
  warnTexts.forEach(function (t) { console.log('     ⚠ ' + t); });
  console.log('');
});

console.log('──── 汇总 ────');
console.log('提及 ' + hits + ' / ' + judged.length + '　提及率 ' +
  Math.round(hits / judged.length * 100) + '%');
var ranks = judged.map(function (r) { return Number(r.firstRank); })
  .filter(function (n) { return isFinite(n) && n > 0; });
console.log('平均首次位次 ' + (ranks.length ? (ranks.reduce(function (a, b) { return a + b; }, 0) / ranks.length).toFixed(1) : '-'));
console.log('没提取到引用的：' + noSrc + ' 条');

/* ---- 写出可直接导入的备份 ---- */
var outFile = inFile.replace(/\.json$/, '_已判定.json');
fs.writeFileSync(outFile, JSON.stringify({
  schema: 1,
  exportedAt: new Date().toISOString(),
  app: 'AI 可见度监测台',
  brand: cfg.brand,
  aliases: cfg.aliases,
  competitors: cfg.competitors,
  keywords: d.keywords,
  platforms: d.platforms,
  rounds: d.rounds,
  records: judged
}, null, 2), 'utf8');

console.log('\n已写出：' + outFile);
