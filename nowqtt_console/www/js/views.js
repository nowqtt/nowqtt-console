/* views.js — devices, soak, gateway and OTA.
 *
 * Split from ui.js because that file is the shell and this one is the content;
 * v1 was a single 1138-line page and the split is the main maintainability
 * win of v2. */

(function (NQ) {
  'use strict';

  var U = NQ.ui;
  var h = U.h, $ = U.$, clear = U.clear, ago = U.ago, num = U.num, spark = U.spark;

  function root() { return NQ.ui.cfg().prefix + '/' + (NQ.model.gwUid() || NQ.ui.cfg().uid); }
  function pub(topic, payload, retain) {
    return NQ.broker.publish(topic, payload, { qos: 0, retain: !!retain });
  }

  function tile(label, value, sub, cls) {
    return h('div', { class: 'tile ' + (cls || '') }, [
      h('div', { class: 'lbl', text: label }),
      h('div', { class: 'val', text: value }),
      sub ? h('div', { class: 'sub', text: sub }) : null
    ]);
  }

  function sv(d, path) {
    var s = d.series[path];
    return s ? s.v : null;
  }

  /* ==================== devices ======================================== */

  function devices() {
    var list = NQ.model.list();
    renderList(list);
    var id = U.selected();
    var dev = id ? NQ.model.get(id) : null;
    if (!dev && list.length) { dev = list[0]; U.select(dev.id); }
    renderDetail(dev);
  }

  function renderList(list) {
    var box = clear($('#devlist'));
    if (!list.length) {
      box.appendChild(h('div', { class: 'note', style: 'padding:14px',
        text: NQ.broker.up() ? 'Connected; waiting for the first publish. Retained ' +
                               'state should arrive immediately, so an empty list ' +
                               'means the prefix or the uid is wrong.'
                             : 'Not connected.' }));
      return;
    }
    list.forEach(function (d) {
      var del = NQ.model.delivery(d);
      var sel = d.id === U.selected();
      box.appendChild(h('div', {
        class: 'dev' + (sel ? ' sel' : ''),
        onclick: function () { U.select(d.id); NQ.map.select(d.id); devices(); }
      }, [
        h('i', { class: 'kindmark kind-' + d.kind }),
        h('div', {}, [
          h('div', { class: 'name', text: NQ.store.label(d.id) }),
          h('div', { class: 'meta', text: d.kind + (d.build ? ' · ' + d.build : '') })
        ]),
        h('div', { class: 'right' }, [
          h('div', { text: ago(d.lastSeen) }),
          h('div', { class: del && del.ratio < 0.99 ? 'warnc' : 'faint',
                     text: del ? (del.ratio * 100).toFixed(1) + '%' : '' })
        ])
      ]));
    });
  }

  function renderDetail(d) {
    var box = clear($('#devdetail'));
    if (!d) { box.appendChild(h('div', { class: 'note', text: 'No device selected.' })); return; }

    /* --- identity --- */
    var nameInput = h('input', { value: NQ.store.name(d.id),
                                 placeholder: NQ.store.declared(d.id) || d.id,
                                 style: 'width:220px' });
    nameInput.addEventListener('change', function () {
      NQ.store.setName(d.id, nameInput.value.trim());
      U.markDirty();
    });

    box.appendChild(h('div', { class: 'panel' }, [
      h('h2', {}, [
        h('i', { class: 'kindmark kind-' + d.kind }),
        document.createTextNode(d.id),
        h('span', { class: 'sub', text: d.kind + (d.build ? ' · build ' + d.build : '') +
                                        ' · seen ' + ago(d.lastSeen) })
      ]),
      h('div', { class: 'body' }, [
        h('div', { class: 'row' }, [
          h('label', { class: 'field' }, [document.createTextNode('name'), nameInput]),
          h('div', { class: 'note', style: 'flex:1;min-width:220px',
            text: 'The name is stored in this browser. A node has nowhere to ' +
                  'keep one until it carries a config document of its own.' })
        ])
      ])
    ]));

    box.appendChild(headline(d));
    var ctl = controls(d);
    if (ctl) box.appendChild(ctl);
    box.appendChild(configPanel(d));
    box.appendChild(seriesPanel(d));
  }

  function headline(d) {
    var t = h('div', { class: 'tiles', style: 'margin-bottom:12px' });
    var del = NQ.model.delivery(d);
    var hs = NQ.model.heapSlope(d);

    if (d.kind === 'gateway') {
      t.appendChild(tile('uptime', fmtUptime(sv(d, 'uptime_s'))));
      t.appendChild(tile('free heap', num(sv(d, 'heap')),
        hs ? (hs.bytesPerDay >= 0 ? '+' : '') + Math.round(hs.bytesPerDay) + ' B/day' : 'trend needs 10 min'));
      t.appendChild(tile('neighbours', num(sv(d, 'peers')), 'routes ' + num(sv(d, 'routes'))));
      t.appendChild(tile('leaves', num(sv(d, 'leaves')), 'acks ' + num(sv(d, 'leaf_acks'))));
      t.appendChild(tile('rx / tx', num(sv(d, 'rx')) + ' / ' + num(sv(d, 'tx')),
        'forwarded ' + num(sv(d, 'fwd'))));
      t.appendChild(tile('tx failed', num(sv(d, 'tx_fail')),
        'dropped topic ' + num(sv(d, 'drop_topic'))));
      t.appendChild(tile('slot', String(sv(d, 'slot') || '—'),
        'boot try ' + num(sv(d, 'boot_try'))));
      t.appendChild(tile('rssi', num(sv(d, 'rssi')) + ' dBm',
        'best ' + num(sv(d, 'best_rssi'))));
    } else if (d.kind === 'sleeper') {
      var acked = ackRate(d);
      t.appendChild(tile('wake', num(sv(d, 'report.wake')),
        del ? del.missing + ' missed of ' + del.expected : null));
      t.appendChild(tile('battery', num(sv(d, 'report.batt'), 3) + ' V'));
      t.appendChild(tile('awake', num(sv(d, 'report.prev.awake_ms')) + ' ms',
        'send ' + num(sv(d, 'report.prev.send_ms')) + ' ms · radio ' +
        num(sv(d, 'report.radio_ms')) + ' ms'));
      t.appendChild(tile('acked', acked === null ? '—' : (acked * 100).toFixed(0) + '%',
        'silent streak ' + num(sv(d, 'report.silent')),
        acked !== null && acked < 0.8 ? 'grey' : ''));
      t.appendChild(tile('sensor', num(sv(d, 'report.sensor_ms')) + ' ms'));
      t.appendChild(tile('ota wakes', num(sv(d, 'report.ota_wakes')),
        'otarx ' + [sv(d, 'report.otarx.0'), sv(d, 'report.otarx.1'), sv(d, 'report.otarx.2')]
          .map(function (x) { return num(x); }).join('/')));
      t.appendChild(tile('nvs free', num(sv(d, 'report.nvs_free')),
        'reset reason ' + num(sv(d, 'report.rst'))));
      t.appendChild(tile('delivery', del ? (del.ratio * 100).toFixed(1) + '%' : '—',
        del ? del.received + ' of ' + del.expected : 'needs two reports'));
    } else {
      t.appendChild(tile('gateway', num(sv(d, 'mesh.gw_hops')) + ' hops',
        'peers ' + num(sv(d, 'mesh.peers')) + ' · routes ' + num(sv(d, 'mesh.routes'))));
      t.appendChild(tile('delivery', del ? (del.ratio * 100).toFixed(1) + '%' : '—',
        del ? del.received + ' of ' + del.expected + ', ' + del.missing + ' missed' : 'needs two reports'));
      t.appendChild(tile('free heap', num(sv(d, 'free_heap')),
        hs ? (hs.bytesPerDay >= 0 ? '+' : '') + Math.round(hs.bytesPerDay) + ' B/day' : 'trend needs 10 min'));
      t.appendChild(tile('rssi', num(sv(d, 'rssi')) + ' dBm'));
      t.appendChild(tile('leaf tx', [sv(d, 'mesh.ltx.0'), sv(d, 'mesh.ltx.1'), sv(d, 'mesh.ltx.2')]
        .map(function (x) { return num(x); }).join(' / '), 'ok / fail / muted'));
      t.appendChild(tile('ack turnaround', num(sv(d, 'mesh.ack_us')) + ' µs',
        'leaf acks ' + num(sv(d, 'mesh.leaf_acks'))));
      t.appendChild(tile('tx failed', num(sv(d, 'mesh.tx_fail')),
        'forwarded ' + num(sv(d, 'mesh.fwd'))));
      t.appendChild(tile('uptime', fmtUptime(sv(d, 'uptime')),
        'reboots seen ' + (del ? del.reboots : 0)));
    }
    return t;
  }

  function fmtUptime(s) {
    if (s === null || s === undefined) return '—';
    var d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
    return (d ? d + 'd ' : '') + hh + 'h ' + mm + 'm';
  }

  /* A sleeper's own view of whether its report was answered. The mean over
   * the kept history, which is the only per-device ack number that exists on
   * the leaf side. */
  function ackRate(d) {
    var s = d.series['report.prev.acked'];
    if (!s || s.hist.length < 3) return null;
    var n = 0;
    s.hist.forEach(function (p) { n += p.v ? 1 : 0; });
    return n / s.hist.length;
  }

  /* --- controls: only for topics a device has SHOWN it answers ---------- */

  function controls(d) {
    if (d.kind === 'gateway') return null;
    var base = root() + '/dev/' + d.id + '/set/';
    var rows = [];

    if (d.topics['led_state']) {
      rows.push(h('div', { class: 'row' }, [
        h('span', { class: 'dim', style: 'width:120px', text: 'led' }),
        h('span', { class: 'mono', style: 'width:44px', text: d.topics['led_state'].raw }),
        h('button', { class: 'btn sm', text: 'ON', onclick: function () { pub(base + 'led', 'ON'); } }),
        h('button', { class: 'btn sm', text: 'OFF', onclick: function () { pub(base + 'led', 'OFF'); } })
      ]));
    }

    if (d.topics['report_interval']) {
      var iv = h('input', { value: d.topics['report_interval'].raw, style: 'width:90px' });
      rows.push(h('div', { class: 'row' }, [
        h('span', { class: 'dim', style: 'width:120px', text: 'report interval' }),
        iv,
        h('button', { class: 'btn sm', text: 'Set',
          onclick: function () { pub(base + 'report_interval', iv.value.trim()); } })
      ]));
    }

    if (d.topics['log_level']) {
      var sel = h('select', {});
      ['none', 'error', 'warn', 'info', 'debug', 'verbose'].forEach(function (lv) {
        sel.appendChild(h('option', { value: lv, text: lv }));
      });
      sel.value = String(d.topics['log_level'].raw || 'info');
      rows.push(h('div', { class: 'row' }, [
        h('span', { class: 'dim', style: 'width:120px', text: 'log level' }),
        sel,
        h('button', { class: 'btn sm', text: 'Set',
          onclick: function () { pub(base + 'log_level', sel.value); } }),
        h('span', { class: 'note', text: 'forwarded over the mesh; off on sleepers by design' })
      ]));
    }

    /* The transport is not Home Assistant specific, so any topic a firmware
     * subscribes to has to be reachable from here without this page knowing
     * it exists. */
    var gt = h('input', { placeholder: 'topic', style: 'width:150px' });
    var gp = h('input', { placeholder: 'payload', style: 'width:190px' });
    rows.push(h('div', { class: 'row' }, [
      h('span', { class: 'dim', style: 'width:120px', text: 'publish' }),
      gt, gp,
      h('button', { class: 'btn sm', text: 'Send',
        onclick: function () {
          if (!gt.value.trim()) return;
          pub(base + gt.value.trim(), gp.value);
        } })
    ]));

    if (d.kind === 'sleeper') {
      rows.push(h('p', { class: 'note', style: 'margin:4px 0 0',
        text: 'A sleeper is asleep. The gateway parks a downlink in its mailbox ' +
              'and a relay hands it over during the next wake\'s ack window, so ' +
              'expect it to take up to one report interval — and to be delivered ' +
              'only if some node in earshot can actually reach it.' }));
    }

    return h('div', { class: 'panel' }, [
      h('h2', {}, [document.createTextNode('Controls'),
                   h('span', { class: 'sub', text: 'shown only where the device has answered on the topic' })]),
      h('div', { class: 'body', style: 'display:grid;gap:8px' }, rows)
    ]);
  }

  /* --- the dzg_config editor ------------------------------------------- */

  var edits = {};      /* path -> raw value, for the selected device only */
  var editsFor = null;
  var applyNote = null;

  function configPanel(d) {
    if (editsFor !== d.id) { edits = {}; editsFor = d.id; applyNote = null; }

    var body = h('div', { class: 'body' });
    var panel = h('div', { class: 'panel' }, [
      h('h2', {}, [document.createTextNode('Configuration'),
        h('span', { class: 'sub', text: d.kind === 'gateway' ? 'device/config' : 'over the mesh' })]),
      body
    ]);

    if (!d.config) {
      body.appendChild(h('div', { class: 'note' }, [
        d.kind === 'gateway'
          ? document.createTextNode('No config/current retained yet. The gateway ' +
              'publishes its whole document on connect, so this usually means the ' +
              'gateway has not connected since the broker last started.')
          : document.createTextNode('This node does not publish a config document yet. ' +
              'The dzg_config engine over the mesh is written but not deployed — ' +
              'deploying it reboots a node and restarts its soak clock, so it waits ' +
              'for the end of the run (plan §6 stage 5). Until then the Controls ' +
              'above are the settable surface.')
      ]));
      return panel;
    }

    var fields = NQ.config.fields(d.config.doc);
    var tbl = h('table', {});
    var tb = h('tbody', {});
    var lastSection = null;

    fields.forEach(function (f) {
      if (f.section !== lastSection) {
        lastSection = f.section;
        tb.appendChild(h('tr', {}, [h('th', { colspan: 3, text: f.section || '(root)' })]));
      }
      var input;
      if (f.type === 'bool') {
        input = h('input', { type: 'checkbox' });
        input.checked = !!f.value;
        input.addEventListener('change', function () { edits[f.path] = input.checked; });
      } else if (f.readonly) {
        input = h('span', { class: 'mono faint', text: String(f.value) });
      } else {
        input = h('input', { value: String(f.value), style: 'width:100%',
                             type: f.secret ? 'text' : (f.type === 'int' || f.type === 'float' ? 'number' : 'text') });
        input.addEventListener('input', function () { edits[f.path] = input.value; });
      }
      tb.appendChild(h('tr', {}, [
        h('td', { class: 'k', text: f.key }),
        h('td', {}, [input]),
        h('td', { class: 'faint', style: 'font-size:11px',
                  text: f.secret ? 'secret — leave masked to keep it' : f.type })
      ]));
    });
    tbl.appendChild(tb);
    body.appendChild(tbl);

    var note = h('div', { class: 'note', style: 'margin:10px 0' });
    if (applyNote) note.appendChild(U.banner(applyNote.kind, applyNote.text));
    body.appendChild(note);

    body.appendChild(h('div', { class: 'row' }, [
      h('button', {
        class: 'btn primary', text: 'Apply changed fields',
        onclick: function () {
          var dd = NQ.config.diff(d.config.doc, edits);
          if (!dd.count) {
            applyNote = { kind: 'info', text: 'Nothing changed.' };
            U.markDirty(); return;
          }
          NQ.config.publish(d, NQ.ui.cfg().prefix, NQ.model.gwUid() || NQ.ui.cfg().uid,
                            dd.patch, function (err) {
            if (err) {
              applyNote = { kind: 'bad', text: String(err.message || err) };
            } else {
              applyNote = {
                kind: d.kind === 'sleeper' ? 'warn' : 'info',
                text: d.kind === 'sleeper'
                  ? 'Queued: ' + dd.count + ' field(s) sent. A sleeper gets this ' +
                    'through the mailbox on a later wake; it is applied only when ' +
                    'the retained config echo comes back changed.'
                  : 'Sent ' + dd.count + ' changed field(s): ' + JSON.stringify(dd.patch) +
                    '. Applied when the retained echo comes back.'
              };
              edits = {};
            }
            U.markDirty();
          });
        }
      }),
      h('button', { class: 'btn', text: 'Discard', onclick: function () { edits = {}; applyNote = null; U.markDirty(); } }),
      h('span', { class: 'faint mono', text: 'echoed ' + ago(d.config.ts) })
    ]));

    body.appendChild(h('p', { class: 'note', style: 'margin:10px 0 0',
      text: 'Only fields you changed are sent. The engine merges partial ' +
            'documents, so sending the whole thing would fire change callbacks ' +
            'for fields nobody touched — and over the mesh it would spend a ' +
            'frame it did not need to.' }));

    return panel;
  }

  /* --- every series the device publishes, grouped ---------------------- */

  function seriesPanel(d) {
    var groups = {};
    Object.keys(d.series).sort().forEach(function (p) {
      var g = p.indexOf('.') > 0 ? p.slice(0, p.indexOf('.')) : '(top)';
      (groups[g] = groups[g] || []).push(p);
    });

    var body = h('div', { class: 'body tight' });
    Object.keys(groups).sort().forEach(function (g) {
      var tb = h('tbody', {});
      tb.appendChild(h('tr', {}, [h('th', { text: g }), h('th', { class: 'num', text: 'value' }), h('th', { text: '' })]));
      groups[g].forEach(function (p) {
        var s = d.series[p];
        tb.appendChild(h('tr', {}, [
          h('td', { class: 'k', text: p }),
          h('td', { class: 'num', text: typeof s.v === 'number' ? String(s.v) : String(s.v) }),
          h('td', { style: 'width:100px' }, [spark(s.hist)])
        ]));
      });
      body.appendChild(h('table', {}, [tb]));
    });

    if (!Object.keys(groups).length) {
      body.appendChild(h('div', { class: 'note', style: 'padding:12px', text: 'Nothing numeric yet.' }));
    }

    return h('div', { class: 'panel' }, [
      h('h2', {}, [document.createTextNode('Counters'),
        h('span', { class: 'sub', text: 'aggregated frames un-flattened, one series each' })]),
      body
    ]);
  }

  /* ==================== soak =========================================== */

  function soak() {
    var list = NQ.model.list();
    var nodes = list.filter(function (d) { return d.kind === 'node'; });
    var sleepers = list.filter(function (d) { return d.kind === 'sleeper'; });
    var gw = NQ.model.gateway();
    var box = clear($('#soak-tiles'));

    var st = NQ.model.stats();
    var windowS = st.lastTs - st.firstTs;

    /* This page has only been watching since it connected. Saying so matters:
     * the soak is seven days and a browser tab is not the recorder. */
    box.appendChild(tile('observed here', fmtUptime(windowS),
      'this tab only — the recorder on the broker host is the record'));

    /* --- delivery --- */
    var worst = null;
    list.forEach(function (d) {
      var del = NQ.model.delivery(d);
      if (!del) return;
      if (!worst || del.ratio < worst.ratio) worst = { ratio: del.ratio, id: d.id, del: del };
    });
    box.appendChild(worst
      ? tile('worst delivery', (worst.ratio * 100).toFixed(2) + '%',
             NQ.store.label(worst.id) + ' · ' + worst.del.missing + ' missed',
             worst.ratio >= 0.99 ? '' : 'grey')
      : tile('worst delivery', '—', 'needs two reports from one device', 'grey'));

    /* --- heap --- */
    var gwh = gw ? NQ.model.heapSlope(gw) : null;
    box.appendChild(gwh
      ? tile('gateway heap', (gwh.bytesPerDay >= 0 ? '+' : '') + Math.round(gwh.bytesPerDay) + ' B/day',
             gwh.samples + ' samples over ' + fmtUptime(gwh.spanS))
      : tile('gateway heap', '—', 'a slope needs 8 samples over 10 minutes', 'grey'));

    var nWorst = null;
    nodes.forEach(function (d) {
      var s = NQ.model.heapSlope(d);
      if (!s) return;
      if (!nWorst || s.bytesPerDay < nWorst.s.bytesPerDay) nWorst = { d: d, s: s };
    });
    box.appendChild(nWorst
      ? tile('worst node heap', (nWorst.s.bytesPerDay >= 0 ? '+' : '') +
             Math.round(nWorst.s.bytesPerDay) + ' B/day', NQ.store.label(nWorst.d.id))
      : tile('worst node heap', '—', 'a slope needs 8 samples over 10 minutes', 'grey'));

    /* --- reboots --- */
    var reb = 0, rebWho = [];
    list.forEach(function (d) {
      if (d.seq.reboots) { reb += d.seq.reboots; rebWho.push(NQ.store.label(d.id)); }
    });
    box.appendChild(tile('reboots seen', String(reb),
      reb ? rebWho.join(', ') : 'none since this tab connected',
      reb ? 'grey' : ''));

    /* --- sleeper wake time ---
     * NOT compared against one fleet constant. The two sleepers have
     * different sensor stacks -- one reads an AHT20 (43 ms), the other has no
     * sensor at all -- so a single projection would call a healthy board
     * broken. Each is measured against its own median, and what matters is
     * whether it is drifting. */
    sleepers.forEach(function (d) {
      var s = d.series['report.prev.awake_ms'];
      if (!s || s.hist.length < 5) {
        box.appendChild(tile('wake ' + NQ.store.label(d.id).slice(0, 8), '—', 'needs five wakes', 'grey'));
        return;
      }
      var vals = s.hist.map(function (p) { return p.v; }).sort(function (a, b) { return a - b; });
      var med = vals[Math.floor(vals.length / 2)];
      var over = s.hist.filter(function (p) { return p.v > med * 1.2; }).length;
      box.appendChild(tile('wake ' + NQ.store.label(d.id).slice(0, 8), med + ' ms',
        over + ' of ' + s.hist.length + ' over +20% of its own median',
        over > s.hist.length * 0.1 ? 'grey' : ''));
    });

    /* --- sleeper ack rate: computable now that the fast ack exists ----- */
    sleepers.forEach(function (d) {
      var a = ackRate(d);
      box.appendChild(a === null
        ? tile('acked ' + NQ.store.label(d.id).slice(0, 8), '—', 'needs three wakes', 'grey')
        : tile('acked ' + NQ.store.label(d.id).slice(0, 8), (a * 100).toFixed(0) + '%',
               'from its own prev.acked; threshold is five consecutive misses',
               a < 0.8 ? 'grey' : ''));
    });

    /* --- the one criterion a page cannot compute ---------------------- */
    box.appendChild(tile('route reconvergence', 'manual',
      'needs a relay unplugged; not something a page can measure', 'grey'));

    /* --- per device table --- */
    var tb = h('tbody', {});
    tb.appendChild(h('tr', {}, ['device', 'kind', 'build', 'counter', 'received', 'expected', 'missed', 'reboots', 'heap B/day']
      .map(function (t, i) { return h('th', { class: i >= 4 ? 'num' : '', text: t }); })));
    list.forEach(function (d) {
      var del = NQ.model.delivery(d);
      var hsl = NQ.model.heapSlope(d);
      tb.appendChild(h('tr', {}, [
        h('td', { text: NQ.store.label(d.id) }),
        h('td', { class: 'dim', text: d.kind }),
        h('td', { class: 'mono faint', text: d.build || '—' }),
        h('td', { class: 'mono faint', text: d.seq.name || '—' }),
        h('td', { class: 'num', text: del ? String(del.received) : '—' }),
        h('td', { class: 'num', text: del ? String(del.expected) : '—' }),
        h('td', { class: 'num ' + (del && del.missing ? 'warnc' : ''), text: del ? String(del.missing) : '—' }),
        h('td', { class: 'num ' + (d.seq.reboots ? 'badc' : ''), text: String(d.seq.reboots) }),
        h('td', { class: 'num', text: hsl ? String(Math.round(hsl.bytesPerDay)) : '—' })
      ]));
    });
    var t = clear($('#soak-table'));
    t.appendChild(tb);
  }

  /* ==================== gateway ======================================== */

  function gateway() {
    var g = NQ.model.gateway();
    var box = clear($('#gw-body'));
    if (!g) {
      box.appendChild(h('div', { class: 'note', text: 'No gateway seen yet.' }));
      return;
    }

    var st = g.topics['stats'];
    box.appendChild(h('div', { class: 'panel' }, [
      h('h2', {}, [document.createTextNode('Gateway ' + g.id),
        h('span', { class: 'sub', text: (g.online === false ? 'OFFLINE (last will) · ' : '') +
                                        'build ' + (g.build || '?') + ' · ' + ago(g.lastSeen) })]),
      h('div', { class: 'body' }, [
        h('div', { class: 'row' }, [
          h('button', {
            class: 'btn danger', text: 'Reboot gateway',
            onclick: function () {
              if (!window.confirm('Reboot the gateway? Every node loses its bridge ' +
                                  'until it is back, and the boot-id change makes ' +
                                  'each one re-announce its topic table.')) return;
              pub(NQ.ui.cfg().prefix + '/' + g.id + '/device/reboot', '1');
            }
          }),
          h('span', { class: 'note', text: 'This is the board behind jumpers in the ' +
                                           'basement; it has no reset button.' })
        ])
      ])
    ]));

    box.appendChild(headline(g));

    if (st) {
      var tb = h('tbody', {});
      Object.keys(st.json).sort().forEach(function (k) {
        var v = st.json[k];
        tb.appendChild(h('tr', {}, [
          h('td', { class: 'k', text: k }),
          h('td', { class: 'num', text: Array.isArray(v) ? v.join(' / ') : String(v) })
        ]));
      });
      box.appendChild(h('div', { class: 'panel' }, [
        h('h2', {}, [document.createTextNode('bridge/stats'),
          h('span', { class: 'sub', text: 'retained, ' + ago(st.ts) })]),
        h('div', { class: 'body tight' }, [h('table', {}, [tb])])
      ]));
    }

    if (g.peers) {
      var tb2 = h('tbody', {});
      tb2.appendChild(h('tr', {}, [h('th', { text: 'neighbour' }), h('th', { class: 'num', text: 'rssi' }),
                                   h('th', { class: 'num', text: 'gw hops' }), h('th', { class: 'num', text: 'tx fail streak' })]));
      g.peers.forEach(function (p) {
        tb2.appendChild(h('tr', {}, [
          h('td', { class: 'mono', text: NQ.store.label(p.m) }),
          h('td', { class: 'num', style: 'color:' + NQ.map.rssiColor(p.rssi), text: p.rssi + ' dBm' }),
          h('td', { class: 'num', text: p.gw < 0 ? 'none' : String(p.gw) }),
          h('td', { class: 'num ' + (p.fail ? 'warnc' : ''), text: String(p.fail) })
        ]));
      });
      var leafRows = (g.leaves || []).map(function (l) {
        return h('tr', {}, [
          h('td', { class: 'mono', text: NQ.store.label(l.m) }),
          h('td', { colspan: 3, class: 'dim',
                    text: 'leaf via ' + (l.relay ? NQ.store.label(l.relay) : 'nobody') +
                          (l.direct ? ' (direct)' : '') + (l.told ? ' · offer told' : '') })
        ]);
      });
      leafRows.forEach(function (r) { tb2.appendChild(r); });
      box.appendChild(h('div', { class: 'panel' }, [
        h('h2', {}, [document.createTextNode('bridge/mesh'),
          h('span', { class: 'sub', text: 'what the gateway itself can reach' })]),
        h('div', { class: 'body tight' }, [h('table', {}, [tb2])])
      ]));
    }

    box.appendChild(configPanel(g));
  }

  /* ==================== OTA ============================================ */

  var otaImage = null;      /* { bytes, parsed, name } */

  function otaTargets() {
    var sel = $('#ota-target');
    var list = NQ.model.list();
    var want = ['__gw__'].concat(list.filter(function (d) { return d.kind !== 'gateway'; })
                                     .map(function (d) { return d.id; }));
    var cur = sel.value;
    if (sel.options.length !== want.length) {
      clear(sel);
      var g = NQ.model.gateway();
      sel.appendChild(h('option', { value: '__gw__',
        text: 'gateway ' + (g ? g.id : '(not seen)') + ' — over Ethernet' }));
      list.forEach(function (d) {
        if (d.kind === 'gateway') return;
        sel.appendChild(h('option', { value: d.id,
          text: NQ.store.label(d.id) + ' — ' + d.kind + (d.build ? ' · ' + d.build : '') }));
      });
      sel.value = cur || '__gw__';
    }
    otaTargetNote();
  }

  function otaTargetNote() {
    var sel = $('#ota-target');
    var isGw = sel.value === '__gw__';
    var d = isGw ? null : NQ.model.get(sel.value);
    var box = clear($('#ota-targetnote'));

    if (!$('#ota-chunk').dataset.touched) {
      $('#ota-chunk').value = isGw ? NQ.ota.CHUNK_DIRECT : NQ.ota.CHUNK_MESH;
    }
    if (d && d.kind === 'sleeper' && !$('#ota-blind').dataset.touched) {
      $('#ota-blind').checked = true;
    }

    if (isGw) {
      box.appendChild(h('div', { class: 'note',
        text: '4096-byte chunks straight over Ethernet. This is the one device ' +
              'whose board needs jumpers moved to flash by wire, which is why ' +
              'this path exists at all.' }));
    } else if (d && d.kind === 'sleeper') {
      box.appendChild(U.banner('warn',
        'A sleeping leaf. The gateway parks the offer and delivers it on the ' +
        'next wake, so the first replies go nowhere — leave blind mode on. ' +
        'Expect ~750 KB at roughly 16 KB/s and a battery cost; it has been ' +
        'measured at 46 s.'));
    } else if (d) {
      box.appendChild(h('div', { class: 'note',
        text: '1024-byte chunks over the mesh, one in flight. ' +
              (sv(d, 'mesh.gw_hops') > 1
                ? 'This node is ' + sv(d, 'mesh.gw_hops') + ' hops out, so every chunk ' +
                  'and every ack crosses a relay.'
                : 'One hop from the gateway.') }));
    }

    if (otaImage && otaImage.parsed.ok && d && d.build &&
        otaImage.parsed.desc.version === d.build) {
      box.appendChild(U.banner('info', 'The target already reports build ' + d.build + '.'));
    }
    $('#ota-start').disabled = !(otaImage && otaImage.parsed.ok && NQ.broker.up() && !NQ.ota.active());
  }

  function readImage(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var bytes = new Uint8Array(fr.result);
      var parsed = NQ.image.parse(bytes);
      otaImage = { bytes: bytes, parsed: parsed, name: file.name };
      renderImage();
      otaTargetNote();
    };
    fr.readAsArrayBuffer(file);
  }

  function renderImage() {
    var box = clear($('#ota-image'));
    if (!otaImage) return;
    var p = otaImage.parsed;
    var target = $('#ota-target').value === '__gw__' ? NQ.model.gateway()
                                                     : NQ.model.get($('#ota-target').value);
    var rep = NQ.image.describe(p, target);

    box.appendChild(h('div', { class: 'row', style: 'justify-content:space-between' }, [
      h('strong', { text: otaImage.name }),
      h('span', { class: 'mono dim', text: U.kb(otaImage.bytes.length) })
    ]));

    if (p.ok) {
      var tb = h('tbody', {});
      [['project', p.desc.project], ['version', p.desc.version], ['chip', p.chip],
       ['built', p.desc.date + ' ' + p.desc.time], ['idf', p.desc.idf],
       ['segments', String(p.segments)], ['sha256 appended', p.hashAppended ? 'yes' : 'no']]
        .forEach(function (r) {
          tb.appendChild(h('tr', {}, [h('td', { class: 'k', text: r[0] }),
                                      h('td', { class: 'mono', text: r[1] })]));
        });
      box.appendChild(h('table', { style: 'margin-top:8px' }, [tb]));
    }

    rep.fatal.forEach(function (m) { box.appendChild(U.banner('bad', m)); });
    rep.warn.forEach(function (m) { box.appendChild(U.banner('warn', m)); });
    box.appendChild(h('p', { class: 'note', style: 'margin:8px 0 0',
      text: 'This is a reading of the file, not a gate. The chip-id check that ' +
            'matters runs in the device on the first chunk, so it protects the ' +
            'device from every sender rather than only from this page.' }));
  }

  function wireOta() {
    var drop = $('#ota-drop'), file = $('#ota-file');
    $('#ota-pick').addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () { if (file.files[0]) readImage(file.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readImage(f);
    });

    $('#ota-target').addEventListener('change', function () { renderImage(); otaTargetNote(); });
    $('#ota-chunk').addEventListener('input', function () { this.dataset.touched = '1'; });
    $('#ota-blind').addEventListener('change', function () { this.dataset.touched = '1'; });

    $('#ota-abort').addEventListener('click', function () { NQ.ota.abort(); });
    $('#ota-start').addEventListener('click', startTransfer);
  }

  function logLine(msg) {
    var box = $('#ota-log');
    if (box.textContent === 'no transfer yet') box.textContent = '';
    box.textContent += (box.textContent ? '\n' : '') + U.hhmm(Date.now() / 1000) + '  ' + msg;
    box.scrollTop = box.scrollHeight;
  }

  function startTransfer() {
    if (!otaImage || !otaImage.parsed.ok) return;
    var sel = $('#ota-target').value;
    var isGw = sel === '__gw__';
    var gwUid = NQ.model.gwUid() || NQ.ui.cfg().uid;
    if (!gwUid) { logLine('no gateway uid yet; cannot address the OTA topics'); return; }

    $('#ota-log').textContent = '';
    $('#ota-bar').classList.remove('err');
    $('#ota-bar').firstElementChild.style.width = '0';
    $('#ota-start').disabled = true;
    $('#ota-abort').disabled = false;

    var p = otaImage.parsed;
    logLine(p.desc.project + ' ' + p.desc.version + ' (' + p.chip + '), ' +
            otaImage.bytes.length + ' bytes');

    NQ.ota.start({
      mac: isGw ? null : sel,
      uid: gwUid,
      prefix: NQ.ui.cfg().prefix,
      bytes: otaImage.bytes,
      chunk: Number($('#ota-chunk').value) || undefined,
      retries: Number($('#ota-retries').value),
      reboot: $('#ota-reboot').checked,
      blind: $('#ota-blind').checked,
      timeout: Number($('#ota-timeout').value) || 8,
      onEvent: function (ev) {
        if (ev.type === 'log') logLine(ev.msg);
        else if (ev.type === 'progress') {
          $('#ota-bar').firstElementChild.style.width = ev.pct + '%';
          $('#ota-stat').textContent = ev.pct + '%  ' + ev.sent + '/' + ev.total +
                                       '  ' + ev.rate.toFixed(1) + ' KiB/s';
        } else if (ev.type === 'done') {
          logLine('done: ' + ev.result.bytes + ' bytes in ' + ev.result.seconds.toFixed(1) +
                  's (' + ev.result.rate.toFixed(1) + ' KiB/s)' +
                  (ev.result.resends ? ', ' + ev.result.resends + ' resend(s)' : '') +
                  (ev.result.rebooting ? '; device is rebooting' : '; image staged'));
          logLine('confirm it by watching the build topic change, not by this line.');
          $('#ota-start').disabled = false; $('#ota-abort').disabled = true;
        } else if (ev.type === 'error') {
          logLine('FAILED: ' + ev.error);
          $('#ota-bar').classList.add('err');
          $('#ota-start').disabled = false; $('#ota-abort').disabled = true;
        }
      }
    }).catch(function () { /* reported through onEvent */ });
  }

  /* ==================== history ======================================== */

  var histState = { device: null, series: null, range: 86400, wired: false, loading: false };

  function svgEl(name, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', name);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  function fmtVal(v) {
    if (Math.abs(v) >= 100000) return (v / 1000).toFixed(0) + 'k';
    if (Math.abs(v) >= 1000) return v.toFixed(0);
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
  }

  function fmtTime(t, span) {
    var d = new Date(t * 1000);
    function p(n) { return ('0' + n).slice(-2); }
    /* Over a day the clock time alone is ambiguous; under one the date is
     * noise. */
    return span > 86400 ? (p(d.getDate()) + '.' + p(d.getMonth() + 1))
                        : (p(d.getHours()) + ':' + p(d.getMinutes()));
  }

  function drawChart(box, res) {
    clear(box);
    var pts = res.points || [];
    if (pts.length < 2) {
      box.appendChild(h('div', { class: 'note',
        text: pts.length ? 'One sample in this range -- nothing to draw yet.'
                         : 'No samples stored in this range.' }));
      return;
    }

    var W = Math.max(480, Math.min(1120, box.clientWidth || 900));
    var H = 260;
    var sc = NQ.history.scale(pts, W, H);
    var svg = svgEl('svg', { width: W, height: H, style: 'display:block' });

    sc.yTicks.forEach(function (v) {
      var yy = sc.y(v);
      svg.appendChild(svgEl('line', {
        x1: sc.pad.l, x2: W - sc.pad.r, y1: yy, y2: yy,
        stroke: 'var(--line)', 'stroke-width': 1
      }));
      var t = svgEl('text', { x: sc.pad.l - 6, y: yy + 3.5, 'text-anchor': 'end',
                              class: 'edgelabel' });
      t.textContent = fmtVal(v);
      svg.appendChild(t);
    });

    var span = sc.t1 - sc.t0;
    sc.xTicks.forEach(function (tv) {
      var xx = sc.x(tv);
      if (xx < sc.pad.l || xx > W - sc.pad.r) return;
      svg.appendChild(svgEl('line', {
        x1: xx, x2: xx, y1: sc.pad.t, y2: H - sc.pad.b,
        stroke: 'var(--line)', 'stroke-width': 1, opacity: 0.5
      }));
      var t2 = svgEl('text', { x: xx, y: H - 6, 'text-anchor': 'middle',
                               class: 'edgelabel' });
      t2.textContent = fmtTime(tv, span);
      svg.appendChild(t2);
    });

    svg.appendChild(svgEl('path', {
      d: sc.path, fill: 'none', stroke: 'var(--accent-2)', 'stroke-width': 1.6,
      'stroke-linejoin': 'round'
    }));
    box.appendChild(svg);

    /* A series that never moved is the healthy case for most of these, and a
     * flat line at mid-height says less than the number does. */
    var last = pts[pts.length - 1][1];
    var first = pts[0][1];
    box.appendChild(h('div', { class: 'row', style: 'margin-top:8px' }, [
      h('span', { class: 'mono dim', text: 'first ' + fmtVal(first) }),
      h('span', { class: 'mono dim', text: 'last ' + fmtVal(last) }),
      h('span', { class: 'mono ' + (last === first ? 'dim' : (last > first ? 'ok' : 'warnc')),
                  text: (last - first >= 0 ? '+' : '') + fmtVal(last - first) + ' over the range' }),
      sc.flat ? h('span', { class: 'faint', text: 'flat -- it did not move' }) : null
    ]));
  }

  function loadHistory() {
    if (histState.loading || !histState.device || !histState.series) return;
    histState.loading = true;
    var box = $('#hist-chart');
    clear(box).appendChild(h('div', { class: 'note', text: 'loading…' }));
    $('#hist-title').textContent = histState.device + ' · ' + histState.series;

    NQ.history.query(histState.device, histState.series, histState.range)
      .then(function (res) {
        drawChart(box, res);
        var meta = clear($('#hist-meta'));
        meta.appendChild(h('div', {
          text: res.total + ' samples stored in this range' +
                (res.step > 1 ? ', drawn every ' + res.step + 'th' : '') + '.'
        }));
        if (res.step > 1) {
          /* Thinned, not averaged: averaging smooths away the spike that is
           * usually the reason somebody opened the chart. */
          meta.appendChild(h('div', { class: 'faint',
            text: 'Thinned by taking every nth sample rather than averaging, so ' +
                  'every point drawn is a real reading.' }));
        }
      })
      .catch(function (e) {
        clear(box).appendChild(U.banner('bad', String(e.message || e)));
      })
      .then(function () { histState.loading = false; });
  }

  function wireHistory() {
    if (histState.wired) return;
    histState.wired = true;

    var rs = $('#hist-range');
    NQ.history.RANGES.forEach(function (r) {
      rs.appendChild(h('option', { value: String(r.seconds), text: r.label }));
    });
    rs.value = String(histState.range);
    rs.addEventListener('change', function () {
      histState.range = Number(rs.value);
      loadHistory();
    });

    $('#hist-device').addEventListener('change', function () {
      histState.device = $('#hist-device').value;
      histState.series = null;
      loadSeriesList();
    });
    $('#hist-series').addEventListener('change', function () {
      histState.series = $('#hist-series').value;
      loadHistory();
    });
    $('#hist-reload').addEventListener('click', loadHistory);
  }

  function loadSeriesList() {
    if (!histState.device) return;
    NQ.history.series(histState.device).then(function (r) {
      var sel = clear($('#hist-series'));
      (r.series || []).forEach(function (s) {
        sel.appendChild(h('option', { value: s.series,
          text: s.series + '  (' + s.count + ')' }));
      });
      if (!r.series || !r.series.length) {
        sel.appendChild(h('option', { value: '', text: 'nothing stored yet' }));
        histState.series = null;
        return;
      }
      if (!histState.series) histState.series = r.series[0].series;
      sel.value = histState.series;
      loadHistory();
    }).catch(function (e) {
      clear($('#hist-meta')).appendChild(U.banner('bad', String(e.message || e)));
    });
  }

  var histInit = false;

  function history() {
    var unavail = clear($('#hist-unavailable'));
    if (!NQ.history.available()) {
      $('#hist-body').style.display = 'none';
      unavail.appendChild(U.banner('info',
        'Long-term history needs the Home Assistant add-on, which is the thing ' +
        'that has somewhere to keep it. Opened from disk or a plain web server, ' +
        'this page only knows what it has seen since it connected — that is what ' +
        'the sparklines on each device are.'));
      return;
    }
    $('#hist-body').style.display = '';
    wireHistory();
    if (histInit) return;
    histInit = true;

    NQ.history.devices().then(function (r) {
      var sel = clear($('#hist-device'));
      (r.devices || []).forEach(function (d) {
        sel.appendChild(h('option', { value: d, text: NQ.store.label(d) }));
      });
      if (!r.devices || !r.devices.length) {
        clear($('#hist-meta')).appendChild(h('div', { class: 'note',
          text: 'The recorder has not stored anything yet. It keeps one sample a ' +
                'minute, so give it a minute.' }));
        return;
      }
      histState.device = r.devices[0];
      sel.value = histState.device;
      loadSeriesList();
    }).catch(function (e) {
      unavail.appendChild(U.banner('bad', String(e.message || e)));
    });
  }

  NQ.views = { devices: devices, soak: soak, gateway: gateway,
               otaTargets: otaTargets, wireOta: wireOta, history: history };
})(window.NQ = window.NQ || {});
