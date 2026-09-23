/* ui.js — the views.
 *
 * Rendering is throttled and only the visible view is drawn. The fleet
 * publishes a few frames a second and a re-render per message would spend the
 * whole budget laying out tables nobody is looking at. */

(function (NQ) {
  'use strict';

  var S = NQ.store;
  var cfg = S.load();

  var view = 'map';
  var selected = null;
  var dirty = true;
  var feed = [];
  var feedPaused = false;

  /* ---------- tiny DOM helpers ----------------------------------------- */

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }

  function ago(ts) {
    if (!ts) return 'never';
    var s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 2) return 'now';
    if (s < 90) return Math.round(s) + 's ago';
    if (s < 5400) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  }
  function num(v, d) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v !== 'number') return String(v);
    return d === undefined ? String(v) : v.toFixed(d);
  }
  function kb(b) { return (b / 1024).toFixed(1) + ' KB'; }
  function hhmm(ts) {
    var d = new Date(ts * 1000);
    function p(n, w) { return ('000' + n).slice(-(w || 2)); }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
           '.' + p(d.getMilliseconds(), 3);
  }

  /* A sparkline is the cheapest way to tell a number that sits still from one
   * that is drifting, which is the difference the soak is looking for. */
  function spark(hist, w, hgt) {
    w = w || 90; hgt = hgt || 18;
    if (!hist || hist.length < 2) return h('span', { class: 'faint', text: '' });
    var lo = Infinity, hi = -Infinity;
    hist.forEach(function (p) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; });
    var span = (hi - lo) || 1;
    var t0 = hist[0].t, tspan = (hist[hist.length - 1].t - t0) || 1;
    var d = hist.map(function (p, i) {
      var x = ((p.t - t0) / tspan) * (w - 2) + 1;
      var y = hgt - 1 - ((p.v - lo) / span) * (hgt - 2);
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join('');
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', w); svg.setAttribute('height', hgt);
    svg.setAttribute('class', 'sparkline');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--accent-2)');
    path.setAttribute('stroke-width', '1.2');
    svg.appendChild(path);
    return svg;
  }

  function banner(kind, text) { return h('div', { class: 'banner ' + kind, text: text }); }

  /* ---------- connection ---------------------------------------------- */

  function renderConn() {
    var st = NQ.broker.state();
    var dot = $('#conndot'), txt = $('#conntext');
    dot.className = 'dot ' + (st === 'up' ? 'up' : st === 'connecting' ? 'trying' : st === 'down' ? 'down' : '');
    var m = NQ.model.stats();
    txt.textContent = st === 'up' ? (m.messages + ' msgs')
                    : st === 'connecting' ? 'connecting'
                    : st === 'down' ? 'offline' : 'idle';
    $('#conn').title = (cfg.url || '') + (NQ.broker.lastError() ? '\n' + NQ.broker.lastError() : '');
  }

  function connect() {
    NQ.model.reset();
    feed.length = 0;
    NQ.broker.connect(cfg);
  }

  /* ---------- message routing ------------------------------------------ */

  NQ.broker.on('status', function () { renderConn(); dirty = true; });
  NQ.broker.on('error', function (msg) {
    pushFeed('!', msg, true);
    dirty = true;
  });

  NQ.broker.on('message', function (topic, payload) {
    var text = NQ.broker.asText(payload);
    NQ.model.ingest(topic, text);
    NQ.ota.onMessage(topic, text);
    pushFeed(topic, text, false);
    dirty = true;
  });

  /* Topics whose payload is never shown or kept in the feed: the network
   * backup and a restore command both carry the mesh key. */
  var SECRET = /\/bridge\/netcfg\/(export|set)$/;

  function pushFeed(topic, text, isErr) {
    if (SECRET.test(topic) && /"key"/.test(String(text))) text = '(network record with its key; not shown)';
    feed.push({ t: Date.now() / 1000, topic: topic, text: text, err: isErr });
    if (feed.length > cfg.feedCap) feed.splice(0, feed.length - cfg.feedCap);
  }

  /* ---------- render scheduling ---------------------------------------- */

  function schedule() {
    setInterval(function () {
      /* The Network tab counts its windows down between status publishes. */
      if (!dirty && view !== 'network') { renderConn(); return; }
      dirty = false;
      renderConn();
      try { render(); } catch (e) { console.error(e); }
    }, 700);
  }

  function render() {
    $('#badge-dev').textContent = NQ.model.list().filter(function (d) {
      return d.kind !== 'unknown';
    }).length;
    if (view === 'map') renderMap();
    else if (view === 'map3d') renderMap3d();
    else if (view === 'live') renderLive();
    else if (view === 'devices') NQ.views.devices();
    else if (view === 'soak') NQ.views.soak();
    else if (view === 'gateway') NQ.views.gateway();
    else if (view === 'ota') NQ.views.otaTargets();
    else if (view === 'history') NQ.views.history();
    else if (view === 'network') NQ.views.network();
  }

  function show(v) {
    view = v;
    $$('#nav button').forEach(function (b) { b.classList.toggle('on', b.dataset.view === v); });
    $$('.view').forEach(function (s) { s.classList.toggle('on', s.dataset.view === v); });
    if (v === 'map') NQ.map.reheat();
    NQ.map3d.setActive(v === 'map3d');
    dirty = true;
    render();
  }

  /* ---------- live ------------------------------------------------------ */

  function renderLive() {
    if (feedPaused) return;
    var q = ($('#live-filter').value || '').toLowerCase();
    var dev = $('#live-dev').value;

    var sel = $('#live-dev');
    var want = [''].concat(NQ.model.list().map(function (d) { return d.id; }));
    if (sel.options.length !== want.length) {
      var cur = sel.value;
      clear(sel);
      sel.appendChild(h('option', { value: '', text: 'all devices' }));
      NQ.model.list().forEach(function (d) {
        sel.appendChild(h('option', { value: d.id, text: S.label(d.id) }));
      });
      sel.value = cur;
    }

    var rows = feed.filter(function (f) {
      if (dev && f.topic.indexOf(dev) < 0) return false;
      if (!q) return true;
      return f.topic.toLowerCase().indexOf(q) >= 0 ||
             String(f.text).toLowerCase().indexOf(q) >= 0;
    });
    $('#live-count').textContent = rows.length + ' / ' + feed.length;

    var box = $('#live-feed');
    var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    clear(box);
    rows.slice(-600).forEach(function (f) {
      box.appendChild(h('div', { class: 'line' }, [
        h('span', { class: 't', text: hhmm(f.t) }),
        h('span', {}, [
          h('span', { class: f.err ? 'badc' : 'tp', text: shortTopic(f.topic) }),
          h('span', { class: 'pl', text: '  ' + String(f.text).slice(0, 400) })
        ])
      ]));
    });
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function shortTopic(t) {
    /* The prefix and uid are on every line and say nothing; the rest is the
     * information. */
    var p = t.split('/');
    return p.length > 2 ? p.slice(2).join('/') : t;
  }

  /* ---------- map glue -------------------------------------------------- */

  var lastGraphKey = '';

  /* What antenna.js needs to know about a device: its board, and a manual
   * value if somebody set one. */
  function antInfo(id) { return { board: S.board(id), manual: S.antenna(id) || null }; }

  /* The board offsets are re-estimated when what they are fitted to changes
   * -- link medians, board tags, manual values -- and at most every 20 s: a
   * fit takes ~100 ms and the medians move slowly. Deferred to its own task
   * so it never stalls a render. */
  var estKey = '', estAt = 0, estPending = false;

  function maybeEstimate(raw) {
    var input = NQ.antenna.fromGraph(raw, antInfo);
    if (!input.devices.some(function (d) { return d.board && d.manual === null; })) {
      if (estKey) { estKey = ''; NQ.antenna.setCurrent(null); dirty = true; }
      return;
    }
    var key = JSON.stringify(input.devices) + JSON.stringify(input.meas.map(function (m) {
      return m.a + m.b + Math.round(m.rssi);
    }));
    if (key === estKey || estPending || Date.now() - estAt < 20000 && estKey) return;
    estPending = true;
    setTimeout(function () {
      estPending = false;
      estAt = Date.now();
      estKey = key;
      try { NQ.antenna.setCurrent(NQ.antenna.estimate(input, 7)); }
      catch (e) { console.error(e); }
      dirty = true;
    }, 0);
  }

  function mapGraph() {
    var devs = NQ.model.all();
    maybeEstimate(NQ.topo.build(devs, { avg: S.linkAvg }));
    return NQ.topo.build(devs, {
      avg: S.linkAvg,
      antenna: function (id) { return NQ.antenna.offset(id, antInfo); }
    });
  }

  /* Rebuilding a map on every frame would fight its layout, so it is rebuilt
   * only when the vertices, the edges or what their lengths come from change. */
  function graphKey(graph) {
    return graph.nodes.map(function (n) { return n.id + ':' + n.gwHops; }).join(',') + '|' +
           graph.edges.map(function (e) { return e.a + '-' + e.b + ':' + e.best + ':' + e.norm; }).join(',');
  }

  function dB(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + ' dB'; }

  /* What the map's distances are made from, listed where the map is: a device
   * drawn somewhere other than its raw RSSI would put it should say why. */
  function renderAntenna(box, graph) {
    clear(box);
    var win = S.linksWindow();
    var measured = graph.edges.filter(function (e) { return e.ends > 0; });
    var avgd = measured.filter(function (e) { return e.samples > 1; }).length;
    box.appendChild(h('div', { text: !win
      ? 'RSSI: the latest report only. Averaging is done by the add-on.'
      : avgd
        ? 'RSSI: each link\'s median over up to ' + win + ' reports, kept by the add-on' +
          (avgd < measured.length ? ' (' + avgd + ' of ' + measured.length + ' links so far)' : '') + '.'
        : 'RSSI: the latest report; the add-on has not collected any history for these links yet.' }));

    var est = NQ.antenna.current().boards || {};
    var boards = S.boards();
    var manual = graph.nodes.map(function (n) { return n.id; })
      .filter(function (id) { return S.antenna(id); });
    if (!boards.length && !manual.length) {
      box.appendChild(h('div', { style: 'margin-top:6px', text: 'No antenna corrections. Give ' +
        'devices a board in Devices and each board\'s offset is estimated.' }));
      return;
    }
    box.appendChild(h('div', { style: 'margin-top:6px' }, [h('strong', { text: 'Antenna corrections' })]));
    boards.forEach(function (b) {
      var e = est[b];
      box.appendChild(h('div', { class: 'mono ' + (e && e.ok ? '' : 'faint'),
        text: b + ': ' + (!e ? 'estimating…'
          : dB(e.db) + ' ±' + e.spread + ', ' + e.links + ' links' + (e.ok ? '' : ' — not used: ' + e.why)) }));
    });
    manual.forEach(function (id) {
      box.appendChild(h('div', { class: 'mono', text: S.label(id) + ': ' + dB(S.antenna(id)) + ' (set by hand)' }));
    });
    box.appendChild(h('div', { class: 'faint', style: 'margin-top:4px', text: 'Subtracted before ' +
      'RSSI becomes distance; the dBm on the links is still what was measured. A board ' +
      'estimate is used only if it holds when any one device is left out of the fit (its ±); ' +
      'even then it tends to fall short of the real offset.' }));
  }

  function renderMap() {
    var graph = mapGraph();
    var key = graphKey(graph);
    if (key !== lastGraphKey) { lastGraphKey = key; NQ.map.setGraph(graph); }
    renderAntenna($('#map-antenna'), graph);

    var c = graph.coverage;
    var m = $('#map-coverage');
    clear(m);
    m.appendChild(h('div', {}, [
      h('strong', { text: graph.nodes.length + ' devices, ' + graph.edges.length + ' links' })
    ]));
    m.appendChild(h('div', { text: c.bothEnds + ' measured from both ends, ' +
                                   (c.measured - c.bothEnds) + ' from one' }));
    if (c.claimed) m.appendChild(h('div', { text: c.claimed + ' claimed but unmeasured' }));
    if (c.unknown) m.appendChild(h('div', { class: 'unk',
      text: c.unknown + ' path' + (c.unknown === 1 ? '' : 's') + ' unknown' }));
    if (c.reporters <= 1) {
      m.appendChild(h('div', { class: 'unk', style: 'margin-top:6px',
        text: 'Only the gateway reports its neighbours, so node-to-node links ' +
              'are invisible. A node publishing its own topo fills this in ' +
              '(plan §6 stage 5).' }));
    }
    if (graph.alias.how === 'derived') {
      m.appendChild(h('div', { class: 'faint', style: 'margin-top:6px',
        text: 'Gateway mesh MAC derived from its uid, not reported.' }));
    }
  }

  var lastGraphKey3d = '';

  function renderMap3d() {
    var graph = mapGraph();
    var key = graphKey(graph);
    if (key !== lastGraphKey3d) { lastGraphKey3d = key; NQ.map3d.setGraph(graph); }
    renderAntenna($('#m3-antenna'), graph);
  }

  /* ---------- boot ------------------------------------------------------ */

  function wire() {
    $$('#nav button').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.view); });
    });

    /* broker dialog */
    var dlg = $('#dlg-broker');
    $('#btn-broker').addEventListener('click', function () {
      $('#f-url').value = cfg.url; $('#f-prefix').value = cfg.prefix;
      $('#f-uid').value = cfg.uid; $('#f-user').value = cfg.user;
      $('#f-pass').value = cfg.pass; $('#f-auto').checked = !!cfg.autoconnect;
      var w = clear($('#broker-warn'));
      var m = NQ.store.managed();
      if (m) {
        w.appendChild(banner('info',
          'Served by the Home Assistant add-on, so the broker is not set here. ' +
          'The socket is proxied on this origin and the add-on puts the real ' +
          'credentials into the MQTT connection itself — this page never holds ' +
          'them, which is why the username and password are empty and disabled.' +
          (m.broker && m.broker.host
            ? ' Broker: ' + m.broker.host + ':' + m.broker.port +
              ' (from the ' + m.broker.source + ')'
            : '')));
      } else {
        var chk = S.checkUrl(cfg.url);
        if (chk.warn) w.appendChild(banner('warn', chk.warn));
        else if (!chk.ok) w.appendChild(banner('bad', chk.why));
      }
      ['#f-url', '#f-prefix', '#f-uid', '#f-user', '#f-pass'].forEach(function (sel) {
        $(sel).disabled = !!m;
      });
      $('#broker-save').disabled = !!m;
      dlg.showModal();
    });
    $('#broker-cancel').addEventListener('click', function () { dlg.close(); });
    $('#broker-disconnect').addEventListener('click', function () {
      NQ.broker.disconnect(); dlg.close();
    });
    $('#broker-save').addEventListener('click', function () {
      var url = $('#f-url').value.trim();
      var chk = S.checkUrl(url);
      if (!chk.ok) {
        clear($('#broker-warn')).appendChild(banner('bad', chk.why));
        return;
      }
      S.set({ url: url, prefix: $('#f-prefix').value.trim() || 'nowqtt',
              uid: $('#f-uid').value.trim(), user: $('#f-user').value,
              pass: $('#f-pass').value, autoconnect: $('#f-auto').checked });
      cfg = S.get();
      dlg.close();
      connect();
    });

    /* live */
    $('#live-filter').addEventListener('input', function () { dirty = true; });
    $('#live-dev').addEventListener('change', function () { dirty = true; });
    $('#live-pause').addEventListener('change', function (e) { feedPaused = e.target.checked; });
    $('#live-clear').addEventListener('click', function () { feed.length = 0; dirty = true; });

    /* map */
    NQ.map.init($('#mapsvg'), function (id) {
      selected = id;
      NQ.map.select(id);
      NQ.map3d.select(id);
    });

    /* 3d map */
    NQ.map3d.init($('#map3d'), {
      stress: $('#m3-stress'),
      onSelect: function (id) { selected = id; NQ.map.select(id); NQ.map3d.select(id); }
    });
    $('#m3-relayout').addEventListener('click', function () { NQ.map3d.relayout(); });
    $('#m3-reset').addEventListener('click', function () { NQ.map3d.resetView(); });
    $('#m3-spin').addEventListener('change', function (e) { NQ.map3d.setSpin(e.target.checked); });
    $('#m3-drops').addEventListener('change', function (e) { NQ.map3d.setDrops(e.target.checked); });

    /* The legend rows hide and show that class of link, on both maps at once. */
    $$('.maplegend button').forEach(function (b) {
      b.setAttribute('aria-pressed', 'true');
      b.addEventListener('click', function () {
        var kind = b.getAttribute('data-edge');
        var off = !NQ.map.isKindHidden(kind);
        NQ.map.setHidden(kind, off);
        $$('.maplegend button[data-edge="' + kind + '"]').forEach(function (x) {
          x.setAttribute('aria-pressed', off ? 'false' : 'true');
        });
      });
    });

    /* On a phone the map's tool panels start folded, so the map is what you
     * see first; the summary line opens them. */
    if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches) {
      $$('.maptools').forEach(function (d) { d.removeAttribute('open'); });
    }
    $('#map-reheat').addEventListener('click', function () { NQ.map.reheat(); });
    $('#map-unpin').addEventListener('click', function () { NQ.map.unpin(); });
    $('#map-fit').addEventListener('click', function () { NQ.map.fit(); });
    $('#map-p1m').value = cfg.path.p1m;
    $('#map-n').value = cfg.path.n;
    $('#map-metres').checked = !!cfg.path.show;
    $('#map-model').style.display = cfg.path.show ? '' : 'none';
    $('#map-metres').addEventListener('change', function (e) {
      cfg.path.show = e.target.checked; S.save();
      $('#map-model').style.display = e.target.checked ? '' : 'none';
      lastGraphKey = ''; dirty = true;
    });
    ['#map-p1m', '#map-n'].forEach(function (sel) {
      $(sel).addEventListener('input', function () {
        cfg.path.p1m = Number($('#map-p1m').value);
        cfg.path.n = Number($('#map-n').value);
        S.save(); lastGraphKey = ''; dirty = true;
      });
    });

    NQ.views.wireOta();
  }

  /* Is this page being served by the add-on? Asked before connecting, because
   * the answer decides the broker URL, and answered quickly or not at all --
   * a missing api/config just means the page was opened from disk or a plain
   * web server, which still works with a broker URL typed in. */
  function detectAddon() {
    if (location.protocol === 'file:') return Promise.resolve(false);
    return fetch('api/config', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var got = NQ.store.adopt(j);
        if (got) cfg = S.get();
        return got;
      })
      .catch(function () { return false; });
  }

  window.addEventListener('DOMContentLoaded', function () {
    wire();
    schedule();
    renderConn();
    detectAddon().then(function () {
      if (cfg.autoconnect) connect();
      return Promise.all([S.loadSettings(), S.loadLinks()]);
    }).then(function () { dirty = true; });
    /* Other browsers' edits and fresh link medians, once a minute. */
    setInterval(function () {
      Promise.all([S.loadSettings(), S.loadLinks()]).then(function () { dirty = true; });
    }, 60000);
    show('map');
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline is a bonus, not a requirement */ });
    }
  });

  /* exported so the later sections of this file can reach them */
  NQ.ui = { h: h, $: $, $$: $$, clear: clear, ago: ago, num: num, kb: kb,
            spark: spark, banner: banner, hhmm: hhmm,
            selected: function () { return selected; },
            select: function (id) { selected = id; dirty = true; },
            markDirty: function () { dirty = true; },
            cfg: function () { return cfg; },
            show: show };
})(window.NQ = window.NQ || {});
