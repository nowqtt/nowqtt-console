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

  function pushFeed(topic, text, isErr) {
    feed.push({ t: Date.now() / 1000, topic: topic, text: text, err: isErr });
    if (feed.length > cfg.feedCap) feed.splice(0, feed.length - cfg.feedCap);
  }

  /* ---------- render scheduling ---------------------------------------- */

  function schedule() {
    setInterval(function () {
      if (!dirty) { renderConn(); return; }
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
    else if (view === 'live') renderLive();
    else if (view === 'devices') NQ.views.devices();
    else if (view === 'soak') NQ.views.soak();
    else if (view === 'gateway') NQ.views.gateway();
    else if (view === 'ota') NQ.views.otaTargets();
    else if (view === 'history') NQ.views.history();
  }

  function show(v) {
    view = v;
    $$('#nav button').forEach(function (b) { b.classList.toggle('on', b.dataset.view === v); });
    $$('.view').forEach(function (s) { s.classList.toggle('on', s.dataset.view === v); });
    if (v === 'map') NQ.map.reheat();
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

  function renderMap() {
    var graph = NQ.topo.build(NQ.model.all());
    /* Rebuilding the SVG on every frame would fight the simulation, so it is
     * rebuilt only when the set of vertices or edges actually changes. */
    var key = graph.nodes.map(function (n) { return n.id + ':' + n.gwHops; }).join(',') + '|' +
              graph.edges.map(function (e) { return e.a + '-' + e.b + ':' + e.best; }).join(',');
    if (key !== lastGraphKey) { lastGraphKey = key; NQ.map.setGraph(graph); }

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
    });
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
    });
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
