/* map.js — the mesh, drawn from measurements and honest about the gaps.
 *
 * The layout is force-directed and the spring rest length comes from RSSI, so
 * a strong link pulls two nodes together and a weak one lets them drift. The
 * result correlates with the house without claiming to be a floor plan: see
 * docs/console-v2-plan.md §2 for why a metre scale would be a fiction indoors.
 *
 * Every edge is labelled in dBm, which is the measurement. Where a link was
 * reported from both ends and the two differ, BOTH numbers are shown --
 * asymmetry is the thing that explains why A hears B and B cannot answer, and
 * this project has hit that at the route, mailbox and ack levels in turn.
 *
 * An edge nobody reported is dashed and unlabelled. It is not omitted, because
 * a two-hop node does reach the gateway somehow, and it is not drawn solid,
 * because nothing measured it. */

(function (NQ) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  var sim = {
    nodes: {},          /* id -> {x,y,vx,vy,fixed} */
    graph: null,
    alpha: 1,
    running: false,
    view: { k: 1, x: 0, y: 0 },
    hover: null,
    drag: null,
    selected: null
  };

  var svg, gRoot, gEdges, gTrace, gNodes, gLabels, gDot;
  var onSelect = null;

  function el(name, attrs) {
    var e = document.createElementNS(SVG_NS, name);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function rssiColor(r) {
    if (r === null || r === undefined) return 'var(--unknown)';
    if (r >= -60) return 'var(--accent)';
    if (r >= -72) return 'var(--rssi-good)';
    if (r >= -82) return 'var(--warn)';
    return 'var(--bad)';
  }

  /* Which legend row an edge belongs to, so the legend can hide a class of
   * link. Only visibility changes: a hidden edge still shapes the layout. */
  function edgeKind(e) {
    if (e.ends > 0) {
      if (e.best >= -60) return 'strong';
      if (e.best >= -72) return 'good';
      if (e.best >= -82) return 'weak';
      return 'bad';
    }
    return e.claim ? 'claim' : 'unknown';
  }

  var hidden = {};          /* edgeKind -> true, shared with the 3D map */
  var onHidden = [];

  function setHidden(kind, off) {
    if (off) hidden[kind] = true; else delete hidden[kind];
    draw();
    onHidden.forEach(function (cb) { cb(); });
  }

  function init(svgEl, selectCb) {
    svg = svgEl;
    onSelect = selectCb;
    gRoot = el('g');
    gEdges = el('g'); gTrace = el('g'); gNodes = el('g'); gLabels = el('g'); gDot = el('g');
    gRoot.appendChild(gEdges); gRoot.appendChild(gTrace); gRoot.appendChild(gNodes);
    gRoot.appendChild(gLabels); gRoot.appendChild(gDot);
    svg.appendChild(gRoot);

    /* Pan, zoom and node dragging. A person moving a node to match where it
     * physically is makes the picture theirs; the simulation keeps it pinned
     * afterwards rather than snapping it back. */
    svg.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var f = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      var r = svg.getBoundingClientRect();
      var mx = ev.clientX - r.left, my = ev.clientY - r.top;
      sim.view.x = mx - (mx - sim.view.x) * f;
      sim.view.y = my - (my - sim.view.y) * f;
      sim.view.k *= f;
      applyView();
    }, { passive: false });

    /* Touch: one finger drags a node or pans, two pinch and pan together.
     * Every pointer is tracked so a second finger landing mid-drag turns the
     * gesture into a pinch instead of being taken for a new drag. */
    var panning = null;
    var touches = {};
    var pinch = null;

    function pinchState() {
      var ids = Object.keys(touches);
      var a = touches[ids[0]], b = touches[ids[1]];
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
               x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    svg.addEventListener('pointerdown', function (ev) {
      touches[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      if (Object.keys(touches).length === 2) {
        sim.drag = null; panning = null;
        pinch = pinchState();
        try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        return;
      }
      if (Object.keys(touches).length > 2) return;
      var id = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-node');
      if (id) {
        sim.drag = { id: id };
        sim.alpha = Math.max(sim.alpha, 0.5);
        kick();
        if (onSelect) onSelect(id);
        sim.selected = id;
      } else {
        panning = { x: ev.clientX - sim.view.x, y: ev.clientY - sim.view.y };
        svg.classList.add('drag');
      }
      svg.setPointerCapture(ev.pointerId);
    });
    svg.addEventListener('pointermove', function (ev) {
      var r = svg.getBoundingClientRect();
      if (touches[ev.pointerId]) touches[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      if (pinch && Object.keys(touches).length === 2) {
        var now = pinchState();
        var f = now.d / pinch.d;
        var px = pinch.x - r.left, py = pinch.y - r.top;
        /* zoom about where the fingers were, then follow their midpoint */
        sim.view.x = px - (px - sim.view.x) * f + (now.x - pinch.x);
        sim.view.y = py - (py - sim.view.y) * f + (now.y - pinch.y);
        sim.view.k *= f;
        pinch = now;
        applyView();
        return;
      }
      if (sim.drag) {
        var n = sim.nodes[sim.drag.id];
        if (n) {
          n.x = (ev.clientX - r.left - sim.view.x) / sim.view.k;
          n.y = (ev.clientY - r.top - sim.view.y) / sim.view.k;
          n.fixed = true; n.vx = 0; n.vy = 0;
          draw();
        }
      } else if (panning) {
        sim.view.x = ev.clientX - panning.x;
        sim.view.y = ev.clientY - panning.y;
        applyView();
      }
    });
    function up(ev) {
      delete touches[ev.pointerId];
      pinch = null;
      sim.drag = null; panning = null;
      svg.classList.remove('drag');
      try { svg.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    }
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
  }

  function applyView() {
    gRoot.setAttribute('transform',
      'translate(' + sim.view.x + ',' + sim.view.y + ') scale(' + sim.view.k + ')');
  }

  function size() {
    var r = svg.getBoundingClientRect();
    return { w: r.width || 800, h: r.height || 600 };
  }

  function setGraph(graph) {
    sim.graph = graph;
    var s = size();
    var i = 0, n = graph.nodes.length;
    graph.nodes.forEach(function (nd) {
      var p = sim.nodes[nd.id];
      if (!p) {
        /* Seeded on a circle rather than at random, so the first frames look
         * like a settling network instead of an explosion. */
        var a = (i / Math.max(1, n)) * Math.PI * 2;
        sim.nodes[nd.id] = {
          x: s.w / 2 + Math.cos(a) * 160,
          y: s.h / 2 + Math.sin(a) * 160,
          vx: 0, vy: 0, fixed: false
        };
      }
      i++;
    });
    /* The gateway is the one fixed point: it is where the network is anchored
     * and it does not move. */
    if (graph.gwId && sim.nodes[graph.gwId]) {
      sim.nodes[graph.gwId].x = s.w / 2;
      sim.nodes[graph.gwId].y = s.h / 2;
      sim.nodes[graph.gwId].fixed = true;
      sim.nodes[graph.gwId].isGw = true;
    }
    build();
    sim.alpha = 1;
    kick();
  }

  /* ---------- the simulation ------------------------------------------- */

  function step() {
    var g = sim.graph;
    if (!g) return;
    var ids = g.nodes.map(function (n) { return n.id; });
    var s = size();
    var cx = s.w / 2, cy = s.h / 2;

    /* Repulsion, so nodes with no link between them do not stack. */
    for (var i = 0; i < ids.length; i++) {
      var a = sim.nodes[ids[i]];
      if (!a) continue;
      for (var j = i + 1; j < ids.length; j++) {
        var b = sim.nodes[ids[j]];
        if (!b) continue;
        var dx = b.x - a.x, dy = b.y - a.y;
        var d2 = dx * dx + dy * dy;
        if (d2 < 1) { d2 = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        var d = Math.sqrt(d2);
        var f = 26000 / d2;
        var ux = dx / d, uy = dy / d;
        a.vx -= ux * f * 0.5; a.vy -= uy * f * 0.5;
        b.vx += ux * f * 0.5; b.vy += uy * f * 0.5;
      }
    }

    /* Springs. The rest length is the RSSI translated into pixels; an edge
     * nobody measured gets the weakest rest length and a weaker spring, so an
     * unknown link shapes the picture as little as it informs it. */
    g.edges.forEach(function (e) {
      var a = sim.nodes[e.a], b = sim.nodes[e.b];
      if (!a || !b) return;
      var rest = NQ.topo.restLength(e.norm);
      var k = e.ends > 0 ? 0.02 : (e.claim ? 0.012 : 0.005);
      var dx = b.x - a.x, dy = b.y - a.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var f = (d - rest) * k;
      var ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f;
      b.vx -= ux * f; b.vy -= uy * f;
    });

    ids.forEach(function (id) {
      var n = sim.nodes[id];
      if (!n) return;
      n.vx += (cx - n.x) * 0.0016;          /* keep the graph on screen */
      n.vy += (cy - n.y) * 0.0016;
      if (n.fixed) { n.vx = 0; n.vy = 0; return; }
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx * sim.alpha;
      n.y += n.vy * sim.alpha;
    });

    sim.alpha *= 0.985;
  }

  function kick() {
    if (sim.running) return;
    sim.running = true;
    requestAnimationFrame(function loop() {
      step(); draw();
      if (sim.alpha > 0.02 || sim.drag) { requestAnimationFrame(loop); }
      else { sim.running = false; }
    });
  }

  /* ---------- rendering ------------------------------------------------ */

  var parts = { edges: [], nodes: [] };

  function build() {
    gEdges.textContent = ''; gNodes.textContent = ''; gLabels.textContent = '';
    parts = { edges: [], nodes: [] };
    var g = sim.graph;
    if (!g) return;

    g.edges.forEach(function (e) {
      var line = el('line', {
        'stroke-width': e.ends > 0 ? 1.8 : 1.2,
        'stroke': e.ends > 0 ? rssiColor(e.best) : 'var(--unknown)',
        'stroke-linecap': 'round',
        'stroke-dasharray': e.ends > 0 ? '' : (e.claim ? '1 4' : '5 5'),
        'opacity': e.ends > 0 ? 0.85 : 0.5
      });
      gEdges.appendChild(line);
      var lbl = el('text', { class: 'edgelabel', 'text-anchor': 'middle' });
      lbl.textContent = edgeText(e);
      gLabels.appendChild(lbl);
      parts.edges.push({ e: e, line: line, lbl: lbl });
    });

    g.nodes.forEach(function (nd) {
      var grp = el('g', { 'data-node': nd.id, style: 'cursor:pointer' });
      var isGw = nd.kind === 'gateway';
      var r = isGw ? 13 : (nd.kind === 'sleeper' ? 8 : 10);
      var fill = isGw ? 'var(--accent-2)'
               : nd.kind === 'sleeper' ? 'var(--warn)'
               : nd.known ? 'var(--accent)' : 'var(--unknown)';
      var halo = el('circle', { r: r + 5, fill: fill, opacity: 0.14, 'data-node': nd.id });
      var dot = el(nd.kind === 'sleeper' ? 'rect' : 'circle', { fill: fill, 'data-node': nd.id });
      if (nd.kind === 'sleeper') {
        dot.setAttribute('width', r * 1.7); dot.setAttribute('height', r * 1.7);
      } else {
        dot.setAttribute('r', r);
      }
      dot.setAttribute('stroke', 'var(--bg)');
      dot.setAttribute('stroke-width', 2);
      grp.appendChild(halo); grp.appendChild(dot);
      gNodes.appendChild(grp);

      var t = el('text', { class: 'nodelabel', 'text-anchor': 'middle' });
      t.textContent = NQ.store.shownName(nd.id) || shortMac(nd.id);
      gLabels.appendChild(t);

      var t2 = el('text', { class: 'edgelabel', 'text-anchor': 'middle' });
      t2.textContent = nd.gwHops === 0 ? 'gateway'
                     : (nd.gwHops !== null && nd.gwHops < 0xFE ? nd.gwHops + ' hop' + (nd.gwHops === 1 ? '' : 's')
                     : (nd.kind === 'sleeper' ? 'leaf' : ''));
      gLabels.appendChild(t2);

      parts.nodes.push({ nd: nd, grp: grp, dot: dot, halo: halo, label: t, sub: t2, r: r });
    });
  }

  function edgeText(e) {
    if (e.ends === 2) {
      var vals = Object.keys(e.rssi).map(function (k) { return e.rssi[k]; });
      if (Math.abs(vals[0] - vals[1]) >= 6) {
        /* Worth showing both: a 6 dB gap between ends is the difference
         * between a link that works one way and one that works both. */
        return vals[0] + ' / ' + vals[1] + ' dBm';
      }
      return Math.round((vals[0] + vals[1]) / 2) + ' dBm';
    }
    if (e.ends === 1) return e.best + ' dBm';
    if (e.claim) return 'claimed';
    return e.hops ? e.hops + ' hops, path unknown' : 'unknown';
  }

  function shortMac(m) {
    return /^[0-9a-f]{12}$/i.test(m) ? m.slice(0, 4) + '…' + m.slice(-4) : m;
  }

  function draw() {
    parts.edges.forEach(function (p) {
      var a = sim.nodes[p.e.a], b = sim.nodes[p.e.b];
      if (!a || !b) return;
      var off = hidden[edgeKind(p.e)] ? 'none' : '';
      p.line.style.display = off; p.lbl.style.display = off;
      p.line.setAttribute('x1', a.x); p.line.setAttribute('y1', a.y);
      p.line.setAttribute('x2', b.x); p.line.setAttribute('y2', b.y);
      p.lbl.setAttribute('x', (a.x + b.x) / 2);
      p.lbl.setAttribute('y', (a.y + b.y) / 2 - 4);
    });
    parts.nodes.forEach(function (p) {
      var n = sim.nodes[p.nd.id];
      if (!n) return;
      p.halo.setAttribute('cx', n.x); p.halo.setAttribute('cy', n.y);
      if (p.nd.kind === 'sleeper') {
        p.dot.setAttribute('x', n.x - p.r * 0.85);
        p.dot.setAttribute('y', n.y - p.r * 0.85);
      } else {
        p.dot.setAttribute('cx', n.x); p.dot.setAttribute('cy', n.y);
      }
      p.label.setAttribute('x', n.x); p.label.setAttribute('y', n.y + p.r + 14);
      p.sub.setAttribute('x', n.x);   p.sub.setAttribute('y', n.y + p.r + 25);
      p.dot.setAttribute('stroke', sim.selected === p.nd.id ? 'var(--fg)' : 'var(--bg)');
    });
  }

  /* ---------- a ping's path, replayed ---------------------------------- */

  /* The real round trip takes milliseconds; this is it slowed down to be
   * watched, out in one colour and back in another, each on its own side of
   * the link so a path that returns the way it went is still two lanes. A hop
   * the gateway did not see for itself is dotted. See ping.js. */
  var trace = null;

  function traceStop() {
    trace = null;
    gTrace.textContent = ''; gDot.textContent = '';
  }

  function traceStart(p) {
    traceStop();
    var t = { p: p, t0: Date.now(), lines: [], dot: null };
    p.segs.forEach(function (sg) {
      var line = el('line', {
        'stroke': sg.dir === 'out' ? 'var(--accent-2)' : 'var(--accent)',
        'stroke-width': 3, 'stroke-linecap': 'round',
        'stroke-dasharray': sg.sure ? '' : '1 6'
      });
      gTrace.appendChild(line);
      t.lines.push(line);
    });
    t.dot = el('circle', { r: 6, stroke: 'var(--bg)', 'stroke-width': 2 });
    gDot.appendChild(t.dot);
    trace = t;
    requestAnimationFrame(function loop() {
      if (trace !== t) return;
      var st = NQ.ping.at(t.p, Date.now() - t.t0);
      if (!st) { traceStop(); return; }
      drawTrace(t, st);
      requestAnimationFrame(loop);
    });
  }

  /* A point `frac` along a→b, moved 3.5 px to the left of the direction of
   * travel. */
  function lane(a, b, frac) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: a.x + dx * frac + (dy / d) * 3.5, y: a.y + dy * frac - (dx / d) * 3.5 };
  }

  function drawTrace(t, st) {
    gTrace.setAttribute('opacity', st.alpha);
    gDot.setAttribute('opacity', st.alpha);
    st.shown.forEach(function (sh, i) {
      var line = t.lines[i];
      var a = sim.nodes[sh.seg.a], b = sim.nodes[sh.seg.b];
      if (!a || !b || sh.frac <= 0) { line.style.display = 'none'; return; }
      var p0 = lane(a, b, 0), p1 = lane(a, b, sh.frac);
      line.style.display = '';
      line.setAttribute('x1', p0.x); line.setAttribute('y1', p0.y);
      line.setAttribute('x2', p1.x); line.setAttribute('y2', p1.y);
    });
    var a = st.dot && sim.nodes[st.dot.seg.a], b = st.dot && sim.nodes[st.dot.seg.b];
    if (!a || !b) { t.dot.style.display = 'none'; return; }
    var q = lane(a, b, st.dot.frac);
    t.dot.style.display = '';
    t.dot.setAttribute('cx', q.x); t.dot.setAttribute('cy', q.y);
    t.dot.setAttribute('fill', st.dot.seg.dir === 'out' ? 'var(--accent-2)' : 'var(--accent)');
  }

  function reheat() { sim.alpha = 0.6; kick(); }

  function unpin() {
    Object.keys(sim.nodes).forEach(function (k) {
      if (!sim.nodes[k].isGw) sim.nodes[k].fixed = false;
    });
    reheat();
  }

  function fit() {
    var s = size();
    sim.view = { k: 1, x: 0, y: 0 };
    applyView();
    Object.keys(sim.nodes).forEach(function (k) { sim.nodes[k].fixed = !!sim.nodes[k].isGw; });
    if (sim.graph && sim.graph.gwId && sim.nodes[sim.graph.gwId]) {
      sim.nodes[sim.graph.gwId].x = s.w / 2;
      sim.nodes[sim.graph.gwId].y = s.h / 2;
    }
    sim.alpha = 1; kick();
  }

  NQ.map = { init: init, setGraph: setGraph, reheat: reheat, unpin: unpin,
             fit: fit, redraw: draw, edgeText: edgeText, rssiColor: rssiColor,
             shortMac: shortMac, edgeKind: edgeKind,
             isHidden: function (e) { return !!hidden[edgeKind(e)]; },
             isKindHidden: function (k) { return !!hidden[k]; },
             setHidden: setHidden,
             onHiddenChange: function (cb) { onHidden.push(cb); },
             trace: traceStart, traceStop: traceStop,
             select: function (id) { sim.selected = id; draw(); } };
})(window.NQ = window.NQ || {});
