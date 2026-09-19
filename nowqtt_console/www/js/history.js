/* history.js — the long-term series the add-on keeps, read back.
 *
 * Distinct from the sparklines on a device: those are what this tab has seen
 * since it connected, a few hundred samples at most, gone when you reload.
 * This is `/data/series.db` in the add-on -- a sample a minute, kept for
 * weeks -- and it is the only thing here that can answer "has this been
 * drifting since Tuesday".
 *
 * Available only under the add-on, because a static page has nowhere to have
 * stored anything. The view says so rather than showing an empty chart.
 *
 * The scaling is separate from the drawing and has no DOM in it, because
 * picking axis ticks and mapping points is arithmetic that fails plausibly:
 * an off-by-one in a tick step renders as a chart that looks fine and is
 * wrong. See test/history-test.js.
 */

(function (NQ) {
  'use strict';

  var RANGES = [
    { label: '1 h', seconds: 3600 },
    { label: '6 h', seconds: 6 * 3600 },
    { label: '24 h', seconds: 86400 },
    { label: '7 d', seconds: 7 * 86400 },
    { label: '30 d', seconds: 30 * 86400 }
  ];

  /* "Nice" tick steps: 1, 2, 5 and their powers of ten. A linear split of the
   * range gives ticks like 0.37 and 0.74, which nobody reads. */
  function niceStep(span, target) {
    if (!(span > 0)) return 1;
    var raw = span / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return mult * mag;
  }

  function ticks(lo, hi, target) {
    if (!(hi > lo)) return [lo];
    var step = niceStep(hi - lo, target);
    var out = [];
    var start = Math.ceil(lo / step) * step;
    for (var v = start; v <= hi + step * 1e-9 && out.length < 40; v += step) {
      /* Re-rounded because repeated addition of a fractional step drifts, and
       * a tick labelled 170.00000000000003 is its own bug report. */
      out.push(Math.round(v / step) * step);
    }
    return out;
  }

  /**
   * Map points to a drawable shape. No DOM, no side effects.
   * @param {Array<[number,number]>} points [[unix seconds, value], …]
   * @returns {object} { path, x(), y(), xTicks, yTicks, lo, hi, t0, t1, flat }
   */
  function scale(points, w, h, pad) {
    pad = pad || { l: 54, r: 10, t: 10, b: 22 };
    var n = points.length;
    if (!n) return null;

    var lo = Infinity, hi = -Infinity;
    var t0 = points[0][0], t1 = points[n - 1][0];
    for (var i = 0; i < n; i++) {
      var v = points[i][1];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }

    /* A series that never moves is the common case here -- a heap that is
     * doing its job, a hop count that has not changed. Given zero span it
     * would divide by zero and draw nothing, so pad it and say it is flat, so
     * the view can label the value instead of drawing a meaningless line at
     * the top of the box. */
    var flat = !(hi > lo);
    if (flat) {
      var mid = lo;
      lo = mid - (Math.abs(mid) * 0.05 || 1);
      hi = mid + (Math.abs(mid) * 0.05 || 1);
    }
    var tspan = (t1 - t0) || 1;

    var iw = Math.max(1, w - pad.l - pad.r);
    var ih = Math.max(1, h - pad.t - pad.b);

    function x(t) { return pad.l + ((t - t0) / tspan) * iw; }
    function y(v) { return pad.t + ih - ((v - lo) / (hi - lo)) * ih; }

    var d = '';
    for (i = 0; i < n; i++) {
      d += (i ? 'L' : 'M') + x(points[i][0]).toFixed(1) + ' ' + y(points[i][1]).toFixed(1);
    }

    return {
      path: d, x: x, y: y, lo: lo, hi: hi, t0: t0, t1: t1, flat: flat,
      yTicks: ticks(lo, hi, 4),
      xTicks: ticks(t0, t1, 5),
      pad: pad, w: w, h: h
    };
  }

  /* ---- fetches --------------------------------------------------------- */

  function get(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(path + ': ' + r.status);
      return r.json();
    });
  }

  NQ.history = {
    RANGES: RANGES,
    scale: scale,
    ticks: ticks,
    niceStep: niceStep,
    available: function () {
      var m = NQ.store.managed();
      return !!(m && m.history);
    },
    devices: function () { return get('api/history/devices'); },
    series: function (device) {
      return get('api/history/series?device=' + encodeURIComponent(device));
    },
    query: function (device, series, sinceSeconds) {
      var since = Math.floor(Date.now() / 1000 - sinceSeconds);
      return get('api/history?device=' + encodeURIComponent(device) +
                 '&series=' + encodeURIComponent(series) +
                 '&since=' + since + '&limit=3000');
    }
  };
})(typeof window !== 'undefined' ? (window.NQ = window.NQ || {})
                                 : (globalThis.NQ = globalThis.NQ || {}));
