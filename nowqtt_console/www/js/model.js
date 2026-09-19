/* model.js — the fleet, derived from traffic.
 *
 * No DOM in this file. Every number the page shows about stability is
 * *derived*, and a bug in a derivation produces a plausible wrong number
 * rather than an error, so all of it has to be drivable from a recorded
 * capture under Deno. See test/model-test.js.
 *
 * Devices are discovered, not declared: a device exists the first time it
 * publishes. The gateway registry of plan §7 does not exist yet, so `kind` is
 * inferred from what a device publishes -- a `report` frame with a `wake`
 * counter is a sleeper, a `mesh` frame is a mains node, `bridge/stats` is the
 * gateway. */

(function (NQ) {
  'use strict';

  var HIST = 240;          /* samples kept per series, for the sparklines */

  /* The values Home Assistant owns. Left out per spec: this page is about the
   * network, and the room temperature has never explained a dropped frame. */
  var HA = /^(temp|temperature|humidity|humid|pressure|co2|lux)$/i;
  var HA_SERIES = /^(report|)\.?(temp|humid|humidity|temperature)$/i;

  function isHa(name, path) {
    if (name && HA.test(name)) return true;
    if (path && HA_SERIES.test(path)) return true;
    return false;
  }

  /* ---------- flattening ------------------------------------------------
   * Firmware aggregates many counters into one JSON frame to save airtime.
   * The console un-aggregates so each one gets its own history. The two
   * concerns stay independent: neither side has to know about the other. */

  function flatten(value, prefix, out) {
    out = out || {};
    if (value === null || value === undefined) return out;
    if (Array.isArray(value)) {
      /* Arrays in these frames are fixed tuples -- "ltx":[ok,fail,muted] --
       * so an index is a meaningful name, not a position in a list. */
      for (var i = 0; i < value.length; i++) flatten(value[i], prefix + '.' + i, out);
      return out;
    }
    if (typeof value === 'object') {
      for (var k in value) if (Object.prototype.hasOwnProperty.call(value, k)) {
        flatten(value[k], prefix ? prefix + '.' + k : k, out);
      }
      return out;
    }
    out[prefix] = value;
    return out;
  }

  function parseJson(text) {
    if (typeof text !== 'string') return null;
    var t = text.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  /* ---------- least squares --------------------------------------------
   * The textbook normal-equations form returned -2e9 KB/h for eight samples
   * that spanned no time, which would have rendered as a confident red "the
   * heap is leaking" built entirely out of rounding error. That bug is the
   * reason this function exists separately and is tested on its own. */

  function slope(points) {
    var n = points.length;
    if (n < 8) return null;
    var t0 = points[0].t;
    var span = points[n - 1].t - t0;
    if (span < 600) return null;                  /* under ten minutes says nothing */

    var sx = 0, sy = 0;
    for (var i = 0; i < n; i++) { sx += points[i].t - t0; sy += points[i].v; }
    var mx = sx / n, my = sy / n;

    var num = 0, den = 0;
    for (i = 0; i < n; i++) {
      var dx = (points[i].t - t0) - mx;
      num += dx * (points[i].v - my);
      den += dx * dx;
    }
    if (den <= 0) return null;
    return num / den;                             /* units of v per second */
  }

  /* ---------- devices --------------------------------------------------- */

  function newDevice(id, kind) {
    return {
      id: id,
      kind: kind || 'unknown',
      gw: null,
      firstSeen: 0,
      lastSeen: 0,
      online: null,
      build: null,
      topics: {},          /* name -> { raw, ts, json } */
      series: {},          /* path -> { v, ts, hist: [{t,v}] } */
      config: null,        /* { doc, ts } */
      counter: null,       /* the monotonic report counter, see below */
      seq: { name: null, first: null, last: null, count: 0, missing: 0, reboots: 0 },
      peers: null,         /* from its own topo publish, once firmware has it */
      topoTs: 0
    };
  }

  var devices = {};        /* id -> device; gateways keyed by uid, nodes by mac */
  var gwUid = null;        /* the most recently seen gateway */
  var stats = { messages: 0, bytes: 0, firstTs: 0, lastTs: 0 };

  function device(id, kind) {
    var d = devices[id];
    if (!d) { d = devices[id] = newDevice(id, kind); }
    if (kind && (d.kind === 'unknown' || (d.kind === 'node' && kind === 'sleeper'))) d.kind = kind;
    return d;
  }

  function touch(d, ts) {
    if (!d.firstSeen) d.firstSeen = ts;
    d.lastSeen = ts;
  }

  function push(d, path, v, ts) {
    if (typeof v !== 'number' && typeof v !== 'boolean') {
      d.series[path] = d.series[path] || { hist: [] };
      d.series[path].v = v;
      d.series[path].ts = ts;
      return;
    }
    var n = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    var s = d.series[path];
    if (!s) { s = d.series[path] = { hist: [] }; }
    s.v = n; s.ts = ts;
    s.hist.push({ t: ts, v: n });
    if (s.hist.length > HIST) s.hist.shift();
  }

  /* A counter that only ever increases is the only honest basis for a
   * delivery ratio: the result is a specific list of missing numbers rather
   * than a percentage nobody can act on. A counter going *backwards* is a
   * reboot, not a loss, and is scored as one -- otherwise a device rebooting
   * hourly and delivering everything in between scores 100% and looks fine. */
  function countSeq(d, name, v) {
    var s = d.seq;
    s.name = name;
    if (s.last === null) { s.first = v; s.last = v; s.count = 1; return; }
    if (v <= s.last) {
      if (v < s.last) { s.reboots++; s.first = v; s.last = v; s.count = 1; s.missing = 0; }
      return;                                      /* equal: a retained redelivery */
    }
    var skipped = v - s.last - 1;
    if (skipped > 0) s.missing += skipped;
    s.last = v;
    s.count++;
  }

  function delivery(d) {
    var s = d.seq;
    if (s.last === null || s.count < 2) return null;
    var expected = s.last - s.first + 1;
    if (expected <= 0) return null;
    return { ratio: s.count / expected, received: s.count, expected: expected,
             missing: s.missing, reboots: s.reboots, name: s.name };
  }

  function heapSlope(d) {
    var path = (d.kind === 'gateway') ? 'heap'
             : (d.kind === 'sleeper') ? null
             : 'free_heap';
    if (!path) return null;
    var s = d.series[path];
    if (!s || !s.hist.length) return null;
    var k = slope(s.hist);
    if (k === null) return null;
    return { bytesPerDay: k * 86400, samples: s.hist.length,
             spanS: s.hist[s.hist.length - 1].t - s.hist[0].t };
  }

  /* ---------- ingest ----------------------------------------------------
   * topic is  <prefix>/<uid>/<rest...>  for everything the page subscribes
   * to. Anything that does not match that shape is counted and dropped
   * rather than guessed at. */

  function ingest(topic, text, ts) {
    ts = ts || (Date.now() / 1000);
    stats.messages++;
    stats.bytes += (text ? text.length : 0);
    if (!stats.firstTs) stats.firstTs = ts;
    stats.lastTs = ts;

    var parts = topic.split('/');
    if (parts.length < 3) return null;
    var uid = parts[1];
    var rest = parts.slice(2);
    var head = rest[0];

    if (head === 'device') {
      var gw = device(uid, 'gateway');
      gw.gw = uid; gwUid = uid; touch(gw, ts);
      if (rest[1] === 'status')  { gw.online = (text === 'online'); }
      if (rest[1] === 'version') { gw.build = text; }
      if (rest[1] === 'config' && rest[2] === 'current') {
        var doc = parseJson(text);
        if (doc) gw.config = { doc: doc, ts: ts };
      }
      return { id: uid, kind: 'gateway' };
    }

    if (head === 'bridge') {
      var g = device(uid, 'gateway');
      g.gw = uid; gwUid = uid; touch(g, ts);
      var j = parseJson(text);
      if (!j) return { id: uid, kind: 'gateway' };
      if (rest[1] === 'stats') {
        g.topics['stats'] = { raw: text, ts: ts, json: j };
        var flat = flatten(j, '');
        for (var p in flat) push(g, p, flat[p], ts);
        if (typeof j.uptime_s === 'number') {
          /* The gateway has no sequence counter, so uptime going backwards is
           * the only reboot signal it gives. */
          var prev = g.series['uptime_s'];
          if (prev && prev.hist.length > 1) {
            var h = prev.hist;
            if (h[h.length - 1].v < h[h.length - 2].v) g.seq.reboots++;
          }
        }
      } else if (rest[1] === 'mesh') {
        g.topics['mesh'] = { raw: text, ts: ts, json: j };
        g.peers = Array.isArray(j.peers) ? j.peers : [];
        g.routes = Array.isArray(j.routes) ? j.routes : [];
        g.leaves = Array.isArray(j.leaves) ? j.leaves : [];
        g.topoTs = ts;
        /* A leaf named in the gateway's mailbox exists even before its first
         * report reaches us. */
        (g.leaves || []).forEach(function (l) {
          if (l && l.m) { var s = device(l.m, 'sleeper'); s.gw = uid; }
        });
      }
      return { id: uid, kind: 'gateway' };
    }

    if (head === 'dev' && rest.length >= 3) {
      var mac = rest[1];
      var dir = rest[2];                 /* 't' uplink, 'set' downlink */
      var name = rest.slice(3).join('/');
      if (dir === 'set') return { id: mac, kind: 'set', name: name };

      var d = device(mac);
      d.gw = uid; touch(d, ts);

      var body = parseJson(text);
      /* A sleeper's report moved from `report` to `state` when it became its
       * own Home Assistant grouped-state document (plan §9) -- same payload,
       * one frame per wake. Read it under its old name so every series, tile
       * and chart keyed on `report.*` carries on across the rename. Keyed on
       * `wake`, which only a sleeper report has: a mains device's grouped
       * state document is left as what it is. */
      if (name === 'state' && body && typeof body.wake === 'number') name = 'report';
      if (name === 'report' && body && typeof body.wake === 'number') d.kind = 'sleeper';
      else if (name === 'mesh' && body) d.kind = 'node';
      else if (d.kind === 'unknown') d.kind = 'node';

      if (name === 'build') d.build = text;
      if (body && body.build) d.build = body.build;

      if (name === 'config') {
        if (body) d.config = { doc: body, ts: ts };
        return { id: mac, kind: d.kind, name: name };
      }

      if (name === 'topo' && body) {
        /* Not published by any node yet -- plan §6 stage 5. The map is built
         * to consume it the moment it appears, and to say "unknown" until
         * then rather than drawing a star graph nobody measured. */
        d.peers = Array.isArray(body.peers) ? body.peers : [];
        d.routes = Array.isArray(body.routes) ? body.routes : [];
        d.topoTs = ts;
        return { id: mac, kind: d.kind, name: name };
      }

      d.topics[name] = { raw: text, ts: ts, json: body };

      if (body) {
        var f = flatten(body, name);
        for (var q in f) {
          if (isHa(null, q.replace(/^[a-z_]+\./, ''))) continue;
          push(d, q, f[q], ts);
        }
        if (name === 'mesh' && typeof body.seq === 'number')  countSeq(d, 'mesh.seq', body.seq);
        if (name === 'report' && typeof body.wake === 'number') countSeq(d, 'report.wake', body.wake);
      } else {
        var num = (text !== '' && isFinite(Number(text))) ? Number(text) : text;
        if (!isHa(name, null)) push(d, name, num, ts);
      }
      return { id: mac, kind: d.kind, name: name };
    }

    if (head === 'ota') return { id: uid, kind: 'ota', rest: rest };
    return null;
  }

  function reset() {
    devices = {}; gwUid = null;
    stats = { messages: 0, bytes: 0, firstTs: 0, lastTs: 0 };
  }

  function list() {
    var order = { gateway: 0, node: 1, sleeper: 2, unknown: 3 };
    return Object.keys(devices).map(function (k) { return devices[k]; })
      .sort(function (a, b) {
        if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
        return a.id < b.id ? -1 : 1;
      });
  }

  NQ.model = {
    ingest: ingest,
    reset: reset,
    list: list,
    get: function (id) { return devices[id] || null; },
    all: function () { return devices; },
    gateway: function () { return gwUid ? devices[gwUid] : null; },
    gwUid: function () { return gwUid; },
    stats: function () { return stats; },
    delivery: delivery,
    heapSlope: heapSlope,
    /* exported for the host tests */
    flatten: flatten,
    slope: slope,
    isHa: isHa,
    HIST: HIST
  };
})(typeof window !== 'undefined' ? (window.NQ = window.NQ || {})
                                 : (globalThis.NQ = globalThis.NQ || {}));
