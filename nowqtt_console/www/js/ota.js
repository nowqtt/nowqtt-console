/* ota.js — push firmware from the browser.
 *
 * A reimplementation of docs/tools/mqtt-ota.py, which is the reference for
 * this protocol and has the scars to prove it. Every rule below cost a real
 * failure to learn, so each one is written down next to the code that honours
 * it rather than in a document beside it.
 *
 *   -> cmd    {"cmd":"start","size":N,"chunk":C,"reboot":1}
 *   <- reply  {"ready":1,"chunk":C}
 *   -> data   <4-byte sequence number><payload>
 *   <- reply  {"ack":seq,"received":N} | {"nack":expected} | {"status":"done"}
 *
 * Topics, which differ between the gateway and a mesh node:
 *   gateway   <prefix>/<uid>/ota/rx          replies on .../ota/tx
 *   node      <prefix>/<uid>/ota/<mac>/cmd   replies on .../ota/<mac>/status
 *             <prefix>/<uid>/ota/<mac>/data
 */

(function (NQ) {
  'use strict';

  /* The device's MessageBuffer is 4256 bytes and each message carries a
   * 4-byte header, so 4096 is the largest chunk that fits with room to spare.
   * Over the mesh a chunk must fit one ESP-NOW v2 frame: 1470 less the 20-byte
   * header, the 8-byte tag and the 4-byte sequence. 1024 rather than the full
   * 1438 because a shorter frame is a smaller thing to lose on a marginal
   * link, and the round trip dominates either way. */
  var CHUNK_DIRECT = 4096;
  var CHUNK_MESH   = 1024;

  var MAX_RESTARTS = 2;      /* a device rebooting every attempt is a different fault */
  var BLIND_RETRIES = 12;

  /* Resends of one unanswered chunk before giving up.
   *
   * An unanswered chunk used to be fatal, which meant one lost frame -- the
   * chunk or its ack -- killed a 750 KB transfer. The device meanwhile holds
   * its session for 60 s (OTA_IDLE_TIMEOUT_MS in aodv_ota.c) and would have
   * answered a resend; a node at -88 dBm was unreachable by OTA for that
   * reason alone while delivering its ordinary reports perfectly well.
   *
   * The device needs no help with this. A resent chunk it has already written
   * is not the sequence it expects, so it nacks with the one it does want and
   * the rewind below skips ahead -- which covers a lost ack exactly as it
   * covers a lost chunk. The budget (timeout x retries) stays inside the
   * device's 60 s, so the session is still open to answer. */
  var CHUNK_RETRIES = 5;

  var session = null;

  function nowS() { return Date.now() / 1000; }

  function Session(cfg) {
    this.cfg = cfg;
    this.queue = [];
    this.waiter = null;
    this.aborted = false;
    this.replyTopic = cfg.isNode
      ? cfg.prefix + '/' + cfg.uid + '/ota/' + cfg.mac + '/status'
      : cfg.prefix + '/' + cfg.uid + '/ota/tx';
    this.cmdTopic = cfg.isNode
      ? cfg.prefix + '/' + cfg.uid + '/ota/' + cfg.mac + '/cmd'
      : cfg.prefix + '/' + cfg.uid + '/ota/rx';
    this.dataTopic = cfg.isNode
      ? cfg.prefix + '/' + cfg.uid + '/ota/' + cfg.mac + '/data'
      : cfg.prefix + '/' + cfg.uid + '/ota/rx';
  }

  Session.prototype.emit = function (ev) {
    if (this.cfg.onEvent) { try { this.cfg.onEvent(ev); } catch (e) { console.error(e); } }
  };
  Session.prototype.log = function (msg) { this.emit({ type: 'log', msg: msg }); };

  /* Replies arrive from the broker callback, which is not where we are
   * waiting, so they are queued and matched by predicate. */
  Session.prototype.feed = function (obj) {
    if (this.waiter && this.waiter.pred(obj)) {
      var w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(obj);
      return;
    }
    this.queue.push(obj);
    if (this.queue.length > 64) this.queue.shift();
  };

  Session.prototype.drain = function () { this.queue.length = 0; };

  Session.prototype.wait = function (pred, timeoutMs, what) {
    var self = this;
    for (var i = 0; i < this.queue.length; i++) {
      if (pred(this.queue[i])) return Promise.resolve(this.queue.splice(i, 1)[0]);
    }
    return new Promise(function (resolve, reject) {
      var w = {
        pred: pred, resolve: resolve,
        timer: setTimeout(function () {
          if (self.waiter === w) self.waiter = null;
          var e = new Error('no ' + what + ' within ' + (timeoutMs / 1000) + 's');
          e.timeout = true;
          reject(e);
        }, timeoutMs)
      };
      self.waiter = w;
    });
  };

  /* An ack must be for the chunk just sent. Without this pin, a retried
   * transfer consumes the previous attempt's in-flight acks, marches through
   * the whole image at an impossible rate, reports success, and leaves the
   * device on its old firmware -- it has already reported two nodes updated
   * that were not, and only their `build` topic said otherwise. */
  function replyMatcher(seq) {
    return function (r) {
      if (r.error !== undefined) return true;
      if (r.ack !== undefined) return Number(r.ack) === seq;
      if (r.nack !== undefined) return true;
      if (r.status !== undefined) return true;
      return false;
    };
  }

  Session.prototype.pub = function (topic, payload) {
    var ok = NQ.broker.publish(topic, payload, { qos: 0 });
    if (!ok) throw new Error('lost the broker connection mid-transfer');
  };

  Session.prototype.header = function (seq) {
    /* Big-endian to the gateway, little-endian to a mesh node. mqtt_ota.c
     * parses the sequence by hand as big-endian; the mesh path memcpy()s it
     * into a uint32_t on a little-endian target. Getting this backwards is a
     * transfer that nacks from the very first chunk. */
    var h = new Uint8Array(4);
    if (this.cfg.isNode) {
      h[0] = seq & 0xff; h[1] = (seq >>> 8) & 0xff;
      h[2] = (seq >>> 16) & 0xff; h[3] = (seq >>> 24) & 0xff;
    } else {
      h[0] = (seq >>> 24) & 0xff; h[1] = (seq >>> 16) & 0xff;
      h[2] = (seq >>> 8) & 0xff; h[3] = seq & 0xff;
    }
    return h;
  };

  Session.prototype.sendChunk = function (seq, off, len) {
    var buf = new Uint8Array(4 + len);
    buf.set(this.header(seq), 0);
    buf.set(this.cfg.bytes.subarray(off, off + len), 4);
    this.pub(this.dataTopic, buf);
  };

  Session.prototype.begin = function () {
    var self = this;
    this.drain();
    var start = { cmd: 'start', size: this.cfg.bytes.length,
                  chunk: this.cfg.chunk, reboot: this.cfg.reboot ? 1 : 0 };
    this.pub(this.cmdTopic, JSON.stringify(start));
    return this.wait(function (r) { return r.ready !== undefined || r.error !== undefined; },
                     this.cfg.timeoutMs, 'READY')
      .then(function (r) {
        if (r.error !== undefined) throw new Error('device reported: ' + r.error);
        var granted = Number(r.chunk) || self.cfg.chunk;
        if (granted !== self.cfg.chunk) {
          self.log('device asked for ' + granted + '-byte chunks');
          self.cfg.chunk = granted;
        }
        return true;
      });
  };

  Session.prototype.beginBlind = function () {
    /* A sleeping leaf holds no route to the gateway and cannot flood for one
     * inside an 85 ms wake, so its READY is sent into a void -- but that
     * failure is what starts discovery, and every reply after it gets
     * through. The gateway parks the offer and sends it when the leaf next
     * reports, up to a whole interval away; {"offer":n} is the gateway saying
     * it has just done so, which is the moment to start pushing. Chunks sent
     * before then would be relayed to a device with no session and dropped. */
    var self = this;
    this.drain();
    this.log('blind: sending begin, not waiting for READY');
    this.pub(this.cmdTopic, JSON.stringify({
      cmd: 'start', size: this.cfg.bytes.length,
      chunk: this.cfg.chunk, reboot: this.cfg.reboot ? 1 : 0
    }));
    return this.wait(function (r) { return r.offer !== undefined; },
                     this.cfg.blindTimeoutMs, 'the gateway to say it sent the offer')
      .then(function (r) {
        self.log('blind: gateway sent begin (offer ' + r.offer + '); pushing chunks');
        return new Promise(function (res) { setTimeout(res, 1000); });
      });
  };

  Session.prototype.run = async function () {
    var total = this.cfg.bytes.length;
    var t0 = nowS();

    if (this.cfg.blind) { await this.beginBlind(); } else { await this.begin(); }

    var seq = 0, off = 0, restarts = 0, chunkRetries = 0;
    this.resends = 0;
    this.emit({ type: 'progress', sent: 0, total: total, pct: 0, rate: 0 });

    while (off < total) {
      if (this.aborted) throw new Error('aborted');

      var len = Math.min(this.cfg.chunk, total - off);
      this.sendChunk(seq, off, len);

      var r;
      try {
        r = await this.wait(replyMatcher(seq), this.cfg.timeoutMs, 'ack for chunk ' + seq);
      } catch (e) {
        /* Nothing came back: either the chunk never arrived or its ack did
         * not, and both are fixed by sending it again.
         *
         * Blind mode gets a larger budget for a different reason -- a sleeping
         * leaf holds no route until its own first failed reply starts
         * discovery, so its first chunks are answered into a void rather than
         * lost on a marginal link. */
        var budget = this.cfg.blind ? BLIND_RETRIES : this.cfg.retries;
        if (e.timeout && chunkRetries < budget) {
          chunkRetries++;
          this.resends++;
          this.log((this.cfg.blind ? 'blind: ' : '') + 'no answer for chunk ' +
                   seq + ', resending (' + chunkRetries + '/' + budget + ')');
          continue;
        }
        if (e.timeout) {
          e.message = 'chunk ' + seq + ' unanswered after ' + budget +
                      ' resends (' + (budget * this.cfg.timeoutMs / 1000) + 's)';
        }
        throw e;
      }

      if (r.error !== undefined) {
        var text = String(r.error);

        /* "chunk N: ESP_ERR_NOT_FOUND" is the GATEWAY saying it had no route
         * to the node at that instant -- not the node refusing anything.
         * tx_toward() has just started discovery and the answer is usually
         * milliseconds away; mesh_ota.c already treats this as transient for
         * `begin`, calling it "the normal case for any node more than one hop
         * from the gateway", and then treats it as fatal for a chunk.
         *
         * The sender is the only party that still holds the chunk, so the
         * retry has to live here. It shares the per-chunk budget with a
         * timeout, because both mean the same thing: that chunk did not land. */
        if (text.indexOf('NOT_FOUND') >= 0) {
          var rbudget = this.cfg.blind ? BLIND_RETRIES : this.cfg.retries;
          if (chunkRetries >= rbudget) {
            throw new Error('no route to the node for chunk ' + seq +
                            ' after ' + rbudget + ' attempts: ' + text);
          }
          chunkRetries++;
          this.resends++;
          this.log('no route for chunk ' + seq + ' yet (' + text + '); resending (' +
                   chunkRetries + '/' + rbudget + ')');
          await new Promise(function (res) { setTimeout(res, 1000); });
          continue;
        }

        /* A device that rebooted mid-transfer lost its esp_ota handle and
         * answers with ESP_ERR_INVALID_STATE. That needs another begin, not
         * another chunk. Bounded, because a device rebooting on every attempt
         * is a different problem and must be seen rather than papered over. */
        var recoverable = text.indexOf('INVALID_STATE') >= 0;
        if (!recoverable || restarts >= MAX_RESTARTS) {
          throw new Error('device reported: ' + text);
        }
        restarts++;
        this.log('device lost the session (' + text + '); beginning again (' +
                 restarts + '/' + MAX_RESTARTS + ')');
        await this.begin();
        seq = 0; off = 0;
        continue;
      }

      if (r.nack !== undefined) {
        var want = Number(r.nack);
        this.log('nack: device wants seq ' + want + ' (we sent ' + seq + '); rewinding');
        seq = want; off = want * this.cfg.chunk;
        continue;
      }

      if (r.status !== undefined) break;

      /* Reset only here, where a chunk was actually written. Resetting on any
       * reply -- which is what this did first -- lets a repeated transient
       * error refill the budget forever, and the retry loop never ends. */
      chunkRetries = 0;
      off += len;
      seq++;
      var dt = Math.max(1e-6, nowS() - t0);
      this.emit({ type: 'progress', sent: off, total: total,
                  pct: Math.floor(100 * off / total), rate: off / dt / 1024 });
    }

    /* The device finishes on its own once it has every byte; an explicit end
     * is only needed if it did not notice. */
    var done;
    try {
      done = await this.wait(function (r) { return r.status !== undefined || r.error !== undefined; },
                             this.cfg.timeoutMs, 'final status');
    } catch (e) {
      this.log('no {"status":"done"} yet; sending explicit end');
      this.pub(this.cmdTopic, JSON.stringify({ cmd: 'end' }));
      done = await this.wait(function (r) { return r.status !== undefined || r.error !== undefined; },
                             this.cfg.timeoutMs, 'final status');
    }
    if (done.error !== undefined) throw new Error('device reported: ' + done.error);

    var el = nowS() - t0;
    return { bytes: total, seconds: el, rate: total / el / 1024,
             status: done.status, rebooting: !!this.cfg.reboot,
             resends: this.resends };
  };

  /* ------------------------------------------------------------------ */

  function start(cfg) {
    if (session) return Promise.reject(new Error('a transfer is already running'));
    var isNode = !!cfg.mac;
    var s = new Session({
      isNode: isNode,
      mac: cfg.mac ? String(cfg.mac).toLowerCase() : null,
      uid: cfg.uid,
      prefix: cfg.prefix,
      bytes: cfg.bytes,
      chunk: cfg.chunk || (isNode ? CHUNK_MESH : CHUNK_DIRECT),
      reboot: cfg.reboot === undefined ? true : !!cfg.reboot,
      blind: !!cfg.blind,
      /* Short on purpose: a mesh round trip is ~50 ms, so 8 s is already 160x
       * the expected reply, and recovering a lost frame in 8 s beats waiting
       * 20 for one that is never coming. */
      timeoutMs: (cfg.timeout || 8) * 1000,
      retries: cfg.retries === undefined ? CHUNK_RETRIES : cfg.retries,
      blindTimeoutMs: (cfg.blindTimeout || 180) * 1000,
      onEvent: cfg.onEvent
    });
    session = s;
    s.log((isNode ? 'mesh node ' + s.cfg.mac : 'the gateway') + ': ' +
          cfg.bytes.length + ' bytes in ' +
          Math.ceil(cfg.bytes.length / s.cfg.chunk) + ' chunks of ' + s.cfg.chunk);
    return s.run()
      .then(function (res) { session = null; s.emit({ type: 'done', result: res }); return res; })
      .catch(function (err) {
        session = null;
        s.emit({ type: 'error', error: String(err && err.message || err) });
        throw err;
      });
  }

  function onMessage(topic, text) {
    if (!session || topic !== session.replyTopic) return;
    var obj = null;
    try { obj = JSON.parse(text); } catch (e) {
      session.log('unparsed reply: ' + String(text).slice(0, 80));
      return;
    }
    if (obj && typeof obj === 'object') session.feed(obj);
  }

  NQ.ota = {
    start: start,
    onMessage: onMessage,
    abort: function () { if (session) { session.aborted = true; session.log('abort requested'); } },
    active: function () { return !!session; },
    CHUNK_DIRECT: CHUNK_DIRECT,
    CHUNK_MESH: CHUNK_MESH,
    /* exported for the host tests */
    _Session: Session,
    _replyMatcher: replyMatcher
  };
})(typeof window !== 'undefined' ? (window.NQ = window.NQ || {})
                                 : (globalThis.NQ = globalThis.NQ || {}));
