/* ping.js — ask the gateway to ping a node, and turn its answer into a path.
 *
 * No DOM. The gateway sends a confirmed frame and reports two neighbours it
 * saw for itself: the one it handed the acknowledged attempt to, and the one
 * that handed the acknowledgement back. Those two hops are measured. A hop
 * between a relay and the target is not -- relays open nothing and add
 * nothing, so a relay that went round through a third node looks the same --
 * and the path says so with `sure: false` rather than drawing it solid. With
 * no node further than two hops out that is all there is to the path, but the
 * map must not claim it.
 *
 * bridge/ping/set   {"mac":"806599fb7068"}
 * bridge/ping       {"mac":…,"ok":true,"out":…,"back":…,"rssi":-61,
 *                    "rtt_us":8123,"tries":1} | {"mac":…,"ok":false,"err":…}
 */

(function (NQ) {
  'use strict';

  var TIMEOUT_MS = 10000;   /* the gateway gives up after ~2 s of retries */
  var SEG_MS = 650;         /* one hop of the replay; the real one is ~2 ms */
  var HOLD_MS = 6000;       /* the path stays up this long after the pulse */
  var FADE_MS = 1500;

  function topics(prefix, uid) {
    var b = prefix + '/' + uid + '/bridge/ping';
    return { set: b + '/set', result: b };
  }

  function mac(m) { return m ? String(m).toLowerCase() : null; }

  /* The hops of one answer, out and then back. gwId is the gateway's vertex. */
  function path(res, gwId) {
    var t = mac(res.mac), out = mac(res.out), back = mac(res.back);
    var segs = [];
    if (out === t) {
      segs.push({ a: gwId, b: t, dir: 'out', sure: true });
    } else {
      segs.push({ a: gwId, b: out, dir: 'out', sure: true });
      segs.push({ a: out, b: t, dir: 'out', sure: false });
    }
    if (back === t) {
      segs.push({ a: t, b: gwId, dir: 'back', sure: true });
    } else {
      segs.push({ a: t, b: back, dir: 'back', sure: false });
      segs.push({ a: back, b: gwId, dir: 'back', sure: true });
    }
    return { target: t, out: out, back: back, segs: segs,
             rttMs: typeof res.rtt_us === 'number' ? res.rtt_us / 1000 : null,
             rssi: typeof res.rssi === 'number' ? res.rssi : null,
             tries: res.tries || 1 };
  }

  /* Where a replay is `ms` after it started: how much of each hop is drawn,
   * where the pulse is, and how opaque the whole thing is. null once over. */
  function at(p, ms) {
    var n = p.segs.length;
    var run = n * SEG_MS;
    if (ms >= run + HOLD_MS) return null;
    var k = Math.min(n, ms / SEG_MS);
    var shown = p.segs.map(function (s, i) {
      return { seg: s, frac: Math.max(0, Math.min(1, k - i)) };
    });
    var dot = null;
    if (ms < run) {
      var i = Math.floor(k);
      dot = { seg: p.segs[i], frac: k - i };
    }
    var left = run + HOLD_MS - ms;
    return { shown: shown, dot: dot, alpha: left < FADE_MS ? left / FADE_MS : 1 };
  }

  /* ---------- the one ping in flight ------------------------------------ */

  var pending = null;       /* { mac, t } */
  var last = null;          /* { mac, ok, path?, err?, ts } */
  var listeners = [];

  function onResult(cb) { listeners.push(cb); }
  function settle(r) {
    pending = null;
    last = r;
    listeners.forEach(function (cb) { cb(r); });
  }

  /* Returns false if one is already out. `send(topic, json)` publishes. */
  function start(target, prefix, uid, send) {
    if (pending && Date.now() - pending.t < TIMEOUT_MS) return false;
    pending = { mac: mac(target), t: Date.now() };
    send(topics(prefix, uid).set, JSON.stringify({ mac: mac(target) }));
    return true;
  }

  /* The gateway's vertex on the map is its uid, which is in the topic. */
  function onMessage(topic, text) {
    if (!/\/bridge\/ping$/.test(topic)) return;
    var gwId = topic.split('/')[1];
    var j;
    try { j = JSON.parse(text); } catch (e) { return; }
    if (!j || !pending || mac(j.mac) !== pending.mac) return;
    settle(j.ok
      ? { mac: pending.mac, ok: true, path: path(j, gwId), ts: Date.now() }
      : { mac: pending.mac, ok: false, err: j.err || 'failed', ts: Date.now() });
  }

  /* Called from the render loop: a gateway without the ping bridge never
   * answers, and that has to end in a message, not a spinner. */
  function tick() {
    if (pending && Date.now() - pending.t >= TIMEOUT_MS) {
      settle({ mac: pending.mac, ok: false, err: 'no answer from the gateway', ts: Date.now() });
    }
  }

  NQ.ping = {
    topics: topics, path: path, at: at,
    start: start, onMessage: onMessage, tick: tick, onResult: onResult,
    pending: function () { return pending; },
    last: function () { return last; },
    SEG_MS: SEG_MS
  };
})(typeof window !== 'undefined' ? (window.NQ = window.NQ || {})
                                 : (globalThis.NQ = globalThis.NQ || {}));
