/* ============================================================
 * AI 可见度监测台 · 主程序
 * ============================================================ */
(function () {
  'use strict';

  var A = window.GeoAnalyzer;
  var S = window.GeoStore;
  var CH = window.GeoCharts;
  var ST = window.GeoStats;

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var state = {
    view: 'dashboard',
    dashRound: '__all',
    dashPlatform: '__all',   // 看板平台筛选（点平台图柱子联动）
    editingId: null,
    lastAnalysis: null,
    /* 本机服务相关 */
    collectorSync: false,   // 是否已连上本机采集器（数据自动同步中）
    localServer: false,     // 是否由本地服务托管（能一键开采集）
    serverPlatforms: [],    // 本机服务提供的平台 key+名字
    runRunning: false,      // 采集任务是否在跑
    runDryRun: false,       // 本次是否试跑（不写入看板）
    runTimer: null          // 进度轮询定时器
  };

  /* 本机采集器目录（Python + 有头浏览器，仅本机运行） */
  var COLLECTOR_DIR = '../collector';

  /* ================= 基础工具 ================= */

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  var saveTimer = null;
  function flashSaved() {
    var el = $('#saveState');
    el.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { el.classList.remove('show'); }, 1200);
  }

  function esc(s) { return CH.esc(s); }

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function pct(v, digits) {
    if (v == null || isNaN(v)) return '—';
    var x = v * 100;
    var s = digits ? x.toFixed(digits) : String(Math.round(x));
    return s + '%';
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  var judgeOf = ST.isJudged;

  function taskList() {
    var d = S.get(), out = [];
    d.keywords.forEach(function (k) {
      d.platforms.forEach(function (p) {
        out.push({ keyword: k.keyword, platform: p.name, url: p.url });
      });
    });
    return out;
  }

  function doneKey(r) { return r.keyword + '|' + r.platform + '|' + r.round; }

  function doneSet(round) {
    var set = {};
    S.get().records.forEach(function (r) {
      if (round && r.round !== round) return;
      set[doneKey(r)] = true;
    });
    return set;
  }

  /* ================= 视图切换 ================= */

  function switchView(name, skipHash) {
    state.view = name;
    $$('.tab').forEach(function (t) {
      t.classList.toggle('is-active', t.dataset.view === name);
    });
    $$('.view').forEach(function (v) {
      v.classList.toggle('is-active', v.id === 'view-' + name);
    });
    if (!skipHash) {
      try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
    }
    if (name === 'dashboard') renderDashboard();
    if (name === 'record') renderRecordMeta();
    if (name === 'records') renderRecords();
    if (name === 'settings') renderSettings();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ================= 看板 ================= */

  function renderRoundSelect() {
    var d = S.get();
    var sel = $('#dashRound');
    sel.innerHTML = '<option value="__all">全部轮次</option>' +
      d.rounds.map(function (r) { return '<option value="' + esc(r) + '">' + esc(r) + '</option>'; }).join('');
    sel.value = state.dashRound;
  }

  function renderPlatformSelect() {
    var d = S.get();
    var sel = $('#dashPlatform');
    if (!sel) return;
    sel.innerHTML = '<option value="__all">全部平台</option>' +
      d.platforms.map(function (p) {
        return '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>';
      }).join('');
    sel.value = state.dashPlatform;
    if (sel.value !== state.dashPlatform) {  // 该平台已被删掉时兜底回全部
      state.dashPlatform = '__all';
      sel.value = '__all';
    }
  }

  function kpiCard(label, value, sub, cls) {
    return '<div class="kpi ' + (cls || '') + '">' +
      '<span class="k-label">' + esc(label) + '</span>' +
      '<span class="k-value">' + esc(value) + '</span>' +
      '<span class="k-sub">' + esc(sub) + '</span></div>';
  }

  function renderDashboard() {
    renderRoundSelect();
    renderPlatformSelect();
    var d = S.get();
    var cfg = {
      platforms: d.platforms.map(function (p) { return p.name; }),
      keywords: d.keywords.map(function (k) { return k.keyword; }),
      rounds: d.rounds
    };
    var byRoundRecs = ST.byRound(d.records, state.dashRound);

    /* 平台图始终展示全部平台（它就是筛选器，点了切换），
       其余 KPI / 关键词 / 来源 / 缺口跟随平台筛选联动 */
    var aggAll = ST.aggregate(byRoundRecs, cfg);
    var recs = state.dashPlatform === '__all'
      ? byRoundRecs
      : byRoundRecs.filter(function (r) { return r.platform === state.dashPlatform; });
    var agg = ST.aggregate(recs, cfg);

    var grid = '';
    grid += kpiCard('已判定条数', agg.judged,
      '共 ' + agg.total + ' 条记录', agg.judged ? '' : 'is-warn');
    grid += kpiCard('整体提及率', agg.rate == null ? '—' : pct(agg.rate, 1),
      agg.rate == null ? '还没有判定结果' : '提到 ' + agg.hits + ' / ' + agg.judged,
      agg.rate == null ? '' : (agg.rate >= 0.5 ? 'is-good' : agg.rate > 0 ? 'is-warn' : 'is-bad'));
    grid += kpiCard('平均首次位次', agg.avgRank == null ? '—' : agg.avgRank.toFixed(1),
      agg.avgRank == null ? '被提到才有位次' : '越小越好（1 = 第一个被点名）',
      agg.avgRank == null ? '' : (agg.avgRank <= 2 ? 'is-good' : agg.avgRank <= 3 ? 'is-warn' : 'is-bad'));
    grid += kpiCard('引用来源', agg.sourceCount, 'AI 引用的不同信源数', '');
    grid += kpiCard('明显错误', agg.errs, '把品牌信息说错的条数', agg.errs > 0 ? 'is-bad' : '');
    $('#kpiGrid').innerHTML = grid;

    /* 平台（可点击切换筛选）/ 关键词（跟随筛选） */
    CH.rateBars($('#chartPlatform'), aggAll.byPlatform, {
      clickable: true,
      selected: state.dashPlatform === '__all' ? null : state.dashPlatform
    });
    CH.rateBars($('#chartKeyword'), agg.byKeyword);
    CH.countBars($('#chartSource'), agg.sources.slice(0, 10),
      state.dashPlatform === '__all'
        ? '暂未提取到引用来源：AI 给出链接时才会记录'
        : state.dashPlatform + ' 还没有可统计的引用来源');
    CH.trend($('#chartTrend'), agg.trend);

    /* 卡片副标题带上当前筛选，联动效果一眼可见 */
    var tag = state.dashPlatform === '__all' ? '' : ' · 当前：' + state.dashPlatform;
    var subKw = $('#subKeyword'), subSrc = $('#subSource'), subPf = $('#subPlatform');
    if (subKw) subKw.textContent = '越低越该优先补内容' + tag;
    if (subSrc) subSrc.textContent = '我们该去哪些信源铺内容' + tag;
    if (subPf) subPf.textContent = state.dashPlatform === '__all'
      ? '点柱子可切换看板到该平台 · 再点一次还原'
      : '看板已按「' + state.dashPlatform + '」筛选 · 点「' + state.dashPlatform + '」的柱子还原';

    /* 内容缺口 */
    var gaps = agg.gaps, untested = agg.untested;
    var html = '';
    if (!agg.judged) {
      html = '<div class="empty">' + (state.dashPlatform === '__all'
        ? '还没有数据。去「录入」页测第一条，缺口清单会自动生成。'
        : state.dashPlatform + ' 还没有已判定的数据，先去测几条。') + '</div>';
    } else {
      if (gaps.length) {
        html += '<div class="flags">' + gaps.map(function (g) {
          return '<div class="flag bad"><b>缺口</b><span>' + esc(g.label) +
            '　已测 ' + g.tested + ' 条，' + g.hit + ' 次提到</span>' +
            '<button class="mini-btn" data-gap="' + esc(g.label) + '">复制选题</button></div>';
        }).join('') + '</div>';
      } else {
        html += '<div class="flag good"><b>很好</b><span>' + (state.dashPlatform === '__all' ? '已测的关键词都被提到过至少一次。' : state.dashPlatform + ' 上已测的关键词都被提到过至少一次。') + '</span></div>';
      }
      if (untested.length) {
        html += '<p class="tip">还没测的关键词：' + untested.map(function (u) { return esc(u.label); }).join('、') + '</p>';
      }
    }
    $('#gapList').innerHTML = html;

    $('#dashHint').textContent = '当前显示：' +
      (state.dashPlatform === '__all' ? '全部平台' : state.dashPlatform) + ' · ' +
      (state.dashRound === '__all' ? '全部轮次' : state.dashRound);

    /* 平台图点击 → 切换筛选（点已选中的等于取消筛选） */
    $$('#chartPlatform g[data-key]').forEach(function (g) {
      g.addEventListener('click', function () {
        var key = g.getAttribute('data-key');
        state.dashPlatform = (state.dashPlatform === key) ? '__all' : key;
        renderDashboard();
        if (state.dashPlatform !== '__all') {
          toast('看板已切换到 ' + state.dashPlatform + ' 的数据（再点一次或选「全部平台」还原）');
        }
      });
    });

    $$('#gapList [data-gap]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kw = btn.getAttribute('data-gap');
        copyText(kw + '　—— 一篇讲清楚的完整回答（含对比表、报价区间、数据来源与更新时间）');
        toast('已复制选题，可直接当明天的内容题目');
      });
    });
  }

  /* ================= 录入 ================= */

  function fillSelect(sel, items, value) {
    sel.innerHTML = items.map(function (x) {
      var v = typeof x === 'string' ? x : x.value;
      var t = typeof x === 'string' ? x : x.text;
      return '<option value="' + esc(v) + '">' + esc(t) + '</option>';
    }).join('');
    if (value != null) sel.value = value;
  }

  function renderRecordMeta() {
    var d = S.get();
    var cur = {
      k: $('#rKeyword').value,
      p: $('#rPlatform').value,
      r: $('#rRound').value
    };
    fillSelect($('#rKeyword'), d.keywords.map(function (k) {
      return { value: k.keyword, text: k.keyword + (k.category ? '（' + k.category + '）' : '') };
    }), cur.k || (d.keywords[0] && d.keywords[0].keyword));
    fillSelect($('#rPlatform'), d.platforms.map(function (p) { return p.name; }),
      cur.p || (d.platforms[0] && d.platforms[0].name));
    fillSelect($('#rRound'), d.rounds, cur.r || d.rounds[0]);
    if (!$('#rDate').value) $('#rDate').value = todayISO();
    updateTaskProgress();
    updateBatchHint();
  }

  function updateTaskProgress() {
    var round = $('#rRound').value || S.get().rounds[0];
    var tasks = taskList();
    var done = doneSet(round);
    var n = tasks.filter(function (t) { return done[t.keyword + '|' + t.platform + '|' + round]; }).length;
    var p = tasks.length ? n / tasks.length : 0;
    $('#taskProgressText').textContent = round + '：已测 ' + n + ' / ' + tasks.length + ' 条';
    $('#taskProgressBar').style.width = (p * 100).toFixed(1) + '%';
  }

  function updateBatchHint() {
    var round = $('#rRound').value || S.get().rounds[0];
    var tasks = taskList();
    var done = doneSet(round);
    var left = tasks.filter(function (t) { return !done[t.keyword + '|' + t.platform + '|' + round]; }).length;
    var n = A.splitBatch($('#batchAnswer').value).length;
    $('#batchHint').textContent = '当前 ' + round + ' 剩余 ' + left + ' 条未测' +
      (n ? '；已识别出 ' + n + ' 段回答' : '');
  }

  function setFlags(flags) {
    $('#autoFlags').innerHTML = (flags || []).map(function (f) {
      var mark = { good: '达标', warn: '注意', bad: '问题', info: '提示' }[f.level] || '提示';
      return '<div class="flag ' + f.level + '"><b>' + mark + '</b><span>' + esc(f.text) + '</span></div>';
    }).join('');
  }

  function applyAnalysis(res) {
    $('#rMentioned').value = res.mentioned ? '是' : '否';
    $('#rRank').value = res.rank || '';
    $('#rCompetitors').value = res.competitors.join('; ');
    $('#rSources').value = res.sourceText;
    $('#rSentiment').value = res.sentiment;
    $('#rHasError').value = '';
    setFlags(res.flags);
    if (!$('#rNote').value.trim() && res.sources.length) {
      $('#rNote').value = 'AI 引用了：' + res.sourceText + ' —— 需要去这些来源里补/更新我们的信息。';
    }
  }

  function clearForm(keepTask) {
    $('#rAnswer').value = '';
    $('#rMentioned').value = '';
    $('#rRank').value = '';
    $('#rCompetitors').value = '';
    $('#rSources').value = '';
    $('#rSentiment').value = '';
    $('#rHasError').value = '';
    $('#rNote').value = '';
    setFlags([]);
    state.editingId = null;
    $('#btnSave').textContent = '保存记录';
    if (!keepTask) $('#rDate').value = todayISO();
  }

  function currentTask() {
    return {
      keyword: $('#rKeyword').value,
      platform: $('#rPlatform').value,
      round: $('#rRound').value,
      url: (S.get().platforms.filter(function (p) { return p.name === $('#rPlatform').value; })[0] || {}).url
    };
  }

  function goNextUntested() {
    var round = $('#rRound').value || S.get().rounds[0];
    var done = doneSet(round);
    var tasks = taskList();
    var next = tasks.filter(function (t) { return !done[t.keyword + '|' + t.platform + '|' + round]; })[0];
    if (!next) { toast('这一轮的关键词 × 平台都测完了，换一轮或加新关键词吧'); return false; }
    $('#rKeyword').value = next.keyword;
    $('#rPlatform').value = next.platform;
    updateBatchHint();
    return true;
  }

  function saveRecord(rec) {
    if (state.editingId) {
      S.updateRecord(state.editingId, rec);
      state.editingId = null;
      $('#btnSave').textContent = '保存记录';
      flashSaved();
      return 'updated';
    }
    S.addRecord(rec);
    flashSaved();
    return 'added';
  }

  /* ================= 记录 ================= */

  function renderFilterSelects() {
    var d = S.get();
    var curR = $('#fRound').value, curP = $('#fPlatform').value;
    fillSelect($('#fRound'), [{ value: '', text: '全部轮次' }].concat(
      d.rounds.map(function (r) { return { value: r, text: r }; })), curR);
    fillSelect($('#fPlatform'), [{ value: '', text: '全部平台' }].concat(
      d.platforms.map(function (p) { return { value: p.name, text: p.name }; })), curP);
  }

  function filteredRecords() {
    var round = $('#fRound').value, pf = $('#fPlatform').value;
    var mentioned = $('#fMentioned').value, q = $('#fText').value.trim().toLowerCase();
    return S.get().records.filter(function (r) {
      if (round && r.round !== round) return false;
      if (pf && r.platform !== pf) return false;
      if (mentioned === '__blank') { if (judgeOf(r)) return false; }
      else if (mentioned && r.mentioned !== mentioned) return false;
      if (q) {
        var blob = [r.keyword, r.platform, r.sources, r.note, r.competitors, r.round]
          .join(' ').toLowerCase();
        if (blob.indexOf(q) === -1) return false;
      }
      return true;
    }).sort(function (a, b) {
      return String(b.testedAt + b.createdAt).localeCompare(String(a.testedAt + a.createdAt));
    });
  }

  function renderRecords() {
    renderFilterSelects();
    var rows = filteredRecords();
    var total = S.get().records.length;
    $('#recCount').textContent = '共 ' + total + ' 条，当前筛选出 ' + rows.length + ' 条';

    if (!rows.length) {
      $('#recTable').innerHTML = '<tbody><tr><td class="empty">还没有记录。到「录入」页测第一条，或点上面的「填入 5 条示例」先看看效果。</td></tr></tbody>';
      return;
    }
    var head = '<thead><tr>' + ['测试日期', '轮次', '关键词/提问', '平台', '是否提到',
      '位次', '来源', '备注', '操作'].map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>';
    var body = rows.map(function (r) {
      var tag = r.mentioned === '是' ? '<span class="tag yes">是</span>'
        : r.mentioned === '否' ? '<span class="tag no">否</span>'
          : '<span class="tag blank">未判定</span>';
      return '<tr>' +
        '<td>' + esc(r.testedAt || '') + '</td>' +
        '<td><span class="tag round">' + esc(r.round || '') + '</span></td>' +
        '<td>' + esc(r.keyword || '') + '</td>' +
        '<td>' + esc(r.platform || '') + '</td>' +
        '<td>' + tag + '</td>' +
        '<td>' + esc(r.firstRank || '') + '</td>' +
        '<td>' + esc(r.sources || '') + '</td>' +
        '<td>' + esc(r.note || '') + '</td>' +
        '<td style="white-space:nowrap">' +
        '<button class="mini-btn" data-edit="' + esc(r.id) + '">编辑</button> ' +
        '<button class="mini-btn" data-del="' + esc(r.id) + '">删除</button>' +
        '</td></tr>';
    }).join('');
    $('#recTable').innerHTML = head + '<tbody>' + body + '</tbody>';

    $$('#recTable [data-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-edit');
        var rec = S.get().records.filter(function (x) { return x.id === id; })[0];
        if (!rec) return;
        switchView('record');
        $('#rKeyword').value = rec.keyword;
        $('#rPlatform').value = rec.platform;
        $('#rRound').value = rec.round;
        $('#rDate').value = rec.testedAt || todayISO();
        $('#rMentioned').value = rec.mentioned || '';
        $('#rRank').value = rec.firstRank || '';
        $('#rCompetitors').value = rec.competitors || '';
        $('#rSources').value = rec.sources || '';
        $('#rSentiment').value = rec.sentiment || '';
        $('#rHasError').value = rec.hasError || '';
        $('#rNote').value = rec.note || '';
        $('#rAnswer').value = rec.rawAnswer || '';
        setFlags([{ level: 'info', text: '正在编辑已有记录，修改后点「保存记录」覆盖原记录。' }]);
        state.editingId = id;
        $('#btnSave').textContent = '保存修改';
      });
    });
    $$('#recTable [data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-del');
        if (!window.confirm('删除这条记录？删除后不可恢复（可先用「导出备份」留一份）。')) return;
        S.removeRecord(id);
        renderRecords();
        toast('已删除 1 条记录');
      });
    });
  }

  /* ================= 设置 ================= */

  function editorRow(kind, item) {
    if (kind === 'kw') {
      return '<div class="editor-row" data-id="' + esc(item.id) + '">' +
        '<input type="text" class="e-main" value="' + esc(item.keyword) + '" placeholder="关键词 / 提问">' +
        '<input type="text" class="e-cat w-cat" value="' + esc(item.category || '') + '" placeholder="分类">' +
        '<button class="del" data-delrow="1" title="删除">×</button></div>';
    }
    return '<div class="editor-row" data-id="' + esc(item.id) + '">' +
      '<input type="text" class="e-main w-cat" value="' + esc(item.name) + '" placeholder="平台名">' +
      '<input type="text" class="e-url" value="' + esc(item.url || '') + '" placeholder="https://">' +
      '<button class="del" data-delrow="1" title="删除">×</button></div>';
  }

  function renderSettings() {
    var d = S.get();
    $('#sBrand').value = d.brand;
    $('#sAliases').value = d.aliases.join('\n');
    $('#sCompetitors').value = d.competitors.join('\n');
    $('#kwEditor').innerHTML = d.keywords.map(function (k) { return editorRow('kw', k); }).join('');
    $('#pfEditor').innerHTML = d.platforms.map(function (p) { return editorRow('pf', p); }).join('');
    $$('.editor .del').forEach(function (b) {
      b.addEventListener('click', function () {
        b.parentNode.parentNode.removeChild(b.parentNode);
      });
    });
    var judged = d.records.filter(judgeOf).length;
    $('#dataStat').innerHTML =
      '记录总数：<b>' + d.records.length + '</b> 条（其中已判定 <b>' + judged + '</b> 条）<br>' +
      '关键词：<b>' + d.keywords.length + '</b> 个　平台：<b>' + d.platforms.length + '</b> 个　竞品库：<b>' + d.competitors.length + '</b> 个<br>' +
      '每条完整一轮 = 关键词 × 平台 = <b>' + (d.keywords.length * d.platforms.length) + '</b> 条记录';
  }

  function saveKeywords() {
    var rows = $$('#kwEditor .editor-row');
    var list = [];
    rows.forEach(function (row) {
      var kw = row.querySelector('.e-main').value.trim();
      if (!kw) return;
      list.push({
        id: row.getAttribute('data-id') || S.uid(),
        keyword: kw,
        category: row.querySelector('.e-cat').value.trim()
      });
    });
    if (!list.length) { toast('至少保留一个关键词'); return; }
    S.update({ keywords: list });
    flashSaved();
    toast('关键词已保存（' + list.length + ' 个）');
    renderSettings();
    renderRecordMeta();
  }

  function savePlatforms() {
    var rows = $$('#pfEditor .editor-row');
    var list = [];
    rows.forEach(function (row) {
      var name = row.querySelector('.e-main').value.trim();
      if (!name) return;
      list.push({
        id: row.getAttribute('data-id') || S.uid(),
        name: name,
        url: row.querySelector('.e-url').value.trim()
      });
    });
    if (!list.length) { toast('至少保留一个平台'); return; }
    S.update({ platforms: list });
    flashSaved();
    toast('平台已保存（' + list.length + ' 个）');
    renderSettings();
    renderRecordMeta();
  }

  /* ================= 引用来源快捷按钮 ================= */

  var SRC_CHIPS = ['知乎', '百度百科', '微信公众号', '官网', '行业报告', '招股书', '财报',
    '中国IDC圈', '36氪', '政府网站'];

  function initSourceChips() {
    var box = $('#srcChips');
    box.innerHTML = SRC_CHIPS.map(function (c) {
      return '<button type="button" class="chip" data-chip="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
    $$('#srcChips .chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var label = btn.getAttribute('data-chip');
        var input = $('#rSources');
        var cur = input.value.trim();
        var parts = cur.split(/[;；,，、]/).map(function (x) { return x.trim(); }).filter(Boolean);
        if (parts.indexOf(label) !== -1) { toast('已经加过了'); return; }
        input.value = cur ? cur.replace(/[;；,，、\s]+$/, '') + '; ' + label : label;
        input.focus();
      });
    });
  }

  /* ================= 事件绑定 ================= */

  function bind() {
    /* tabs */
    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchView(t.dataset.view); });
    });

    /* notice */
    try {
      if (localStorage.getItem('geo_monitor_notice_hidden') === '1') $('#localNotice').classList.add('hide');
    } catch (e) { /* ignore */ }
    $('#noticeClose').addEventListener('click', function () {
      $('#localNotice').classList.add('hide');
      try { localStorage.setItem('geo_monitor_notice_hidden', '1'); } catch (e) { /* ignore */ }
    });

    /* header brand */
    var qb = $('#quickBrand');
    qb.value = S.get().brand;
    qb.addEventListener('change', function () {
      var v = qb.value.trim() || S.get().brand;
      var d = S.get();
      var aliases = d.aliases.indexOf(v) === -1 ? d.aliases.concat([v]) : d.aliases;
      S.update({ brand: v, aliases: aliases });
      $('#sBrand').value = v;
      $('#sAliases').value = aliases.join('\n');
      flashSaved();
      toast('目标品牌已改为「' + v + '」');
      renderDashboard();
    });

    /* dashboard */
    $('#dashRound').addEventListener('change', function () {
      state.dashRound = $('#dashRound').value;
      renderDashboard();
    });
    $('#dashPlatform').addEventListener('change', function () {
      state.dashPlatform = $('#dashPlatform').value;
      renderDashboard();
    });

    /* record */
    $('#rRound').addEventListener('change', function () {
      updateTaskProgress();
      updateBatchHint();
    });
    $('#batchAnswer').addEventListener('input', updateBatchHint);

    $('#btnCopyQ').addEventListener('click', function () {
      var t = currentTask();
      if (!t.keyword) { toast('先到「设置」页添加关键词'); return; }
      copyText(t.keyword);
      toast('已复制问题：「' + t.keyword + '」——去平台里开新对话粘贴发送');
    });

    $('#btnOpenPlatform').addEventListener('click', function () {
      var t = currentTask();
      if (!t.url) { toast('这个平台没填网址，到「设置」页补一下'); return; }
      window.open(t.url, '_blank', 'noopener');
    });

    $('#btnNextTask').addEventListener('click', function () {
      if (goNextUntested()) toast('已跳到下一个未测任务');
    });

    $('#btnAnalyze').addEventListener('click', function () {
      var text = $('#rAnswer').value;
      if (!text.trim()) { toast('先把 AI 的回答粘进来'); return; }
      var d = S.get();
      var res = A.analyze(text, { brand: d.brand, aliases: d.aliases, competitors: d.competitors });
      state.lastAnalysis = res;
      applyAnalysis(res);
      toast(res.mentioned
        ? '判定完成：提到了我们' + (res.rank ? '（位次 ' + res.rank + '）' : '')
        : '判定完成：这条没有提到我们');
      $('#resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('#btnClearAnswer').addEventListener('click', function () {
      $('#rAnswer').value = '';
      setFlags([]);
    });

    $('#btnManual').addEventListener('click', function () {
      $('#rAnswer').value = '';
      setFlags([{ level: 'info', text: '手动模式：请按你在 AI 里看到的实际情况填写下面各项。' }]);
      $('#resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('#btnSave').addEventListener('click', function () {
      var t = currentTask();
      if (!t.keyword || !t.platform) { toast('先选好关键词和平台'); return; }
      if (!$('#rMentioned').value) { toast('请先判定「是否提到目标品牌」——留空的记录不计入提及率'); return; }
      var rec = {
        keyword: t.keyword,
        platform: t.platform,
        round: t.round,
        testedAt: $('#rDate').value || todayISO(),
        mentioned: $('#rMentioned').value,
        firstRank: $('#rRank').value ? Number($('#rRank').value) : '',
        competitors: $('#rCompetitors').value.trim(),
        sources: $('#rSources').value.trim(),
        sentiment: $('#rSentiment').value || '',
        hasError: $('#rHasError').value || '',
        rawAnswer: $('#rAnswer').value,
        note: $('#rNote').value.trim()
      };
      var what = saveRecord(rec);
      updateTaskProgress();
      clearForm(true);
      if (what === 'updated') { toast('已更新这条记录'); return; }
      if (goNextUntested()) {
        toast('已保存 · 已跳到下一个未测任务');
      } else {
        toast('已保存 · 这一轮全部测完了，去「看板」看结果');
      }
    });

    $('#btnResetForm').addEventListener('click', function () {
      clearForm(false);
      toast('表单已重置');
    });

    $('#btnBatch').addEventListener('click', function () {
      var parts = A.splitBatch($('#batchAnswer').value);
      if (!parts.length) { toast('先把多条回答粘进来，用一行 --- 分隔'); return; }
      var round = $('#rRound').value || S.get().rounds[0];
      var d = S.get();
      var done = doneSet(round);
      var tasks = taskList().filter(function (t) { return !done[t.keyword + '|' + t.platform + '|' + round]; });
      if (!tasks.length) { toast('这一轮已经没有未测任务了'); return; }

      var n = Math.min(parts.length, tasks.length);
      var batch = [];
      var hitCount = 0;
      for (var i = 0; i < n; i++) {
        var res = A.analyze(parts[i], { brand: d.brand, aliases: d.aliases, competitors: d.competitors });
        if (res.mentioned) hitCount++;
        batch.push({
          keyword: tasks[i].keyword,
          platform: tasks[i].platform,
          round: round,
          testedAt: $('#rDate').value || todayISO(),
          mentioned: res.mentioned ? '是' : '否',
          firstRank: res.rank || '',
          competitors: res.competitors.join('; '),
          sources: res.sourceText,
          sentiment: res.sentiment,
          hasError: '',
          rawAnswer: parts[i],
          note: res.mentioned ? '' : '未提到，待补内容'
        });
      }
      S.addRecords(batch);
      $('#batchAnswer').value = '';
      updateTaskProgress();
      updateBatchHint();
      flashSaved();
      toast('已判定并保存 ' + n + ' 条：' + hitCount + ' 条提到、' + (n - hitCount) + ' 条未提到'
        + (parts.length > tasks.length ? '（有 ' + (parts.length - tasks.length) + ' 段超出未测任务数，已忽略）' : ''));
    });

    /* records */
    ['#fRound', '#fPlatform', '#fMentioned'].forEach(function (sel) {
      $(sel).addEventListener('change', renderRecords);
    });
    $('#fText').addEventListener('input', renderRecords);

    $('#btnExportCsv').addEventListener('click', function () {      var rows = filteredRecords();
      if (!rows.length) { toast('当前没有可导出的记录'); return; }
      download('AI可见度监测_' + todayISO() + '.csv', S.exportCSV(rows), 'text/csv;charset=utf-8');
      toast('已导出 ' + rows.length + ' 条记录为 CSV');
    });

    $('#btnExportJson').addEventListener('click', function () {
      download('AI可见度监测_备份_' + todayISO() + '.json', S.exportJSON(), 'application/json');
      toast('备份已下载，请存到网盘或微信收藏里');
    });

    /* 一键判定：把采集来的原始回答批量过一遍判定引擎 */
    $('#btnAutoJudge').addEventListener('click', function () { autoJudgeAll(false); });

    $('#btnImportJson').addEventListener('click', function () { $('#fileImport').click(); });
    $('#fileImport').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var r = S.importJSON(String(reader.result));
          toast('导入完成：新增 ' + r.added + ' 条（文件内共 ' + r.total + ' 条，重复的已自动跳过）');
          renderRecords();
          renderSettings();
          renderRecordMeta();
        } catch (err) {
          toast('导入失败：' + (err && err.message ? err.message : '文件格式不对'));
        }
        e.target.value = '';
      };
      reader.readAsText(f);
    });

    $('#btnSeedDemo').addEventListener('click', function () {
      if (S.get().records.length && !window.confirm('当前已有记录，示例数据会追加在后面。继续？')) return;
      var n = S.seedDemo();
      renderRecords();
      renderDashboard();
      renderRecordMeta();
      toast('已填入 ' + n + ' 条示例记录，去「看板」看看效果');
    });

    $('#btnClearRecords').addEventListener('click', function () {
      var n = S.get().records.length;
      if (!n) { toast('本来就没有记录'); return; }
      if (!window.confirm('将删除全部 ' + n + ' 条记录，且不可恢复。\n建议先点「导出备份」。确定继续？')) return;
      S.clearRecords();
      renderRecords();
      renderDashboard();
      renderRecordMeta();
      toast('已清空 ' + n + ' 条记录');
    });

    /* settings */
    $('#btnSaveTarget').addEventListener('click', function () {
      var brand = $('#sBrand').value.trim();
      if (!brand) { toast('目标品牌不能为空'); return; }
      var aliases = $('#sAliases').value.split('\n').map(function (s) { return s.trim(); })
        .filter(Boolean);
      if (aliases.indexOf(brand) === -1) aliases.unshift(brand);
      var comps = $('#sCompetitors').value.split('\n').map(function (s) { return s.trim(); })
        .filter(Boolean);
      S.update({ brand: brand, aliases: aliases, competitors: comps });
      $('#quickBrand').value = brand;
      flashSaved();
      toast('已保存：品牌 + ' + aliases.length + ' 个别名 + ' + comps.length + ' 个竞品');
      renderDashboard();
    });

    $('#btnAddKw').addEventListener('click', function () {
      var div = document.createElement('div');
      div.innerHTML = editorRow('kw', { id: '', keyword: '', category: '' });
      var row = div.firstChild;
      $('#kwEditor').appendChild(row);
      row.querySelector('.del').addEventListener('click', function () { row.remove(); });
      row.querySelector('.e-main').focus();
    });
    $('#btnSaveKw').addEventListener('click', saveKeywords);

    $('#btnAddPf').addEventListener('click', function () {
      var div = document.createElement('div');
      div.innerHTML = editorRow('pf', { id: '', name: '', url: '' });
      var row = div.firstChild;
      $('#pfEditor').appendChild(row);
      row.querySelector('.del').addEventListener('click', function () { row.remove(); });
      row.querySelector('.e-main').focus();
    });
    $('#btnSavePf').addEventListener('click', savePlatforms);

    $('#btnCopyCmd').addEventListener('click', function () {
      copyText('open "' + COLLECTOR_DIR + '/运行采集.command"');
      toast('已复制启动命令：粘到终端回车，或直接双击那个 .command 文件');
    });
    $('#btnCopyPath').addEventListener('click', function () {
      copyText(COLLECTOR_DIR);
      toast('已复制采集器目录路径');
    });
    $('#btnResetAll').addEventListener('click', function () {
      if (!window.confirm('恢复出厂设置会清空所有记录、关键词与平台自定义，且不可撤销。\n请先导出备份。确定继续？')) return;
      S.reset();
      $('#quickBrand').value = S.get().brand;
      renderSettings();
      renderRecordMeta();
      renderDashboard();
      renderRecords();
      toast('已恢复出厂设置');
    });

    /* 自动测试：控制面板 + 看板顶部快捷入口 */
    $('#btnRunStart').addEventListener('click', startRun);
    $('#btnRunStop').addEventListener('click', stopRun);
    $('#btnGotoRun').addEventListener('click', function () {
      switchView('settings', false);
      /* switchView 会先平滑滚到顶部，等它滚完再把控制面板拉到眼前 */
      setTimeout(function () {
        var card = $('#cardAutoRun');
        if (!card) return;
        card.scrollIntoView({ block: 'start', behavior: 'smooth' });
        var btn = $('#btnRunStart');
        if (btn && !btn.hidden && !state.runRunning) btn.focus({ preventScroll: true });
      }, 420);
    });

    window.addEventListener('hashchange', function () {
      var v = (location.hash || '').replace('#', '');
      if (v && v !== state.view && $('#view-' + v)) switchView(v, true);
    });
  }

  /* ================= 自动判定（供按钮与采集器同步共用） ================= */

  function autoJudgeAll(silent) {
    var d = S.get();
    var cfg = { brand: d.brand, aliases: d.aliases, competitors: d.competitors };
    var pending = d.records.filter(function (r) {
      return !judgeOf(r) && String(r.rawAnswer || '').trim().length > 20;
    });
    if (!pending.length) {
      if (!silent) toast('没有可判定的记录：只有「未判定」且带回答原文的记录才能自动判定');
      return 0;
    }
    var hit = 0, noSrc = 0;
    pending.forEach(function (r) {
      var res = A.analyze(r.rawAnswer, cfg);
      /* 引用来源：采集器已经抓到的链接是最准的（页面上的真实引用），
         判定引擎从文字里认出来的只是补充。两者合并去重，绝不覆盖前者。 */
      var srcList = [];
      var seenSrc = {};
      function addSrc(s) {
        s = String(s == null ? '' : s).trim();
        if (!s || seenSrc[s]) return;
        seenSrc[s] = 1; srcList.push(s);
      }
      String(r.sources || '').split(/[;；,，、]/).forEach(addSrc);
      res.sourceText.split(/[;；,，、]/).forEach(addSrc);
      var mergedSources = srcList.join('; ');

      var patch = {
        mentioned: res.mentioned ? '是' : '否',
        firstRank: res.rank || '',
        competitors: res.competitors.join('; '),
        sources: mergedSources,
        sentiment: res.sentiment
      };
      if (res.mentioned) hit++;
      if (!mergedSources) noSrc++;
      if (!String(r.note || '').trim() || r.note === '采集器自动获取') {
        patch.note = mergedSources ? 'AI 引用：' + mergedSources : (res.mentioned ? 'AI 提到了我们，但没给出可追溯的信源' : '完全没提到目标品牌 —— 纯内容缺口');
      }
      S.updateRecord(r.id, patch);
    });
    renderRecords();
    renderDashboard();
    renderRecordMeta();
    flashSaved();
    if (!silent) {
      toast('已判定 ' + pending.length + ' 条：' + hit + ' 条提到、' + (pending.length - hit) + ' 条未提到'
        + (noSrc ? '（其中 ' + noSrc + ' 条没提取到引用来源，建议手动核对）' : ''));
    }
    return pending.length;
  }

  /* ================= 本机采集器自动同步 =================
     用「启动监测台.command」打开时，页面由本机服务提供，
     会自动读取 collector/out/ 里的采集结果并合并进看板；
     线上链接 / file:// 打开时没有这个接口，静默跳过。 */

  function updateSyncBanner() {
    var n = $('#localNotice');
    if (!n || !state.collectorSync) return;
    var body = n.querySelector('.notice-body');
    if (body) {
      body.innerHTML = '<strong>已连接本机采集器</strong>' +
        '<span>采集器每次跑完都会把结果存到 collector/out/，刷新或重开本页即自动同步进来，无需手动导入。手动改动想留档时再点「导出备份」。</span>';
    }
  }

  function refreshAllViews() {
    renderFilterSelects();
    renderRecords();
    renderDashboard();
    renderRecordMeta();
  }

  function syncFromCollector() {
    if (!/^https?:$/.test(location.protocol)) return Promise.resolve(null);
    return fetch('/api/collector-files', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (res) {
      if (!res || !Array.isArray(res.files) || !res.files.length) return null;
      state.collectorSync = true;
      updateSyncBanner();
      var chain = Promise.resolve();
      var added = 0, updated = 0, fileCount = 0;
      res.files.forEach(function (f) {
        chain = chain.then(function () {
          return fetch('/api/collector-data?file=' + encodeURIComponent(f), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; });
        }).then(function (data) {
          if (!data || !Array.isArray(data.records) || !data.records.length) return;
          fileCount++;
          var out = S.syncRecords(data.records);
          added += out.added;
          updated += out.updated;
        });
      });
      return chain.then(function () {
        if (!added && !updated) return { added: 0, updated: 0, files: fileCount };
        autoJudgeAll(true);
        refreshAllViews();
        return { added: added, updated: updated, files: fileCount };
      });
    }).catch(function () { return null; });
  }

  /* ================= 自动测试（页面上一键启动采集） =================
     只有「启动监测台.command」打开的本地版才有 /api 通道，
     页面上的按钮通过它让本机服务去启动采集器并回传实时进度。 */

  function renderRunControls() {
    var pf = $('#runPlatform');
    if (pf && !pf.options.length) {
      var opts = state.serverPlatforms.slice();
      opts.push({ key: 'all', name: '全部平台（依次采集）' });
      opts.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.key;
        o.textContent = p.name;
        pf.appendChild(o);
      });
    }
    var rd = $('#runRound');
    if (rd && !rd.options.length) {
      S.get().rounds.forEach(function (r) {
        var o = document.createElement('option');
        o.value = r; o.textContent = r;
        rd.appendChild(o);
      });
    }
  }

  function setRunUiAvailable(ok) {
    var need = $('#runNeedLocal');
    var ready = $('#runReady');
    if (need) need.hidden = !!ok;
    if (ready) ready.hidden = !ok;
    if (ok) renderRunControls();
  }

  function applyRunStatus(st) {
    if (!st) return;
    var panel = $('#runPanel');
    var bar = $('#runBar');
    var log = $('#runLog');
    var stateEl = $('#runState');
    var progEl = $('#runProgress');
    if (!panel) return;

    var hasAnything = st.running || (st.lines && st.lines.length);
    panel.hidden = !hasAnything;
    $('#btnRunStart').hidden = !!st.running;
    $('#btnRunStop').hidden = !st.running;

    if (!hasAnything) return;

    var nameMap = {};
    state.serverPlatforms.forEach(function (p) { nameMap[p.key] = p.name; });
    var who = st.platform === 'all' ? '全部平台' : (nameMap[st.platform] || st.platform);

    if (st.running) {
      stateEl.textContent = '正在采集：' + who;
      var bits = [];
      if (st.total) bits.push('第 ' + st.index + ' / ' + st.total + ' 条');
      bits.push('已抓取 ' + st.done + ' 条');
      bits.push('已用 ' + st.elapsed + ' 秒');
      progEl.textContent = bits.join('　·　');
      if (st.question) progEl.textContent += '　·　' + st.question;
      bar.parentNode.classList.remove('is-done');
      bar.style.width = (st.total ? Math.round(st.index / st.total * 100) : 4) + '%';
    } else {
      var okDone = st.returncode === 0;
      stateEl.textContent = okDone
        ? '采集已结束：' + who + '（本次抓取 ' + st.done + ' 条）'
        : '采集已停止（退出码 ' + st.returncode + '）· ' + who;
      progEl.textContent = st.logPath ? '日志：' + st.logPath.split('/').pop() : '';
      bar.parentNode.classList.add('is-done');
      bar.style.width = '100%';
    }
    if (log) {
      log.textContent = (st.lines || []).join('\n');
      log.scrollTop = log.scrollHeight;
    }
  }

  function pollRun() {
    fetch('/api/run-status', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (st) {
      if (!st) return;
      var wasRunning = state.runRunning;
      state.runRunning = !!st.running;
      applyRunStatus(st);
      if (st.running) {
        state.runTimer = setTimeout(pollRun, 1500);
      } else if (wasRunning) {
        /* 刚刚跑完：把新数据同步进来（试跑不算） */
        state.runTimer = null;
        if (state.runDryRun) {
          state.runDryRun = false;
          toast('试跑结束：看上面的日志确认抓到了字数和引用来源；结果存在 out/ 的「_试跑」文件里，不污染看板');
          return;
        }
        syncFromCollector().then(function (res) {
          if (res && (res.added || res.updated)) {
            toast('采集完成，已自动同步 ' + res.added + ' 条新数据（更新 ' + res.updated + ' 条）');
          } else {
            toast('采集完成，但没有发现新数据（可能全部跳过了）');
          }
        });
      } else {
        state.runTimer = null;
      }
    }).catch(function () { state.runTimer = null; });
  }

  function startRun() {
    var platform = $('#runPlatform').value;
    var round = $('#runRound').value;
    var scope = $('#runScope').value;
    var mode = $('#runMode').value;
    if (!platform) { toast('请先选平台'); return; }
    $('#btnRunStart').disabled = true;
    fetch('/api/run-collector', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: platform,
        round: round,
        limit: scope === 'one' ? 1 : 0,
        /* 试跑写成独立的「_试跑」文件，绝不动正式结果 */
        dryRun: scope === 'one',
        reset: scope === 'one' ? false : (mode === 'reset')
      })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    }).then(function (res) {
      $('#btnRunStart').disabled = false;
      if (!res.ok) {
        toast(res.body && res.body.error ? res.body.error : '启动失败');
        if (res.body && res.body.status) applyRunStatus(res.body.status);
        return;
      }
      state.runRunning = true;
      state.runDryRun = scope === 'one';
      applyRunStatus(res.body.status);
      toast(state.runDryRun
        ? '已开始试跑：采 1 条，结果单独存放，不改正式数据'
        : '已开始采集：浏览器窗口马上弹出来，第一次用请扫码登录');
      pollRun();
    }).catch(function () {
      $('#btnRunStart').disabled = false;
      toast('无法连接本机服务，请用「启动监测台.command」打开本地版');
    });
  }

  function stopRun() {
    fetch('/api/run-stop', { method: 'POST' }).then(function (r) { return r.json(); })
      .then(function (j) {
        toast(j && j.message ? j.message : '已停止');
        if (j && j.status) applyRunStatus(j.status);
        state.runRunning = false;
        if (state.runTimer) { clearTimeout(state.runTimer); state.runTimer = null; }
        /* 采集器是逐条落盘的，停止时已采到的部分照样同步进来 */
        setTimeout(function () {
          syncFromCollector().then(function (res) {
            if (res && (res.added || res.updated)) {
              toast('已把停止前采到的 ' + res.added + ' 条同步进来');
            }
          });
        }, 1200);
      }).catch(function () { toast('停止失败，可直接关掉弹出的浏览器窗口'); });
  }

  function initAutoRun() {
    fetch('/api/ping', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (j) {
      if (!j || !j.ok) { setRunUiAvailable(false); return; }
      state.localServer = true;
      state.serverPlatforms = Array.isArray(j.platforms) ? j.platforms : [];
      setRunUiAvailable(true);
      /* 顶部挂一个「本机版」徽标，一眼分清和线上版的区别 */
      var badge = $('#modeBadge');
      if (badge) badge.hidden = false;
      document.title = 'AI 可见度监测台（本机版）';
      /* 页面打开时若已有任务在跑（比如换了标签页），接着显示进度 */
      pollRun();
    }).catch(function () { setRunUiAvailable(false); });
  }

  /* ================= 启动 ================= */

  function init() {
    var d = S.get();
    S.save();
    bind();
    initSourceChips();
    var v = (location.hash || '').replace('#', '');
    switchView($('#view-' + v) ? v : 'dashboard', true);

    try {
      localStorage.setItem('geo_monitor_probe', '1');
      localStorage.removeItem('geo_monitor_probe');
    } catch (e) {
      toast('当前浏览器禁用了本机存储，数据无法保存——请换 Chrome/Edge 或关闭无痕模式');
    }
    if (!d.records.length) {
      setTimeout(function () {
        toast('第一次使用：可先到「记录」页点「填入 5 条示例」看效果，再清空开始真测');
      }, 900);
    }

    /* 用「启动监测台.command」打开时，自动读取本机采集结果、并启用一键自动测试 */
    syncFromCollector();
    initAutoRun();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
