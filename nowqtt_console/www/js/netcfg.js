/* netcfg.js — the network-wide settings: channel, key, join window.
 *
 * No DOM in this file; test/netcfg-test.js drives it. The gateway does the
 * work (components/nowqtt-util/espnow-aodv/src/aodv_netcfg.c) and main/
 * netcfg_bridge.c puts MQTT in front of it:
 *
 *   bridge/netcfg/set      -> {channel, rotate_key, revert_s, grace_s} a change
 *                             {join_s}                                  a join window
 *   bridge/netcfg          <-  retained status, republished on every step
 *   bridge/netcfg/result   <-  {cmd, ok, err} per command
 *
 * The one thing this page adds is the fleet column the gateway cannot give:
 * which epoch every device says it is on. The gateway knows who voted, but a
 * sleeper never votes, and a device that missed a change is by definition not
 * talking to it. Each device reports its own record -- mains nodes in `mesh`
 * as nc:[epoch, channel, switches, reverts, hunts, unknown], sleepers in
 * their report as nc:[epoch, channel] -- so the answer to "did everyone make
 * it" is read from the devices, not inferred from the gateway. */

(function (NQ) {
  'use strict';

  var BUSY = { preparing: 1, committing: 1, verifying: 1 };
  var REVERT_DEFAULT = 120;
  var GRACE_DEFAULT_H = 24;
  var GRACE_MAX_H = 30 * 24;           /* GRACE_S_MAX in aodv_netcfg.c */
  var JOIN_MAX_S = 65535;              /* join_s is a uint16_t on the wire */

  function topics(prefix, uid) {
    var b = prefix + '/' + uid + '/bridge/netcfg';
    return { set: b + '/set', status: b, result: b + '/result' };
  }

  function busy(st) { return !!(st && BUSY[st.state]); }

  /* Seconds left on a countdown the gateway stamped at `ts`. The status is
   * republished with the gateway's stats, not every second, so the page
   * counts down between publishes rather than showing a stale number. */
  function left(seconds, ts, now) {
    if (typeof seconds !== 'number' || seconds <= 0) return 0;
    now = now || Date.now() / 1000;
    return Math.max(0, Math.round(seconds - Math.max(0, now - ts)));
  }

  /* The change request, validated the way propose_on_task() will validate it,
   * so an invalid request is refused here with a reason instead of coming back
   * as ESP_ERR_INVALID_ARG from a gateway that cannot say which field. */
  function request(form, st) {
    var cur = st ? st.channel : null;
    var ch = Number(form.channel);
    if (!Number.isInteger(ch) || ch < 1 || ch > 13) {
      return { ok: false, why: 'channel must be 1 to 13' };
    }
    var rotate = !!form.rotate;
    if (ch === cur && !rotate) {
      return { ok: false, why: 'that is the channel the mesh is already on; ' +
                               'pick another or rotate the key' };
    }
    if (busy(st)) {
      return { ok: false, why: 'a change is already ' + st.state };
    }
    var body = {};
    if (ch !== cur) body.channel = ch;
    if (rotate) body.rotate_key = true;

    if (form.revert_s !== undefined && form.revert_s !== '') {
      var r = Number(form.revert_s);
      if (!Number.isInteger(r) || r < 30 || r > 3600) {
        return { ok: false, why: 'revert must be 30 to 3600 s' };
      }
      if (r !== REVERT_DEFAULT) body.revert_s = r;
    }
    if (form.grace_h !== undefined && form.grace_h !== '') {
      var g = Number(form.grace_h);
      if (!isFinite(g) || g < 1 || g > GRACE_MAX_H) {
        return { ok: false, why: 'grace must be 1 to ' + GRACE_MAX_H + ' h' };
      }
      if (g !== GRACE_DEFAULT_H) body.grace_s = Math.round(g * 3600);
    }
    return { ok: true, body: body, json: JSON.stringify(body) };
  }

  function joinRequest(seconds) {
    var s = Math.round(Number(seconds));
    if (!isFinite(s) || s < 0) return { ok: false, why: 'not a duration' };
    if (s > JOIN_MAX_S) s = JOIN_MAX_S;
    return { ok: true, body: { join_s: s }, json: JSON.stringify({ join_s: s }) };
  }

  /* One row per mesh device: the record it last reported, and where that
   * puts it relative to the gateway's.
   *
   *   current   on the gateway's epoch
   *   pending   already on the epoch being committed
   *   previous  one behind, inside the grace window: it will be told
   *   stranded  on an epoch the gateway no longer holds a key for, or on the
   *             previous one after its grace ran out. Only a join window gets
   *             it back -- it still has the factory key, and a factory-key
   *             PULL is answered while one is open.
   *   unknown   its firmware does not report nc, or it has not reported yet */
  function where(epoch, st, prevLeft) {
    if (!st || typeof epoch !== 'number') return 'unknown';
    if (epoch === st.epoch) return 'current';
    if (typeof st.pending_epoch === 'number' && epoch === st.pending_epoch) return 'pending';
    if (typeof st.prev_epoch === 'number' && epoch === st.prev_epoch && prevLeft > 0) return 'previous';
    return 'stranded';
  }

  function fleet(list, st, stTs, now) {
    var prevLeft = st ? left(st.prev_key_s, stTs, now) : 0;
    var missing = {};
    ((st && st.missing) || []).forEach(function (m) { missing[String(m).toLowerCase()] = true; });
    var rows = [];
    list.forEach(function (d) {
      if (d.kind === 'gateway') return;
      var src = d.kind === 'sleeper' ? d.topics['report'] : d.topics['mesh'];
      var nc = src && src.json && Array.isArray(src.json.nc) ? src.json.nc : null;
      var epoch = nc ? nc[0] : null, channel = nc ? nc[1] : null;
      rows.push({
        id: d.id, kind: d.kind,
        epoch: epoch, channel: channel,
        switches: nc && nc.length > 2 ? nc[2] : null,
        reverts: nc && nc.length > 3 ? nc[3] : null,
        hunts: nc && nc.length > 4 ? nc[4] : null,
        unknownEpoch: nc && nc.length > 5 ? nc[5] : null,
        ts: src ? src.ts : 0,
        where: where(epoch, st, prevLeft),
        missing: !!missing[String(d.id).toLowerCase()]
      });
    });
    return rows;
  }

  function summary(rows) {
    var s = { total: rows.length, current: 0, pending: 0, previous: 0, stranded: 0, unknown: 0 };
    rows.forEach(function (r) { s[r.where]++; });
    return s;
  }

  /* What a change will do, in one sentence, before anybody presses the
   * button. The count is the gateway's own `members` -- the mains nodes that
   * will be asked to vote -- because any one of them not answering aborts the
   * whole change, and that is worth knowing in advance. */
  function describe(body, st, sleepers) {
    var parts = [];
    if (body.channel) parts.push('move from channel ' + st.channel + ' to ' + body.channel);
    if (body.rotate_key) parts.push((body.channel ? 'and ' : '') + 'generate a new mesh key');
    var voters = typeof st.members === 'number' ? st.members : null;
    var txt = 'Asks ' + (voters === null ? 'every mains node' : voters + ' mains node' + (voters === 1 ? '' : 's')) +
              ' to ' + parts.join(' ') + '. If any of them does not acknowledge, nothing moves.';
    if (sleepers) {
      txt += ' ' + sleepers + ' sleeper' + (sleepers === 1 ? ' follows' : 's follow') +
             ' on a later wake' +
             (body.channel ? ' (after a channel move, the third silent wake scans for it)' : '') + '.';
    }
    return txt;
  }

  NQ.netcfg = {
    topics: topics,
    busy: busy,
    left: left,
    request: request,
    joinRequest: joinRequest,
    where: where,
    fleet: fleet,
    summary: summary,
    describe: describe,
    REVERT_DEFAULT: REVERT_DEFAULT,
    GRACE_DEFAULT_H: GRACE_DEFAULT_H,
    GRACE_MAX_H: GRACE_MAX_H
  };
})(typeof window !== 'undefined' ? (window.NQ = window.NQ || {})
                                 : (globalThis.NQ = globalThis.NQ || {}));
