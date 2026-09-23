/* map3d.js — the mesh in three dimensions, placed by what was measured.
 *
 * The 2D map has to squeeze every RSSI into a plane, and a house is not a
 * plane: a node in the basement and one in the attic can both be -60 from a
 * gateway on the ground floor and still hear each other badly. With a third
 * axis the distances have room to be what they were measured as.
 *
 * Placement is stress majorization rather than a force simulation. Every
 * measured link has a target length -- topo.restLength of its RSSI, the same
 * scale the 2D springs use -- and the layout is the one that best reproduces
 * all of them at once. That makes the result a fit, with an error that can be
 * stated: the tools panel says how closely the measured links are reproduced,
 * instead of implying it by drawing something.
 *
 * A pair nobody measured gets no target. It is only kept from being closer
 * than half its path through the links that were measured, so unrelated nodes
 * spread out around the gateway rather than overlap -- without claiming a
 * distance nothing reported.
 *
 * The drawing is a plain 2D canvas with a perspective projection: a dozen
 * nodes do not need WebGL, and a page that has to open offline from the
 * add-on should not pull in a 3D engine for them. */

(function (NQ) {
  'use strict';

  var cv = null, ctx = null, dpr = 1, W = 0, H = 0;
  var els = {};
  var onSelect = null;
  var active = false;

  var graph = null;
  var pos = {};                  /* id -> [x, y, z], gateway at the origin */
  var pairs = [];                /* the layout's constraints, rebuilt per graph */
  var order = [];                /* node ids, stable */
  var settle = 0;                /* layout iterations still to run */
  var alignPending = true;
  var viewPending = true;       /* frame the layout once the canvas has a size */

  var cam = { yaw: 0.7, pitch: 0.5, dist: 900, t: [0, 0, 0] };
  var FOV = 50 * Math.PI / 180;
  var spin = false, drops = true;
  var selected = null, hover = null;
  var colors = {};
  var frameReq = false;
  var projected = [];            /* last frame's node screen positions, for hits */

  /* ---------- colours: the canvas cannot use var(), so resolve them ------ */

  var TOKENS = ['accent', 'rssi-good', 'warn', 'bad', 'unknown', 'accent-2',
                'fg', 'fg-dim', 'fg-faint', 'bg', 'line-2'];

  function readColors() {
    if (!document.body || typeof getComputedStyle !== 'function') return;
    var probe = document.createElement('i');
    probe.style.cssText = 'position:absolute;visibility:hidden';
    document.body.appendChild(probe);
    TOKENS.forEach(function (t) {
      probe.style.color = 'var(--' + t + ')';
      colors[t] = getComputedStyle(probe).color || '#888';
    });
    probe.remove();
  }

  function rssiColor(r) {
    if (r === null || r === undefined) return colors.unknown;
    if (r >= -60) return colors.accent;
    if (r >= -72) return colors['rssi-good'];
    if (r >= -82) return colors.warn;
    return colors.bad;
  }

  /* ---------- layout ---------------------------------------------------- */

  /* from the antenna-corrected RSSI; see topo.build */
  function lengthOf(e) { return NQ.topo.restLength(e.norm); }

  /* How much a link's length is to be believed: a measurement fully, a relay's
   * claim of reachability less, a path inferred from a hop count barely. */
  function trustOf(e) { return e.ends > 0 ? 1 : (e.claim ? 0.35 : 0.12); }

  function buildPairs() {
    var n = order.length;
    var idx = {};
    order.forEach(function (id, i) { idx[id] = i; });
    var INF = 1e9;
    var sp = [], direct = [];
    for (var i = 0; i < n; i++) {
      sp.push(new Array(n).fill(INF)); sp[i][i] = 0;
      direct.push(new Array(n).fill(null));
    }
    graph.edges.forEach(function (e) {
      var a = idx[e.a], b = idx[e.b];
      if (a === undefined || b === undefined) return;
      var L = lengthOf(e);
      direct[a][b] = direct[b][a] = e;
      if (L < sp[a][b]) sp[a][b] = sp[b][a] = L;
    });
    /* Floyd-Warshall: n is the size of a household mesh */
    for (var k = 0; k < n; k++)
      for (i = 0; i < n; i++)
        for (var j = 0; j < n; j++)
          if (sp[i][k] + sp[k][j] < sp[i][j]) sp[i][j] = sp[i][k] + sp[k][j];

    var far = NQ.topo.restLength(null) * 1.2;
    pairs = [];
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        var e = direct[i][j];
        if (e) {
          var t = lengthOf(e);
          pairs.push({ i: i, j: j, t: t, w: trustOf(e) / (t * t), eq: true, e: e });
        } else {
          var lb = sp[i][j] < INF ? sp[i][j] * 0.5 : far;
          pairs.push({ i: i, j: j, t: lb, w: 0.25 / (lb * lb), eq: false });
        }
      }
    }
    return sp;
  }

  /* Seed a new node on a Fibonacci sphere at its path distance from the
   * gateway: deterministic, so the same fleet opens in the same shape, and
   * already three-dimensional, which a majorization started flat would keep. */
  function seed(id, i, n, rGw) {
    var y = 1 - (i + 0.5) * 2 / Math.max(1, n);
    var r = Math.sqrt(Math.max(0, 1 - y * y));
    var th = i * Math.PI * (3 - Math.sqrt(5));
    pos[id] = [Math.cos(th) * r * rGw, y * rGw * 0.8, Math.sin(th) * r * rGw];
  }

  function setGraph(g) {
    graph = g;
    var ids = g.nodes.map(function (nd) { return nd.id; }).sort();
    if (g.gwId && ids.indexOf(g.gwId) >= 0) {
      ids.splice(ids.indexOf(g.gwId), 1); ids.unshift(g.gwId);
    }
    order = ids;
    var sp = buildPairs();
    var gi = g.gwId ? 0 : -1;
    order.forEach(function (id, i) {
      if (pos[id]) return;
      var r = gi >= 0 && sp[gi][i] < 1e9 ? sp[gi][i] : NQ.topo.restLength(null);
      seed(id, i, order.length, r);
    });
    Object.keys(pos).forEach(function (id) { if (order.indexOf(id) < 0) delete pos[id]; });
    if (g.gwId && pos[g.gwId]) pos[g.gwId] = [0, 0, 0];
    if (alignPending) {
      /* A fresh layout is solved at once, not animated: it ends with a
       * rotation, and watching it settle only to swing round is worse than
       * seeing the answer. Later updates start from here and move a little,
       * so those are animated. */
      for (var k = 0; k < 400; k++) iterate();
      alignFlat(); alignPending = false;
      viewPending = true;
      settle = 0;
      renderFit();
      if (W > 0 && active) { resetView(); viewPending = false; }
    } else {
      settle = Math.max(settle, 120);
    }
    wake();
  }

  /* One sweep of localized majorization (Gansner, Koren & North). Each node
   * moves to the weighted average of where every constraint would put it; a
   * lower bound only takes part while it is violated. */
  function iterate() {
    var n = order.length;
    var X = order.map(function (id) { return pos[id]; });
    var gwFixed = !!(graph && graph.gwId);
    var byNode = [];
    for (var i = 0; i < n; i++) byNode.push([]);
    pairs.forEach(function (p) { byNode[p.i].push(p); byNode[p.j].push(p); });

    for (i = 0; i < n; i++) {
      if (gwFixed && i === 0) continue;
      var xi = X[i], sx = 0, sy = 0, sz = 0, sw = 0;
      byNode[i].forEach(function (p) {
        var j = p.i === i ? p.j : p.i, xj = X[j];
        var dx = xi[0] - xj[0], dy = xi[1] - xj[1], dz = xi[2] - xj[2];
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (!p.eq && d >= p.t) return;
        if (d < 1e-3) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5; d = 1; }
        var s = p.t / d;
        sx += p.w * (xj[0] + dx * s);
        sy += p.w * (xj[1] + dy * s);
        sz += p.w * (xj[2] + dz * s);
        sw += p.w;
      });
      if (sw > 0) { xi[0] = sx / sw; xi[1] = sy / sw; xi[2] = sz / sw; }
    }
  }

  /* Turn the finished layout so its flattest direction points up. A house is
   * wider than it is tall, and so is a fit of one: with the least-spread axis
   * vertical the floor rings read as floor and height is what is left over.
   * Done once per layout, never on the small updates between, so the picture
   * does not swing every time an RSSI moves by a dB. */
  function alignFlat() {
    var n = order.length;
    if (n < 3) return;
    var C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    order.forEach(function (id) {
      var p = pos[id];
      for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) C[a][b] += p[a] * p[b];
    });
    function mul(v) {
      return [C[0][0] * v[0] + C[0][1] * v[1] + C[0][2] * v[2],
              C[1][0] * v[0] + C[1][1] * v[1] + C[1][2] * v[2],
              C[2][0] * v[0] + C[2][1] * v[1] + C[2][2] * v[2]];
    }
    function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
    function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    function cross(a, b) {
      return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    }
    /* power iteration for the two widest axes; the third is their cross */
    var e1 = norm([1, 0.3, 0.2]);
    for (var k = 0; k < 60; k++) e1 = norm(mul(e1));
    var e2 = norm([0.2, 0.3, 1]);
    for (k = 0; k < 60; k++) {
      e2 = mul(e2);
      var d1 = dot(e2, e1);
      e2 = norm([e2[0] - d1 * e1[0], e2[1] - d1 * e1[1], e2[2] - d1 * e1[2]]);
    }
    var up = norm(cross(e1, e2));
    order.forEach(function (id) {
      var p = pos[id];
      pos[id] = [dot(p, e1), dot(p, up), dot(p, e2)];
    });
  }

  /* How well the measured links are reproduced: the mean and worst relative
   * error of their length. This is the number that says whether the picture
   * can be believed, so it is shown rather than kept. */
  function fit() {
    var errs = [];
    pairs.forEach(function (p) {
      if (!p.eq || !p.e || p.e.ends === 0) return;
      var a = pos[order[p.i]], b = pos[order[p.j]];
      var d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      errs.push(Math.abs(d - p.t) / p.t);
    });
    if (!errs.length) return null;
    var sum = 0, worst = 0;
    errs.forEach(function (e) { sum += e; if (e > worst) worst = e; });
    return { n: errs.length, mean: sum / errs.length, worst: worst };
  }

  function renderFit() {
    if (!els.stress) return;
    var f = fit();
    if (!graph) { els.stress.textContent = ''; return; }
    if (!f) {
      els.stress.textContent = 'No measured links yet, so nothing places the devices; ' +
                               'what is drawn is only kept apart.';
      return;
    }
    els.stress.textContent = f.n + ' measured link' + (f.n === 1 ? '' : 's') +
      ' reproduced to within ' + Math.round(f.mean * 100) + ' % on average, worst ' +
      Math.round(f.worst * 100) + ' %.' +
      (f.worst > 0.3 ? ' Where it is large the measurements disagree with each ' +
                        'other -- often one end hearing the other better than back.' : '');
  }

  /* ---------- camera ---------------------------------------------------- */

  function focal() { return (H / 2) / Math.tan(FOV / 2); }

  function project(p) {
    var rx = p[0] - cam.t[0], ry = p[1] - cam.t[1], rz = p[2] - cam.t[2];
    var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    var cp = Math.cos(cam.pitch), spp = Math.sin(cam.pitch);
    var x1 = rx * cy - rz * sy;
    var z1 = rx * sy + rz * cy;
    var y2 = ry * cp - z1 * spp;
    var z2 = ry * spp + z1 * cp;
    var depth = cam.dist - z2;
    if (depth < 10) return null;
    var f = focal();
    return { x: W / 2 + f * x1 / depth, y: H / 2 - f * y2 / depth, z: depth };
  }

  function camRight() { return [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)]; }
  function camUp() {
    var sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
    return [-sp * Math.sin(cam.yaw), cp, -sp * Math.cos(cam.yaw)];
  }

  function pan(dx, dy) {
    var k = cam.dist / focal();
    var R = camRight(), U = camUp();
    for (var a = 0; a < 3; a++) cam.t[a] += (-R[a] * dx + U[a] * dy) * k;
  }

  function rotate(dx, dy) {
    cam.yaw -= dx * 0.008;
    cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch + dy * 0.008));
  }

  function zoom(f) { cam.dist = Math.max(120, Math.min(8000, cam.dist * f)); }

  function resetView() {
    var ids = Object.keys(pos);
    var c = [0, 0, 0];
    ids.forEach(function (id) { for (var a = 0; a < 3; a++) c[a] += pos[id][a]; });
    if (ids.length) for (var a = 0; a < 3; a++) c[a] /= ids.length;
    var r = 150;
    ids.forEach(function (id) {
      var p = pos[id];
      r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
    });
    cam.t = c;
    cam.yaw = 0.7; cam.pitch = 0.5;
    /* far enough that the bounding sphere fits the shorter side */
    var half = Math.min(FOV / 2, Math.atan(Math.tan(FOV / 2) * W / H));
    cam.dist = (r + 30) / Math.tan(half);
    wake();
  }

  /* ---------- drawing --------------------------------------------------- */

  function edgeLabel(e) { return NQ.map.edgeText(e); }

  function nodeRadius(nd) {
    return nd.kind === 'gateway' ? 12 : (nd.kind === 'sleeper' ? 7 : 9);
  }

  function nodeFill(nd) {
    return nd.kind === 'gateway' ? colors['accent-2']
         : nd.kind === 'sleeper' ? colors.warn
         : nd.known ? colors.accent : colors.unknown;
  }

  function label(id) { return NQ.store.shownName(id) || NQ.map.shortMac(id); }

  function draw() {
    if (!ctx || !graph) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var near = Infinity, far = 0;
    var P = {};
    order.forEach(function (id) {
      var q = project(pos[id]);
      P[id] = q;
      if (q) { near = Math.min(near, q.z); far = Math.max(far, q.z); }
    });
    var span = Math.max(1, far - near);
    function fade(z) { return 1 - 0.55 * Math.max(0, Math.min(1, (z - near) / span)); }

    drawFloor();

    /* edges and nodes painted together, far to near */
    var items = [];
    graph.edges.forEach(function (e) {
      var a = P[e.a], b = P[e.b];
      if (!a || !b || NQ.map.isHidden(e)) return;
      items.push({ z: (a.z + b.z) / 2 + 0.01, e: e, a: a, b: b });
    });
    graph.nodes.forEach(function (nd) {
      if (P[nd.id]) items.push({ z: P[nd.id].z, nd: nd, p: P[nd.id] });
    });
    items.sort(function (x, y) { return y.z - x.z; });

    var focus = selected || hover;
    projected = [];
    items.forEach(function (it) {
      if (it.e) drawEdge(it, fade(it.z), focus);
      else drawNode(it, fade(it.z), focus);
    });
    ctx.globalAlpha = 1;
  }

  function drawFloor() {
    var gw = graph.gwId && pos[graph.gwId] ? pos[graph.gwId] : [0, 0, 0];
    var rings = [-50, -70, -90];
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.font = '10px ' + monoFont();
    rings.forEach(function (dbm, ri) {
      var R = NQ.topo.restLength(dbm);
      ctx.beginPath();
      var first = true, lblAt = null;
      for (var k = 0; k <= 72; k++) {
        var a = k / 72 * Math.PI * 2;
        var q = project([gw[0] + Math.cos(a) * R, gw[1], gw[2] + Math.sin(a) * R]);
        if (!q) { first = true; continue; }
        if (first) { ctx.moveTo(q.x, q.y); first = false; } else ctx.lineTo(q.x, q.y);
        if (!lblAt || q.y > lblAt.y) lblAt = q;
      }
      ctx.strokeStyle = colors['line-2'];
      ctx.globalAlpha = 0.9 - ri * 0.15;
      ctx.stroke();
      if (lblAt) {
        ctx.fillStyle = colors['fg-faint'];
        ctx.textAlign = 'center';
        ctx.fillText(dbm + ' dBm', lblAt.x, lblAt.y + 12);
      }
    });
    /* two axes through the gateway, so the floor has a direction to it */
    var Rmax = NQ.topo.restLength(-95);
    [[1, 0], [0, 1]].forEach(function (d) {
      var a = project([gw[0] - d[0] * Rmax, gw[1], gw[2] - d[1] * Rmax]);
      var b = project([gw[0] + d[0] * Rmax, gw[1], gw[2] + d[1] * Rmax]);
      if (!a || !b) return;
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = colors['line-2'];
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });

    if (!drops) { ctx.globalAlpha = 1; return; }
    /* a line from each device down (or up) to the floor, and its foot: the
     * one cue that makes height readable on a flat screen */
    ctx.setLineDash([2, 3]);
    order.forEach(function (id) {
      if (id === graph.gwId) return;
      var p = pos[id];
      var top = project(p), foot = project([p[0], gw[1], p[2]]);
      if (!top || !foot) return;
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = colors['fg-faint'];
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(foot.x, foot.y); ctx.stroke();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = colors['fg-faint'];
      ctx.beginPath(); ctx.ellipse(foot.x, foot.y, 3, 1.6, 0, 0, Math.PI * 2); ctx.fill();
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawEdge(it, alpha, focus) {
    var e = it.e;
    var lit = focus && (e.a === focus || e.b === focus);
    var dim = focus && !lit;
    ctx.globalAlpha = alpha * (dim ? 0.3 : (e.ends > 0 ? 0.9 : 0.55));
    ctx.strokeStyle = e.ends > 0 ? rssiColor(e.best) : colors.unknown;
    ctx.lineWidth = (e.ends > 0 ? 2 : 1.3) * (lit ? 1.6 : 1);
    ctx.setLineDash(e.ends > 0 ? [] : (e.claim ? [1, 4] : [5, 5]));
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(it.a.x, it.a.y); ctx.lineTo(it.b.x, it.b.y); ctx.stroke();
    ctx.setLineDash([]);
    if (dim || (!lit && e.ends === 0)) return;
    var txt = edgeLabel(e);
    if (!txt) return;
    ctx.globalAlpha = alpha * (lit ? 1 : 0.8);
    ctx.font = (lit ? '11px ' : '10px ') + monoFont();
    ctx.textAlign = 'center';
    outlined(txt, (it.a.x + it.b.x) / 2, (it.a.y + it.b.y) / 2 - 4,
             lit ? colors.fg : colors['fg-dim']);
  }

  function drawNode(it, alpha, focus) {
    var nd = it.nd, p = it.p;
    var r = nodeRadius(nd) * Math.max(0.5, Math.min(2.2, cam.dist / p.z));
    var dim = focus && focus !== nd.id && !adjacent(focus, nd.id);
    ctx.globalAlpha = alpha * (dim ? 0.4 : 1);
    var fill = nodeFill(nd);

    ctx.fillStyle = fill;
    ctx.globalAlpha *= 0.18;
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = alpha * (dim ? 0.4 : 1);

    ctx.beginPath();
    if (nd.kind === 'sleeper') {
      ctx.moveTo(p.x, p.y - r * 1.2); ctx.lineTo(p.x + r * 1.2, p.y);
      ctx.lineTo(p.x, p.y + r * 1.2); ctx.lineTo(p.x - r * 1.2, p.y); ctx.closePath();
    } else {
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.lineWidth = selected === nd.id ? 2.5 : 2;
    ctx.strokeStyle = selected === nd.id ? colors.fg : colors.bg;
    ctx.stroke();

    ctx.font = (selected === nd.id ? '600 ' : '') + '11px ' + monoFont();
    ctx.textAlign = 'center';
    outlined(label(nd.id), p.x, p.y + r + 14, colors.fg);
    projected.push({ id: nd.id, x: p.x, y: p.y, r: r, z: p.z });
  }

  function adjacent(a, b) {
    for (var i = 0; i < graph.edges.length; i++) {
      var e = graph.edges[i];
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return true;
    }
    return false;
  }

  function outlined(txt, x, y, fill) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = colors.bg;
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(txt, x, y);
  }

  var monoCache = null;
  function monoFont() {
    if (monoCache) return monoCache;
    try {
      monoCache = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
    } catch (e) { /* stub */ }
    return monoCache || 'monospace';
  }

  /* ---------- the frame loop --------------------------------------------- */

  var interacting = false;

  function wake() {
    if (frameReq || !active) return;
    frameReq = true;
    requestAnimationFrame(frame);
  }

  function frame() {
    frameReq = false;
    if (!active) return;
    if (settle > 0) {
      for (var k = 0; k < 6 && settle > 0; k++, settle--) iterate();
      if (settle === 0) renderFit();
    }
    if (spin && !interacting) cam.yaw += 0.0035;
    draw();
    if (settle > 0 || (spin && !interacting)) wake();
  }

  /* ---------- input: mouse, pen and touch as one set of pointers --------- */

  function hit(x, y) {
    var best = null, bd = Infinity;
    projected.forEach(function (p) {
      var d = Math.hypot(p.x - x, p.y - y);
      if (d <= p.r + 10 && (d < bd || (d === bd && p.z < best.z))) { best = p; bd = d; }
    });
    return best ? best.id : null;
  }

  function wireInput() {
    var pts = {};
    var mode = null;             /* 'rotate' | 'pan' | 'pinch' */
    var last = null, pinch = null, moved = 0, lastTap = null;

    function local(ev) {
      var r = cv.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }
    function twoFinger() {
      var ids = Object.keys(pts), a = pts[ids[0]], b = pts[ids[1]];
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    cv.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

    cv.addEventListener('pointerdown', function (ev) {
      var p = local(ev);
      pts[ev.pointerId] = p;
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      interacting = true;
      var n = Object.keys(pts).length;
      if (n === 2) { mode = 'pinch'; pinch = twoFinger(); moved = 99; }
      else if (n === 1) {
        mode = (ev.button === 2 || ev.button === 1 || ev.shiftKey || ev.ctrlKey || ev.metaKey)
             ? 'pan' : 'rotate';
        last = p; moved = 0;
      }
      cv.classList.add('drag');
      ev.preventDefault();
    });

    cv.addEventListener('pointermove', function (ev) {
      var p = local(ev);
      if (!pts[ev.pointerId]) {
        /* hover, mouse only */
        var h = hit(p.x, p.y);
        if (h !== hover) { hover = h; cv.style.cursor = h ? 'pointer' : ''; draw(); }
        return;
      }
      pts[ev.pointerId] = p;
      if (mode === 'pinch' && Object.keys(pts).length >= 2) {
        var now = twoFinger();
        zoom(pinch.d / now.d);
        pan(now.x - pinch.x, now.y - pinch.y);
        pinch = now;
      } else if (last) {
        var dx = p.x - last.x, dy = p.y - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        if (mode === 'pan') pan(dx, dy); else rotate(dx, dy);
        last = p;
      }
      draw();
    });

    function up(ev) {
      var p = local(ev);
      var wasTap = mode !== 'pinch' && moved < 6 && Object.keys(pts).length === 1;
      delete pts[ev.pointerId];
      try { cv.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      var left = Object.keys(pts).length;
      if (left === 1 && mode === 'pinch') {
        /* one finger lifted from a pinch: carry on rotating with the other,
         * from where it is now rather than where it started */
        mode = 'rotate'; last = pts[Object.keys(pts)[0]]; moved = 99;
        return;
      }
      if (left > 0) return;
      mode = null; last = null; pinch = null; interacting = false;
      cv.classList.remove('drag');
      if (ev.type === 'pointerup' && wasTap) {
        var now = Date.now();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24) {
          lastTap = null;
          resetView();
          return;
        }
        lastTap = { t: now, x: p.x, y: p.y };
        var id = hit(p.x, p.y);
        if (id) {
          selected = id;
          if (onSelect) onSelect(id);
        }
      }
      draw();
      wake();
    }
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', function () {
      if (hover) { hover = null; cv.style.cursor = ''; draw(); }
    });

    cv.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var dy = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1);
      if (ev.ctrlKey) dy *= 3;   /* a trackpad pinch arrives as ctrl+wheel */
      zoom(Math.exp(dy * 0.0012));
      draw();
    }, { passive: false });
  }

  /* ---------- sizing ---------------------------------------------------- */

  function resize() {
    if (!cv) return;
    var r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    if (viewPending && graph) { viewPending = false; resetView(); }
    draw();
  }

  /* ---------- API --------------------------------------------------------- */

  function init(canvas, opts) {
    cv = canvas;
    opts = opts || {};
    onSelect = opts.onSelect || null;
    els = { stress: opts.stress || null };
    ctx = cv.getContext ? cv.getContext('2d') : null;
    readColors();
    if (NQ.theme) NQ.theme.onChange(function () { readColors(); monoCache = null; draw(); });
    if (NQ.map.onHiddenChange) NQ.map.onHiddenChange(draw);
    wireInput();
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () { resize(); }).observe(cv);
    } else if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', resize);
    }
  }

  function setActive(on) {
    active = !!on;
    if (active) { resize(); readColors(); wake(); }
  }

  function relayout() {
    Object.keys(pos).forEach(function (id) { delete pos[id]; });
    alignPending = true;
    if (graph) setGraph(graph);
  }

  NQ.map3d = {
    init: init,
    setGraph: setGraph,
    setActive: setActive,
    relayout: relayout,
    resetView: resetView,
    setSpin: function (on) { spin = !!on; wake(); },
    setDrops: function (on) { drops = !!on; draw(); },
    select: function (id) { selected = id; draw(); },
    /* for the tests: the layout without a canvas */
    _layout: function () { return { pos: pos, order: order, fit: fit() }; },
    _settle: function () { while (settle > 0) { iterate(); settle--; } }
  };
})(window.NQ = window.NQ || {});
