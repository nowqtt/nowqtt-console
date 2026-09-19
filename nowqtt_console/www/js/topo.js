/* topo.js — assemble a graph out of what the fleet actually reports.
 *
 * No DOM. The whole point of this file being separate and pure is that
 * "which edges exist" is a derivation, and a wrong derivation here draws a
 * confident picture of a network that does not exist. See test/topo-test.js.
 *
 * THE RULE: an edge is drawn only where something reported it. A node that
 * says `gw_hops: 2` must reach the gateway through *some* relay, but if
 * nothing names that relay the edge is `unknown` -- dashed, unlabelled, and
 * counted in the legend -- not guessed from the route table. The project's own
 * standard for a soak tile that measures nothing applies to a drawn line that
 * measures nothing.
 *
 * Evidence available today (retained, from the gateway):
 *   bridge/mesh .peers[]   -> gateway<->neighbour, with RSSI as the GATEWAY
 *                             measured it
 *   bridge/mesh .leaves[]  -> which relay claims each sleeper (no RSSI)
 *   bridge/mesh .routes[]  -> destination via next hop
 * Evidence that arrives with plan §6 stage 5 (a node publishing `topo`):
 *   dev/<mac>/t/topo .peers[] -> every node<->node link, with RSSI from the
 *                             OTHER end too, which is what makes asymmetry
 *                             visible instead of inferred.
 */

(function (NQ) {
  'use strict';

  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  /* The gateway's uid is its *Ethernet* MAC; the mesh sees its *Wi-Fi* MAC,
   * which on this hardware is the base MAC three below it (uid ...ED13 is the
   * device whose hellos say ...ED10). Resolving that alias is what stops the
   * gateway appearing twice in the graph -- once as the uid that publishes and
   * once as the MAC its neighbours name.
   *
   * Preferred evidence: a peer entry reporting `gw: 0` *is* the gateway, since
   * gw_hops 0 means "I am it". The arithmetic is the fallback, and is reported
   * as derived so the map can say which it used. */
  function gatewayAlias(gwDev, devices) {
    var out = { mac: null, how: 'none' };
    if (!gwDev) return out;

    for (var id in devices) {
      var peers = devices[id].peers;
      if (!Array.isArray(peers)) continue;
      for (var i = 0; i < peers.length; i++) {
        if (peers[i] && peers[i].gw === 0 && peers[i].m) {
          return { mac: String(peers[i].m).toLowerCase(), how: 'reported' };
        }
      }
    }

    var hex = String(gwDev.id || '').toLowerCase();
    if (/^[0-9a-f]{12}$/.test(hex)) {
      var last = parseInt(hex.slice(10), 16);
      if (last >= 3) {
        out.mac = hex.slice(0, 10) + ('0' + (last - 3).toString(16)).slice(-2);
        out.how = 'derived';
      }
    }
    return out;
  }

  function build(devices, opts) {
    opts = opts || {};
    var gwDev = null;
    for (var k in devices) if (devices[k].kind === 'gateway') gwDev = devices[k];

    var alias = gatewayAlias(gwDev, devices);
    var gwId = gwDev ? gwDev.id : null;

    /* Every mesh MAC that is really the gateway resolves to the gateway's id,
     * so an edge reported against either name lands on one vertex. */
    function resolve(mac) {
      if (!mac) return null;
      var m = String(mac).toLowerCase();
      if (alias.mac && m === alias.mac) return gwId;
      if (gwId && m === String(gwId).toLowerCase()) return gwId;
      return m;
    }

    var nodes = {};
    var edges = {};

    function vertex(id, kind) {
      if (!id) return null;
      if (!nodes[id]) {
        nodes[id] = { id: id, kind: kind || 'unknown', gwHops: null,
                      build: null, lastSeen: 0, known: false };
      }
      if (kind && nodes[id].kind === 'unknown') nodes[id].kind = kind;
      return nodes[id];
    }

    /* Known devices first, so a vertex only mentioned in someone's peer list
     * is distinguishable from one that publishes for itself. */
    for (var id in devices) {
      var d = devices[id];
      if (d.kind === 'set' || d.kind === 'ota') continue;
      var v = vertex(d.id, d.kind);
      v.known = true;
      v.build = d.build || null;
      v.lastSeen = d.lastSeen || 0;
      var hops = d.series && d.series['mesh.gw_hops'];
      if (hops && typeof hops.v === 'number') v.gwHops = hops.v;
      if (d.kind === 'gateway') v.gwHops = 0;
    }

    function edge(a, b, ev) {
      a = resolve(a); b = resolve(b);
      if (!a || !b || a === b) return null;
      vertex(a); vertex(b);
      var key = pairKey(a, b);
      var e = edges[key];
      if (!e) {
        e = edges[key] = { a: a < b ? a : b, b: a < b ? b : a,
                           rssi: {}, evidence: [], known: false, claim: false };
      }
      if (ev && e.evidence.indexOf(ev) < 0) e.evidence.push(ev);
      return e;
    }

    /* --- links reported by whoever measured them ---------------------- */

    for (var did in devices) {
      var dev = devices[did];
      if (!Array.isArray(dev.peers)) continue;
      var from = resolve(dev.id);
      for (var i = 0; i < dev.peers.length; i++) {
        var p = dev.peers[i];
        if (!p || !p.m) continue;
        var e = edge(from, p.m, dev.kind === 'gateway' ? 'gateway-peers' : 'node-peers');
        if (!e) continue;
        e.known = true;
        if (typeof p.rssi === 'number' && p.rssi !== 0) {
          /* Keyed by the end that measured it. A link heard at -70 from one
           * side and -86 from the other is one edge with two numbers, not two
           * edges -- and the difference is the interesting part. */
          e.rssi[from] = p.rssi;
        }
        if (typeof p.fail === 'number' && p.fail > 0) {
          e.fail = Math.max(e.fail || 0, p.fail);
        }
      }
    }

    /* --- a sleeper hangs off the relay that claims it ------------------ */

    if (gwDev && Array.isArray(gwDev.leaves)) {
      gwDev.leaves.forEach(function (l) {
        if (!l || !l.m) return;
        var lv = vertex(resolve(l.m), 'sleeper');
        if (lv) lv.gwHops = null;
        if (l.relay) {
          var e = edge(l.m, l.relay, 'leaf-claim');
          if (e) {
            /* A claim is evidence of reachability, not a measurement. The
             * relay told the gateway it can answer this leaf; neither end
             * reported an RSSI for it, so the edge carries none. */
            e.claim = true;
            e.known = true;
          }
        } else {
          var v2 = vertex(resolve(l.m), 'sleeper');
          if (v2) v2.orphan = true;
        }
      });
    }

    /* --- routes, as a last resort for an attachment ------------------- */

    if (gwDev && Array.isArray(gwDev.routes)) {
      gwDev.routes.forEach(function (r) {
        if (!r || !r.d || !r.via) return;
        if (resolve(r.d) === resolve(r.via)) return;
        var e = edge(gwId, r.via, 'gateway-route');
        if (e) e.known = true;
      });
    }

    /* --- what is missing, stated rather than invented ----------------- */

    var unknown = [];
    Object.keys(nodes).forEach(function (nid) {
      var n = nodes[nid];
      if (n.kind === 'gateway') return;
      var attached = false;
      for (var ek in edges) {
        var e = edges[ek];
        if (e.a === nid || e.b === nid) { attached = true; break; }
      }
      if (!attached) {
        n.unattached = true;
        unknown.push(nid);
        /* A node reporting gw_hops >= 1 has a path nobody has described. Draw
         * that as an explicit unknown edge to the gateway so the picture is
         * honest about the gap instead of leaving the node floating as though
         * it were unreachable. */
        if (gwId && n.gwHops !== null && n.gwHops > 0 && n.gwHops < 0xFE) {
          var e2 = edge(nid, gwId, 'implied-by-gw-hops');
          if (e2) { e2.known = false; e2.hops = n.gwHops; }
        }
      }
    });

    var edgeList = Object.keys(edges).map(function (kk) { return edges[kk]; });
    edgeList.forEach(function (e) {
      var vals = Object.keys(e.rssi).map(function (kk) { return e.rssi[kk]; });
      e.ends = Object.keys(e.rssi).length;
      e.best = vals.length ? Math.max.apply(null, vals) : null;
      e.worst = vals.length ? Math.min.apply(null, vals) : null;
      e.asym = (vals.length === 2) ? Math.abs(vals[0] - vals[1]) : null;
    });

    return {
      nodes: Object.keys(nodes).map(function (kk) { return nodes[kk]; }),
      edges: edgeList,
      gwId: gwId,
      alias: alias,
      unknown: unknown,
      /* How complete the picture is, so the map can say so rather than imply
       * completeness by drawing something. */
      coverage: {
        measured: edgeList.filter(function (e) { return e.ends > 0; }).length,
        bothEnds: edgeList.filter(function (e) { return e.ends === 2; }).length,
        claimed:  edgeList.filter(function (e) { return e.claim; }).length,
        unknown:  edgeList.filter(function (e) { return !e.known; }).length,
        reporters: Object.keys(devices).filter(function (kk) {
          return Array.isArray(devices[kk].peers);
        }).length
      }
    };
  }

  /* RSSI -> a spring rest length. Deliberately NOT metres: see the plan. A
   * strong link pulls two nodes together, a weak one lets them drift, and the
   * result is a picture of the network that happens to correlate with the
   * house. Linear in dBm, which is already logarithmic in power. */
  function restLength(rssi, lo, hi) {
    lo = lo === undefined ? 70 : lo;          /* px at the strongest */
    hi = hi === undefined ? 280 : hi;         /* px at the weakest */
    if (rssi === null || rssi === undefined) return hi;
    var STRONG = -35, WEAK = -95;
    var f = (STRONG - rssi) / (STRONG - WEAK);
    if (f < 0) f = 0; if (f > 1) f = 1;
    return lo + f * (hi - lo);
  }

  /* The log-distance path-loss model, exposed with its parameters because a
   * number whose model you cannot see is worse than no number. Indoors,
   * through the ceilings this fleet is spread across, this is an estimate with
   * error bars wide enough to put a basement node in the garden -- one wall
   * changes n, and antenna orientation alone moves RSSI 10 dB. */
  function metres(rssi, p1m, n) {
    if (rssi === null || rssi === undefined) return null;
    p1m = (p1m === undefined) ? -40 : p1m;
    n   = (n === undefined) ? 2.7 : n;
    if (!n) return null;
    return Math.pow(10, (p1m - rssi) / (10 * n));
  }

  NQ.topo = { build: build, restLength: restLength, metres: metres,
              pairKey: pairKey, gatewayAlias: gatewayAlias };
})(typeof window !== 'undefined' ? (window.NQ = window.NQ || {})
                                 : (globalThis.NQ = globalThis.NQ || {}));
