/* ============================================================
 * 统计聚合：纯函数，独立可测
 * 输入原始记录 + 维度配置，输出看板所需的全部数字
 * ============================================================ */
(function (global) {
  'use strict';

  function isJudged(r) { return r && (r.mentioned === '是' || r.mentioned === '否'); }
  function isHit(r) { return r && r.mentioned === '是'; }

  function splitSources(s) {
    return String(s == null ? '' : s)
      .split(/[;；,，、]/)
      .map(function (x) { return x.trim(); })
      .filter(Boolean);
  }

  function byRound(records, round) {
    if (!round || round === '__all') return records.slice();
    return records.filter(function (r) { return r.round === round; });
  }

  function rate(hit, tested) {
    return tested > 0 ? hit / tested : null;
  }

  /* 合并「配置里的维度值」与「记录里实际出现的维度值」。
     采集器/手工导入可能带来配置里没有的平台、关键词或轮次，
     不合并的话这些数据会从分组图表里静默消失。 */
  function unionValues(configured, records, field) {
    var out = [], seen = {};
    function push(v) {
      if (v == null || v === '') return;
      v = String(v);
      if (seen[v]) return;
      seen[v] = 1; out.push(v);
    }
    (configured || []).forEach(push);
    (records || []).forEach(function (r) { push(r && r[field]); });
    return out;
  }

  /* 按某个维度字段聚合 */
  function group(records, field, values) {
    return values.map(function (v) {
      var list = records.filter(function (r) { return r[field] === v; });
      var hit = list.filter(isHit).length;
      var tested = list.length;
      return { label: v, tested: tested, hit: hit, rate: tested ? hit / tested : 0 };
    });
  }

  function aggregate(records, cfg) {
    cfg = cfg || {};
    records = records || [];
    var judged = records.filter(isJudged);
    var hits = judged.filter(isHit);

    var ranks = hits.map(function (r) { return Number(r.firstRank); })
      .filter(function (n) { return isFinite(n) && n > 0; });
    var avgRank = ranks.length
      ? ranks.reduce(function (a, b) { return a + b; }, 0) / ranks.length
      : null;

    var srcMap = {};
    judged.forEach(function (r) {
      splitSources(r.sources).forEach(function (s) { srcMap[s] = (srcMap[s] || 0) + 1; });
    });
    var sources = Object.keys(srcMap)
      .map(function (k) { return { label: k, count: srcMap[k] }; })
      .sort(function (a, b) { return b.count - a.count; });

    var byPlatform = group(judged, 'platform', unionValues(cfg.platforms, judged, 'platform'));
    var byKeyword = group(judged, 'keyword', unionValues(cfg.keywords, judged, 'keyword'));

    var trend = [];
    unionValues(cfg.rounds, records, 'round').forEach(function (rd) {
      var list = records.filter(function (r) { return r.round === rd && isJudged(r); });
      if (!list.length) return;
      var h = list.filter(isHit).length;
      trend.push({ label: rd, rate: h / list.length, sub: '已测 ' + list.length + ' 条' });
    });

    return {
      total: records.length,
      judged: judged.length,
      hits: hits.length,
      rate: rate(hits.length, judged.length),
      avgRank: avgRank,
      errs: judged.filter(function (r) { return r.hasError === '有'; }).length,
      sources: sources,
      sourceCount: sources.length,
      byPlatform: byPlatform,
      byKeyword: byKeyword,
      trend: trend,
      gaps: byKeyword.filter(function (k) { return k.tested > 0 && k.hit === 0; }),
      untested: byKeyword.filter(function (k) { return k.tested === 0; })
    };
  }

  var api = {
    isJudged: isJudged,
    isHit: isHit,
    splitSources: splitSources,
    byRound: byRound,
    unionValues: unionValues,
    aggregate: aggregate
  };

  global.GeoStats = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
