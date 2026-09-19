/* network.js — the Network tab: move the mesh to another channel, rotate its
 * key, open a join window.
 *
 * The form is static markup in index.html and only the status around it is
 * redrawn, so a redraw never takes a half-typed value or the focus away. The
 * logic is in netcfg.js; this file is only the page. */

(function (NQ) {
  'use strict';

  var U = NQ.ui;
  var h = U.h, $ = U.$, clear = U.clear, ago = U.ago;
  var N = NQ.netcfg;

  var touched = false;       /* the operator picked a channel; stop following the gateway's */
  var wired = false;
  var sentNote = null;       /* { kind, text } after a publish */
  var addonBackups = null;   /* { uid: {epoch, channel, saved} } from the add-on, or null */
  var addonAsked = 0;

  function gwUid() { return NQ.model.gwUid() || U.cfg().uid; }
  function topics() { return N.topics(U.cfg().prefix, gwUid()); }

  function status() {
    var g = NQ.model.gateway();
    return g && g.netcfg ? g.netcfg : null;
  }

  function dur(s) {
    if (s <= 0) return '—';
    if (s < 90) return s + ' s';
    if (s < 5400) return Math.round(s / 60) + ' min';
    return (s / 3600).toFixed(s < 36000 ? 1 : 0) + ' h';
  }

  var ERR = {
    ESP_ERR_INVALID_STATE: 'the gateway is busy with another change',
    ESP_ERR_INVALID_ARG: 'the gateway found nothing to change',
    ESP_ERR_TIMEOUT: 'the gateway\'s mesh task did not answer',
    ESP_ERR_NO_MEM: 'the gateway is out of memory'
  };

  function form() {
    return { channel: $('#nc-channel').value, rotate: $('#nc-rotate').checked,
             revert_s: $('#nc-revert').value, grace_h: $('#nc-grace').value };
  }

  function publish(json, what) {
    var ok = NQ.broker.publish(topics().set, json, { qos: 1, retain: false }, function (err) {
      sentNote = err ? { kind: 'bad', text: what + ' not sent: ' + (err.message || err) }
                     : { kind: 'info', text: what + ' sent' +
                                         (/"key"/.test(json) ? '' : ': ' + json) +
                                         '. The gateway answers on bridge/netcfg/result.' };
      U.markDirty();
    });
    if (!ok) { sentNote = { kind: 'bad', text: 'Not connected to the broker.' }; U.markDirty(); }
  }

  function wire() {
    if (wired) return;
    wired = true;

    var sel = $('#nc-channel');
    for (var c = 1; c <= 13; c++) sel.appendChild(h('option', { value: String(c), text: String(c) }));
    sel.addEventListener('change', function () { touched = true; preview(); });
    $('#nc-rotate').addEventListener('change', preview);
    $('#nc-revert').addEventListener('input', preview);
    $('#nc-grace').addEventListener('input', preview);

    $('#nc-propose').addEventListener('click', function () {
      var cur = status();
      var st = cur ? cur.doc : null;
      var r = N.request(form(), st);
      if (!r.ok) { sentNote = { kind: 'bad', text: r.why }; U.markDirty(); return; }
      var rows = N.fleet(NQ.model.list(), st, cur ? cur.ts : 0);
      var s = N.summary(rows);
      var msg = N.describe(r.body, st, rows.filter(function (x) { return x.kind === 'sleeper'; }).length);
      if (s.previous) {
        msg += '\n\n' + s.previous + ' device(s) have not caught up with the LAST change yet. ' +
               'This change drops the key they hold, and they will need a join window to get back.';
      }
      if (r.body.rotate_key) {
        msg += '\n\nThe new key is random and exists only in the devices. A device ' +
               'flashed from the repository afterwards joins through a join window.';
      }
      if (!window.confirm(msg + '\n\nPropose it?')) return;
      publish(r.json, 'Change');
      touched = false;
    });

    $('#nc-join-open').addEventListener('click', function () {
      var r = N.joinRequest(Number($('#nc-join-dur').value));
      if (!r.ok) { sentNote = { kind: 'bad', text: r.why }; U.markDirty(); return; }
      publish(r.json, 'Join window');
    });
    $('#nc-join-close').addEventListener('click', function () {
      publish(N.joinRequest(0).json, 'Join window close');
    });

    $('#nc-backup-dl').addEventListener('click', download);
    $('#nc-restore-addon').addEventListener('click', function () {
      fetch('api/netcfg/backup/' + encodeURIComponent(gwUid()), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (doc) { restore(doc, 'the add-on\'s backup'); })
        .catch(function (e) { sentNote = { kind: 'bad', text: 'Backup not fetched: ' + e.message }; U.markDirty(); });
    });
    $('#nc-restore-file').addEventListener('click', function () { $('#nc-restore-input').click(); });
    $('#nc-restore-input').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      f.text().then(function (txt) {
        var doc = null;
        try { doc = JSON.parse(txt); } catch (err) { doc = null; }
        restore(doc, f.name);
      });
      e.target.value = '';
    });
  }

  /* ---- backup ------------------------------------------------------ */

  function refreshAddonBackups(force) {
    if (!NQ.store.managed()) return;
    var now = Date.now();
    if (!force && now - addonAsked < 60000) return;
    addonAsked = now;
    fetch('api/netcfg/backups', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { addonBackups = j && j.backups ? j.backups : {}; U.markDirty(); })
      .catch(function () { });
  }

  function saveFile(doc) {
    var name = 'nowqtt-network-' + (doc.uid || gwUid()) + '-epoch' + doc.epoch + '.json';
    var blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    sentNote = { kind: 'info', text: 'Saved ' + name + '. It holds the mesh key: keep it like a password.' };
    U.markDirty();
  }

  /* From the add-on when it has the current epoch; otherwise straight from
   * the gateway, which answers once on bridge/netcfg/export. */
  function download() {
    var cur = status();
    var st = cur ? cur.doc : null;
    var mine = addonBackups && addonBackups[gwUid()];
    if (mine && st && mine.epoch === st.epoch) {
      fetch('api/netcfg/backup/' + encodeURIComponent(gwUid()), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(saveFile)
        .catch(function (e) { sentNote = { kind: 'bad', text: 'Backup not fetched: ' + e.message }; U.markDirty(); });
      return;
    }
    var g = NQ.model.gateway();
    if (g) g.netcfgExport = null;
    var asked = Date.now() / 1000;
    publish(JSON.stringify({ export: true }), 'Backup request');
    var tries = 0;
    var t = setInterval(function () {
      var gg = NQ.model.gateway();
      var ex = gg && gg.netcfgExport;
      if (ex && ex.ts >= asked - 1) {
        clearInterval(t);
        var doc = Object.assign({ uid: gwUid(), saved: Math.round(Date.now() / 1000) }, ex.doc);
        gg.netcfgExport = null;          /* in memory only as long as it takes */
        saveFile(doc);
      } else if (++tries > 20) {
        clearInterval(t);
        sentNote = { kind: 'bad', text: 'The gateway did not answer with a backup in 10 s.' };
        U.markDirty();
      }
    }, 500);
  }

  function restore(doc, from) {
    var r = N.restoreRequest(doc);
    if (!r.ok) { sentNote = { kind: 'bad', text: 'Cannot restore ' + from + ': ' + r.why + '.' }; U.markDirty(); return; }
    if (!window.confirm('Put epoch ' + doc.epoch + ' (channel ' + doc.channel + ') back on the gateway?\n\n' +
                        'Only do this with the NEWEST backup: the nodes do not follow a gateway ' +
                        'backwards, so an older one leaves them where they are.')) return;
    publish(r.json, 'Restore of epoch ' + doc.epoch);
  }

  function renderBackup(st) {
    var box = clear($('#nc-backup-state'));
    var mine = addonBackups ? addonBackups[gwUid()] || null : null;
    var state = N.backupState(st, mine);
    var managed = !!NQ.store.managed();
    var saved = mine && mine.saved ? ' (saved ' + ago(mine.saved) + ')' : '';
    if (!managed) {
      box.appendChild(h('div', { class: 'note', text: 'Opened outside the add-on, so nothing is ' +
        'backed up automatically. Download a backup after every change.' }));
    } else if (state === 'current') {
      box.appendChild(U.banner('info', 'The add-on holds a backup of epoch ' + mine.epoch + saved +
        ', the one the mesh runs.'));
    } else if (state === 'stale') {
      box.appendChild(U.banner('warn', 'The add-on\'s backup is of epoch ' + mine.epoch + saved +
        ', but the mesh runs epoch ' + st.epoch + '. It asks the gateway for a new one within a minute of a change.'));
    } else if (state === 'none') {
      box.appendChild(U.banner('warn', 'The add-on holds no backup yet. It asks the gateway for one ' +
        'within a minute; the gateway firmware has to support it.'));
    }
    if (st && st.epoch === 0) {
      box.appendChild(U.banner(state === 'needed' ? 'bad' : 'warn',
        'The gateway is on the factory record (epoch 0). If the mesh has rotated its key, this ' +
        'gateway has lost it and no node will listen to it. ' +
        (state === 'needed' ? 'Restore the add-on\'s backup of epoch ' + mine.epoch + '.'
                            : 'Restore from your newest backup file.')));
    }
    var onFactory = !!(st && st.epoch === 0);
    $('#nc-backup-dl').disabled = !st || onFactory || !NQ.broker.up();
    $('#nc-restore-addon').style.display = managed ? '' : 'none';
    $('#nc-restore-addon').disabled = !(onFactory && mine) || !NQ.broker.up();
    $('#nc-restore-file').disabled = !onFactory || !NQ.broker.up();
  }

  function preview() {
    var cur = status();
    var st = cur ? cur.doc : null;
    var box = clear($('#nc-preview'));
    var btn = $('#nc-propose');
    if (!st) {
      box.appendChild(h('span', { text: 'Waiting for bridge/netcfg from the gateway. A gateway ' +
                                        'without it predates network-wide settings.' }));
      btn.disabled = true;
      return;
    }
    var r = N.request(form(), st);
    btn.disabled = !r.ok || !NQ.broker.up();
    if (!r.ok) { box.appendChild(h('span', { text: r.why })); return; }
    var rows = N.fleet(NQ.model.list(), st, cur.ts);
    box.appendChild(h('span', { text: N.describe(r.body, st,
      rows.filter(function (x) { return x.kind === 'sleeper'; }).length) }));
  }

  var STATE = {
    idle: 'No change since the gateway started.',
    preparing: 'The new record is out; waiting for every voter to store it and acknowledge.',
    committing: 'Every voter acknowledged. The switch is commanded for all of them at once.',
    verifying: 'Switched. Waiting to hear a voter on the new record; if none is heard ' +
               'within the revert time, everyone goes back.',
    done: 'Done. The mesh runs on the new record.',
    aborted: 'Aborted: not every voter acknowledged, so nothing moved.',
    reverted: 'Reverted: no voter was heard on the new record, so the gateway went back ' +
              'and the nodes follow.'
  };

  function progress(g, cur) {
    var box = clear($('#nc-progress'));
    if (!cur) {
      box.appendChild(h('div', { class: 'note', text: 'No status yet.' }));
      return;
    }
    var st = cur.doc;
    var cls = st.state === 'done' ? 'ok' : (st.state === 'aborted' || st.state === 'reverted') ? 'badc'
            : N.busy(st) ? 'warnc' : 'dim';
    box.appendChild(h('div', { class: 'row' }, [
      h('strong', { class: cls, text: st.state || '?' }),
      h('span', { class: 'faint mono', text: 'status ' + ago(cur.ts) })
    ]));
    box.appendChild(h('p', { class: 'note', style: 'margin:6px 0 0', text: STATE[st.state] || '' }));
    if (st.target) {
      var t = st.target;
      box.appendChild(h('div', { class: 'mono', style: 'margin-top:8px',
        text: 'target epoch ' + t.epoch + ' · channel ' + t.channel +
              (t.rotate_key ? ' · new key' : '') + ' · acked ' + st.acked + ' / ' + st.voters }));
      if (st.missing && st.missing.length) {
        box.appendChild(h('div', { class: 'warnc', style: 'margin-top:4px',
          text: 'not acknowledged: ' + st.missing.map(function (m) { return NQ.store.label(m); }).join(', ') }));
      }
    }
    var res = (g.netcfgResults || []).slice(-4).reverse();
    if (res.length) {
      var tb = h('tbody', {});
      res.forEach(function (r) {
        var d = r.doc;
        tb.appendChild(h('tr', {}, [
          h('td', { class: 'mono faint', text: U.hhmm(r.ts).slice(0, 8) }),
          h('td', { class: 'mono', text: d.cmd }),
          h('td', { class: d.ok ? 'ok' : 'badc',
                    text: d.ok ? 'accepted' : (ERR[d.err] || d.err) })
        ]));
      });
      box.appendChild(h('table', { style: 'margin-top:10px' }, [tb]));
    }
  }

  var WHERE = {
    current:  { cls: 'ok',    text: 'current' },
    pending:  { cls: 'warnc', text: 'on the new record' },
    previous: { cls: 'warnc', text: 'previous — will be told' },
    stranded: { cls: 'badc',  text: 'stranded — needs a join window' },
    unknown:  { cls: 'unk',   text: 'not reported' }
  };

  function table(rows) {
    var tb = h('tbody', {});
    tb.appendChild(h('tr', {}, ['device', 'kind', 'epoch', 'ch', 'switches', 'reverts', 'hunts', 'state', 'seen']
      .map(function (t, i) { return h('th', { class: i >= 2 && i <= 6 ? 'num' : '', text: t }); })));
    rows.forEach(function (r) {
      var w = WHERE[r.where];
      tb.appendChild(h('tr', {}, [
        h('td', { class: 'mono', text: NQ.store.label(r.id) }),
        h('td', { class: 'dim', text: r.kind }),
        h('td', { class: 'num', text: r.epoch === null ? '—' : String(r.epoch) }),
        h('td', { class: 'num', text: r.channel === null ? '—' : String(r.channel) }),
        h('td', { class: 'num', text: r.switches === null ? '' : String(r.switches) }),
        h('td', { class: 'num ' + (r.reverts ? 'warnc' : ''), text: r.reverts === null ? '' : String(r.reverts) }),
        h('td', { class: 'num ' + (r.hunts ? 'warnc' : ''), text: r.hunts === null ? '' : String(r.hunts) }),
        h('td', { class: w.cls, text: w.text + (r.missing ? ' · did not ack' : '') }),
        h('td', { class: 'faint', text: ago(r.ts) })
      ]));
    });
    var t = clear($('#nc-table'));
    t.appendChild(tb);
  }

  function tile(label, value, sub, cls) {
    return h('div', { class: 'tile ' + (cls || '') }, [
      h('div', { class: 'lbl', text: label }),
      h('div', { class: 'val', text: value }),
      sub ? h('div', { class: 'sub', text: sub }) : null
    ]);
  }

  function network() {
    wire();
    var g = NQ.model.gateway();
    var cur = status();
    var st = cur ? cur.doc : null;
    var now = Date.now() / 1000;

    if (st && !touched) $('#nc-channel').value = String(st.channel);
    Array.prototype.forEach.call($('#nc-channel').options, function (o) {
      var want = o.value + (st && Number(o.value) === st.channel ? ' (current)' : '');
      if (o.textContent !== want) o.textContent = want;
    });

    var tiles = clear($('#nc-tiles'));
    var rows = N.fleet(NQ.model.list(), st, cur ? cur.ts : 0, now);
    var s = N.summary(rows);
    if (!st) {
      tiles.appendChild(tile('network', '—', g ? 'gateway publishes no bridge/netcfg' : 'no gateway seen', 'grey'));
    } else {
      var join = N.left(st.join_s, cur.ts, now);
      var prev = N.left(st.prev_key_s, cur.ts, now);
      tiles.appendChild(tile('channel', String(st.channel), 'epoch ' + st.epoch));
      tiles.appendChild(tile('previous key', typeof st.prev_epoch === 'number' && prev ? dur(prev) : '—',
        typeof st.prev_epoch === 'number' ? 'epoch ' + st.prev_epoch + ', channel ' + st.prev_channel +
                                            ' still understood' : 'none held', prev ? '' : 'grey'));
      tiles.appendChild(tile('join window', join ? dur(join) : 'closed',
        join ? 'factory-key devices are let in' : 'factory key opens nothing', join ? '' : 'grey'));
      tiles.appendChild(tile('voters', typeof st.members === 'number' ? String(st.members) : '—',
        'mains nodes heard in 15 min'));
      tiles.appendChild(tile('on current', s.current + ' / ' + s.total,
        s.unknown ? s.unknown + ' not reporting' : 'every device reports', s.current === s.total ? '' : 'grey'));
    }

    var ban = clear($('#nc-banner'));
    if (s.stranded) {
      ban.appendChild(U.banner('bad', s.stranded + ' device(s) are on a record the mesh no longer ' +
        'holds a key for. They still have the factory key, so opening a join window lets them back in.'));
    } else if (s.previous && !N.busy(st)) {
      ban.appendChild(U.banner('warn', s.previous + ' device(s) are still on the previous record. ' +
        'Anyone hearing them tells them where the mesh went, and a sleeper catches up on a later wake. ' +
        'Wait for them before the next change: it drops the key they hold.'));
    }
    if (sentNote) ban.appendChild(U.banner(sentNote.kind, sentNote.text));

    var busy = N.busy(st);
    $('#nc-join-open').disabled = !st || !NQ.broker.up();
    $('#nc-join-close').disabled = !st || !NQ.broker.up() || !N.left(st.join_s, cur.ts, now);
    $('#nc-join-left').textContent = st && N.left(st.join_s, cur.ts, now)
      ? 'open, ' + dur(N.left(st.join_s, cur.ts, now)) + ' left' : '';
    $('#nc-propose-stat').textContent = busy ? 'change ' + st.state + '…' : '';

    refreshAddonBackups(false);
    renderBackup(st);
    preview();
    if (g) progress(g, cur); else clear($('#nc-progress'));
    table(rows);
  }

  NQ.views.network = network;
})(window.NQ = window.NQ || {});
