/* antenna.js — how much a board's antenna costs or gains, estimated from RSSI.
 *
 * A link's RSSI is  A − 10·n·log10(d) + g_a + g_b : the distance, plus both
 * ends' antenna (and TX power) offsets. On any one link a weak antenna and a
 * long distance read the same. Fitting the whole geometry does not separate
 * them per device either -- tried, and a device's offset trades off against
 * moving it (docs/console-v2-plan.md, "Antennas").
 *
 * What does work is ONE offset per board type. Every C3 of the same design has
 * the same bad antenna; one unknown fitted to every link any of them has is
 * far better determined than one unknown per device. Simulated on a fleet like
 * this one (test/antenna-test.js: 8 mains devices over three floors, a board
 * at −15 dB, averaged RSSI, 6 dB per floor the model does not know about):
 *  - the sign is always right and most of the offset is found, typically −8 to
 *    −13 dB. It UNDER-corrects: the remaining ambiguity (weak antenna, or
 *    further away?) settles toward "further away", and floors make it worse.
 *    Moving a device most of the way to where it belongs, never past it.
 *  - a board that is really no different comes back within ~±3 dB of zero.
 *  - the ± it reports is how much the answer moves when links are resampled:
 *    stability, not accuracy. It can be ±1 dB and still 7 dB short.
 * Without floors the error roughly halves. A limit on the house's height was
 * tried and did not help.
 *
 * Two things make it work, and both are this fleet's facts, not assumptions:
 *  - devices that do NOT list each other are far apart. The peer table holds
 *    16 entries, more than the fleet, and lists everyone heard, so a missing
 *    pair means below sensitivity. Without this the estimate falls apart.
 *  - a device with no board is the reference, at 0 dB. Offsets are relative;
 *    something has to be the ruler.
 *
 * The fit is positions (3D), A, n and the board offsets together, by gradient
 * descent from a few seeded starts. The spread comes from refitting on
 * resampled links (a bootstrap), and is what decides whether an estimate is
 * applied: a number that moves by 8 dB when one link is left out is not one
 * to move devices by.
 *
 * No DOM; deterministic for a given input, so the maps do not twitch. */

(function (NQ) {
  'use strict';

  var ITER = 2500, RESTARTS = 3, BOOT = 6, BOOT_ITER = 1200;
  var NONLINK_W = 0.3;
  var MIN_LINKS = 4;         /* links of a board to an already-known end */
  var MAX_SPREAD = 6;        /* dB; beyond this the estimate is shown, not used */

  function prng(seed) {
    var s = (seed >>> 0) % 2147483647 || 1;
    return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  }

  /* ---------- from the map's graph to the fit's input ------------------ */

  /* graph: topo.build output. info(id) -> { board, manual } */
  function fromGraph(graph, info) {
    var devices = graph.nodes.map(function (n) {
      var i = info(n.id) || {};
      return { id: n.id, board: i.board || '', manual: typeof i.manual === 'number' && i.manual ? i.manual : null,
               reports: !!n.reports };
    });
    var meas = [];
    graph.edges.forEach(function (e) {
      Object.keys(e.rssi).forEach(function (by) {
        meas.push({ a: by, b: by === e.a ? e.b : e.a, rssi: e.rssi[by] });
      });
    });
    return { devices: devices, meas: meas };
  }

  /* ---------- the fit -------------------------------------------------- */

  function prepare(input) {
    var idx = {};
    var devs = input.devices.filter(function (d) {
      return input.meas.some(function (m) { return m.a === d.id || m.b === d.id; });
    });
    devs.forEach(function (d, i) { idx[d.id] = i; });
    var boards = [];
    var slot = devs.map(function (d) {
      if (d.manual !== null || !d.board) return -1;          /* fixed */
      var k = boards.indexOf(d.board);
      if (k < 0) { boards.push(d.board); k = boards.length - 1; }
      return k;
    });
    var fixed = devs.map(function (d) { return d.manual !== null ? d.manual : 0; });
    var meas = input.meas.filter(function (m) {
      return idx[m.a] !== undefined && idx[m.b] !== undefined;
    }).map(function (m) { return { i: idx[m.a], j: idx[m.b], r: m.rssi }; });
    var linked = {};
    meas.forEach(function (m) { linked[Math.min(m.i, m.j) + '|' + Math.max(m.i, m.j)] = true; });
    var nonlinks = [];
    for (var i = 0; i < devs.length; i++) {
      for (var j = i + 1; j < devs.length; j++) {
        if (devs[i].reports && devs[j].reports && !linked[i + '|' + j]) nonlinks.push({ i: i, j: j });
      }
    }
    var sens = Infinity;
    meas.forEach(function (m) { if (m.r < sens) sens = m.r; });
    return { devs: devs, boards: boards, slot: slot, fixed: fixed, meas: meas,
             nonlinks: nonlinks, sens: sens, linked: linked };
  }

  function fit(P, meas, init, iters, rnd) {
    var N = P.devs.length, B = P.boards.length;
    var X = init ? init.X.map(function (p) { return p.slice(); })
                 : P.devs.map(function () { return [rnd() * 20 - 10, rnd() * 20 - 10, rnd() * 6 - 3]; });
    var g = init ? init.g.slice() : new Array(B).fill(0);
    var A = init ? init.A : -40, n = init ? init.n : 2.7;
    var m1 = {}, m2 = {};
    function step(key, grad, lr, t) {
      m1[key] = (m1[key] || 0) * 0.9 + 0.1 * grad;
      m2[key] = (m2[key] || 0) * 0.999 + 0.001 * grad * grad;
      return lr * (m1[key] / (1 - Math.pow(0.9, t))) /
             (Math.sqrt(m2[key] / (1 - Math.pow(0.999, t))) + 1e-8);
    }
    function off(i) { return P.slot[i] < 0 ? P.fixed[i] : g[P.slot[i]]; }
    var loss = 0;
    for (var t = 1; t <= iters; t++) {
      var gX = X.map(function () { return [0, 0, 0]; });
      var gg = new Array(B).fill(0), gA = 0, gn = 0;
      loss = 0;
      var term = function (i, j, target, w, hinge) {
        var dv = [X[i][0] - X[j][0], X[i][1] - X[j][1], X[i][2] - X[j][2]];
        var d = Math.max(0.3, Math.hypot(dv[0], dv[1], dv[2]));
        var e = A - 10 * n * Math.log10(d) + off(i) + off(j) - target;
        if (hinge && e <= 0) return;
        loss += w * e * e;
        var we = w * e;
        gA += we; gn += we * (-10 * Math.log10(d));
        if (P.slot[i] >= 0) gg[P.slot[i]] += we;
        if (P.slot[j] >= 0) gg[P.slot[j]] += we;
        var dd = we * (-10 * n / (Math.LN10 * d));
        for (var a = 0; a < 3; a++) { gX[i][a] += dd * dv[a] / d; gX[j][a] -= dd * dv[a] / d; }
      };
      meas.forEach(function (m) { term(m.i, m.j, m.r, 1, false); });
      P.nonlinks.forEach(function (p) { term(p.i, p.j, P.sens, NONLINK_W, true); });
      for (var i = 0; i < N; i++) for (var a = 0; a < 3; a++) X[i][a] -= step('x' + i + a, gX[i][a], 0.03, t);
      for (var k = 0; k < B; k++) g[k] -= step('g' + k, gg[k], 0.05, t);
      A -= step('A', gA, 0.05, t);
      n = Math.min(5, Math.max(1.5, n - step('n', gn, 0.01, t)));
    }
    return { X: X, g: g, A: A, n: n, loss: loss };
  }

  /* input: { devices: [{id, board, manual, reports}], meas: [{a, b, rssi}] }
   * where `a` measured `b`. Returns per board: db, spread, links, devices, ok,
   * and why when it is not. */
  function estimate(input, seed) {
    var P = prepare(input);
    var out = { boards: {}, n: null, sensitivity: isFinite(P.sens) ? P.sens : null };
    if (!P.boards.length) return out;

    /* evidence: distinct links from a board's devices to an end whose offset
     * is not that same unknown */
    var refs = P.devs.filter(function (d, i) { return P.slot[i] < 0; }).length;
    var ev = P.boards.map(function () { return {}; });
    P.meas.forEach(function (m) {
      var si = P.slot[m.i], sj = P.slot[m.j];
      if (si >= 0 && sj !== si) ev[si][Math.min(m.i, m.j) + '|' + Math.max(m.i, m.j)] = true;
      if (sj >= 0 && si !== sj) ev[sj][Math.min(m.i, m.j) + '|' + Math.max(m.i, m.j)] = true;
    });

    var rnd = prng(seed || 1);
    var best = null;
    for (var r = 0; r < RESTARTS; r++) {
      var f = fit(P, P.meas, null, ITER, rnd);
      if (!best || f.loss < best.loss) best = f;
    }
    /* bootstrap: refit on links drawn with replacement, from the best fit */
    var samples = P.boards.map(function () { return []; });
    for (var b = 0; b < BOOT; b++) {
      var res = [];
      for (var k = 0; k < P.meas.length; k++) res.push(P.meas[Math.floor(rnd() * P.meas.length)]);
      var fb = fit(P, res, best, BOOT_ITER, rnd);
      fb.g.forEach(function (v, i) { samples[i].push(v); });
    }

    out.n = best.n;
    out.rms = Math.sqrt(best.loss / Math.max(1, P.meas.length));
    P.boards.forEach(function (name, k) {
      var s = samples[k];
      var mean = s.reduce(function (x, y) { return x + y; }, 0) / s.length;
      var sd = Math.sqrt(s.reduce(function (x, y) { return x + (y - mean) * (y - mean); }, 0) / s.length);
      var links = Object.keys(ev[k]).length;
      var devices = P.devs.filter(function (d, i) { return P.slot[i] === k; }).map(function (d) { return d.id; });
      var why = null;
      if (refs < 2) why = 'needs at least two devices with no board (or a manual value) to measure against';
      else if (links < MIN_LINKS) why = 'only ' + links + ' link' + (links === 1 ? '' : 's') + ' to other boards; needs ' + MIN_LINKS;
      else if (sd > MAX_SPREAD) why = 'too uncertain (±' + sd.toFixed(1) + ' dB)';
      out.boards[name] = { db: Math.round(best.g[k] * 10) / 10, spread: Math.round(sd * 10) / 10,
                           links: links, devices: devices, ok: !why, why: why };
    });
    return out;
  }

  /* ---------- the offset a device gets on the map ---------------------- */

  var current = { boards: {} };

  /* manual override, else its board's estimate if good enough, else 0 */
  function offset(id, info) {
    var i = info(id) || {};
    if (typeof i.manual === 'number' && i.manual) return i.manual;
    var b = i.board && current.boards[i.board];
    return b && b.ok ? b.db : 0;
  }

  NQ.antenna = {
    estimate: estimate,
    fromGraph: fromGraph,
    offset: offset,
    current: function () { return current; },
    setCurrent: function (c) { current = c || { boards: {} }; },
    MIN_LINKS: MIN_LINKS, MAX_SPREAD: MAX_SPREAD
  };
})(typeof window !== 'undefined' ? (window.NQ = window.NQ || {})
                                 : (globalThis.NQ = globalThis.NQ || {}));
