/* ============================================================
 * 图表：纯 SVG，无第三方依赖
 * ============================================================ */
(function (global) {
  'use strict';

  var C = {
    good: '#16a34a',
    mid: '#f59e0b',
    bad: '#dc2626',
    none: '#d5ded9',
    grid: '#e8eeea',
    text: '#16221b',
    muted: '#77877f'
  };

  var W = 560;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ellipsis(s, n) {
    var t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  function empty(el, text) {
    el.innerHTML = '<div class="empty">' + esc(text || '暂无数据') + '</div>';
  }

  function rateColor(v) {
    if (v == null) return C.none;
    if (v >= 0.5) return C.good;
    if (v > 0) return C.mid;
    return C.bad;
  }

  /* ---------- 通用横向条形 ---------- */
  /* rows: [{label, ratio(0~1|null), right, sub, color, title, key, selected}]
     带 key 的行可点击（加 data-key 与手型光标），selected 的行加高亮标记 */
  function drawBars(el, rows) {
    var labelW = 160, barX = labelW + 8, rightW = 52;
    var barMax = W - barX - rightW;
    var rowH = 34, top = 6, H = top + rows.length * rowH + 4;

    var parts = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="条形图">'];
    rows.forEach(function (r, i) {
      var cy = top + i * rowH + rowH / 2;
      var col = r.color || C.good;
      var w = r.ratio == null ? 0 : Math.max(r.ratio * barMax, r.ratio > 0 ? 4 : 0);
      var clickable = r.key != null;
      var sel = !!r.selected;

      parts.push('<g' + (clickable ? ' data-key="' + esc(r.key) + '" style="cursor:pointer"' : '') + '>');
      parts.push('<title>' + esc(r.title || r.label) + '</title>');
      if (sel) {  // 选中标记：标签前的实心圆点
        parts.push('<circle cx="' + (labelW - 10) + '" cy="' + cy.toFixed(1) + '" r="3.5" fill="' + col + '"/>');
      }
      parts.push('<rect x="' + barX + '" y="' + (cy - 8) + '" width="' + barMax + '" height="16" rx="5" fill="#f1f5f2"/>');
      if (w > 0) {
        parts.push('<rect x="' + barX + '" y="' + (cy - 8) + '" width="' + w.toFixed(1) + '" height="16" rx="5" fill="' + col + '"/>');
      }
      parts.push('<text x="0" y="' + (cy + 4.5) + '" font-size="12.5" fill="' + C.text +
        (sel ? '" font-weight="700' : '') + '">' + esc(ellipsis(r.label, 12)) + '</text>');
      parts.push('<text x="' + (barX + barMax + 8) + '" y="' + (cy + 4.5) + '" font-size="12.5" font-weight="700" fill="' +
        (r.ratio == null ? C.muted : col) + '">' + esc(r.right || '') + '</text>');
      parts.push('</g>');
    });
    parts.push('</svg>');
    el.innerHTML = parts.join('');
  }

  /* ---------- 提及率（按平台 / 按关键词） ---------- */
  /* items: [{label, rate, tested, hit}]
     opts.clickable=true 时每行带 data-key 可点击；opts.selected 用于高亮当前筛选 */
  function rateBars(el, items, opts) {
    if (!items || !items.length) return empty(el, '暂无数据：先去「录入」页测几条');
    opts = opts || {};
    drawBars(el, items.map(function (it) {
      var v = it.tested ? it.rate : null;
      var row = {
        label: it.label,
        ratio: v,
        right: v == null ? '未测' : Math.round(v * 100) + '%',
        color: rateColor(v),
        title: it.label + '：提到 ' + it.hit + ' / 已测 ' + it.tested +
          (it.tested ? '（提及率 ' + Math.round(it.rate * 100) + '%）' : '')
      };
      if (opts.clickable) {
        row.key = it.label;
        row.selected = opts.selected != null && it.label === opts.selected;
      }
      return row;
    }));
  }

  /* ---------- 计数（引用来源 / 竞品） ---------- */
  /* items: [{label, count}] */
  function countBars(el, items, emptyText) {
    if (!items || !items.length) return empty(el, emptyText);
    var max = items.reduce(function (m, x) { return Math.max(m, x.count); }, 1);
    drawBars(el, items.map(function (x) {
      return {
        label: x.label,
        ratio: x.count / max,
        right: x.count + ' 次',
        color: C.good,
        title: x.label + '：被引用 ' + x.count + ' 次'
      };
    }));
  }

  /* ---------- 折线：轮次趋势 ---------- */
  /* points: [{label, rate, sub}] */
  function trend(el, points) {
    if (!points || points.length < 2) return empty(el, '至少完成两轮监测后，这里会显示提升曲线');
    var padL = 46, padR = 18, padT = 20, padB = 30;
    var H = 240;
    var w = W - padL - padR, h = H - padT - padB;
    var n = points.length;

    function X(i) { return padL + (w * i) / (n - 1); }
    function Y(v) { return padT + h - Math.max(0, Math.min(1, v)) * h; }

    var parts = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="趋势图">'];
    [0, 0.5, 1].forEach(function (g) {
      parts.push('<line x1="' + padL + '" y1="' + Y(g) + '" x2="' + (W - padR) + '" y2="' + Y(g) +
        '" stroke="' + C.grid + '" stroke-width="1"/>');
      parts.push('<text x="' + (padL - 8) + '" y="' + (Y(g) + 4) + '" font-size="11" fill="' + C.muted +
        '" text-anchor="end">' + Math.round(g * 100) + '%</text>');
    });

    var pts = points.map(function (p, i) { return [X(i), Y(p.rate)]; });
    parts.push('<path d="' + pts.map(function (p, i) {
      return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
    }).join(' ') + '" fill="none" stroke="' + C.good + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>');

    pts.forEach(function (p, i) {
      parts.push('<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="4.5" fill="#fff" stroke="' +
        C.good + '" stroke-width="2.5"><title>' +
        esc(points[i].label + '：' + Math.round(points[i].rate * 100) + '%（' + (points[i].sub || '') + '）') + '</title></circle>');
      parts.push('<text x="' + p[0].toFixed(1) + '" y="' + (p[1] - 13) + '" font-size="12" font-weight="700" fill="' +
        C.good + '" text-anchor="middle">' + Math.round(points[i].rate * 100) + '%</text>');
      parts.push('<text x="' + p[0].toFixed(1) + '" y="' + (H - 10) + '" font-size="12" fill="' + C.muted +
        '" text-anchor="middle">' + esc(points[i].label) + '</text>');
    });
    parts.push('</svg>');
    el.innerHTML = parts.join('');
  }

  global.GeoCharts = { rateBars: rateBars, countBars: countBars, trend: trend, esc: esc };
})(typeof window !== 'undefined' ? window : globalThis);
