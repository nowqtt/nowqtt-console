/* broker.js — the MQTT over WebSocket connection.
 *
 * One deliberate omission: this never subscribes to `ota/+/data` or `ota/rx`.
 * Those topics carry the firmware image itself, and a wildcard over them would
 * pull three quarters of a megabyte into the browser every time anybody
 * updates a device with this page open — including the transfers this page
 * starts itself.
 *
 * Subscriptions are re-issued on every `connect`, not once at startup. A
 * reconnect begins a fresh session and inherits no subscriptions; the soak
 * recorder learned that by silently recording nothing after a broker restart. */

(function (NQ) {
  'use strict';

  var listeners = { status: [], message: [], error: [] };
  var client = null;
  var state = 'idle';          /* idle | connecting | up | down */
  var lastError = '';
  var subs = [];

  function emit(kind, a, b, c) {
    listeners[kind].forEach(function (fn) {
      try { fn(a, b, c); } catch (e) { console.error(e); }
    });
  }

  function setState(s, why) {
    state = s;
    lastError = why || '';
    emit('status', s, lastError);
  }

  /* Per gateway uid, or `+` to discover every gateway under the prefix. A
   * blank uid is the useful default: the page finds the gateway rather than
   * being told its Ethernet MAC. */
  function filters(prefix, uid) {
    var u = uid && uid.length ? uid : '+';
    var base = prefix + '/' + u + '/';
    return [
      base + 'device/#',        /* status, version, config/current */
      base + 'bridge/#',        /* stats, mesh topology */
      base + 'dev/#',           /* every node topic and its set/ echo */
      base + 'ota/tx',          /* the gateway's own OTA replies */
      base + 'ota/+/status'     /* a mesh node's OTA replies */
    ];
  }

  var dec = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8', { fatal: false }) : null;

  function asText(buf) {
    if (typeof buf === 'string') return buf;
    if (dec) {
      try { return dec.decode(buf); } catch (e) { /* fall through */ }
    }
    var s = '';
    for (var i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return s;
  }

  function connect(cfg) {
    disconnect();
    var check = NQ.store.checkUrl(cfg.url);
    if (!check.ok) { setState('down', check.why); return; }
    /* Not fatal -- the operator allows insecure content per-site -- but said
     * out loud, because a blocked socket and an unreachable broker look
     * identical from here. */
    if (check.warn) emit('error', check.warn);

    var opts = {
      clientId: 'nowqtt-console-' + Math.random().toString(16).slice(2, 10),
      clean: true,
      keepalive: 30,
      reconnectPeriod: 4000,
      connectTimeout: 10000,
      protocolVersion: 4
    };
    if (cfg.user) { opts.username = cfg.user; opts.password = cfg.pass || ''; }

    setState('connecting');
    subs = filters(cfg.prefix, cfg.uid);

    try {
      client = mqtt.connect(cfg.url, opts);
    } catch (e) {
      setState('down', String(e && e.message || e));
      return;
    }

    client.on('connect', function () {
      setState('up');
      subs.forEach(function (f) {
        client.subscribe(f, { qos: 0 }, function (err) {
          if (err) emit('error', 'subscribe ' + f + ': ' + err.message);
        });
      });
    });

    client.on('reconnect', function () { setState('connecting'); });
    client.on('close',     function () { if (state !== 'connecting') setState('down', lastError); });
    client.on('offline',   function () { setState('down', lastError); });

    client.on('error', function (err) {
      /* A rejected login arrives here rather than as a timeout. Saying so is
       * the difference between looking at the broker's ACLs and looking at
       * the network. */
      lastError = String(err && err.message || err);
      emit('error', lastError);
    });

    client.on('message', function (topic, payload, packet) {
      emit('message', topic, payload, packet);
    });
  }

  function disconnect() {
    if (!client) return;
    try { client.end(true); } catch (e) { /* ignore */ }
    client = null;
    setState('idle');
  }

  function publish(topic, payload, opts, cb) {
    if (!client || state !== 'up') {
      if (cb) cb(new Error('not connected'));
      return false;
    }
    client.publish(topic, payload, opts || { qos: 0 }, function (err) {
      if (cb) cb(err || null);
    });
    return true;
  }

  NQ.broker = {
    on: function (kind, fn) { listeners[kind].push(fn); },
    connect: connect,
    disconnect: disconnect,
    publish: publish,
    asText: asText,
    filters: filters,
    state: function () { return state; },
    lastError: function () { return lastError; },
    up: function () { return state === 'up'; }
  };
})(window.NQ = window.NQ || {});
