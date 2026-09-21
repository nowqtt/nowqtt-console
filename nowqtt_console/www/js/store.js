/* store.js — settings, per-device settings, and the origin rule.
 *
 * The page's own settings are per-browser. Broker credentials are kept in
 * localStorage because that is the spec, and the page says out loud next to
 * the field that localStorage is not a secret store: anything that can run
 * script on this origin can read it. For a LAN broker that also accepts
 * anonymous clients that is the right trade. It would not be for anything
 * reachable from outside.
 *
 * What people set about a device (its name and antenna offset) does NOT
 * live here: the add-on keeps it, so every browser sees the same fleet. See
 * loadSettings below. */

(function (NQ) {
  'use strict';

  var KEY = 'nowqtt.console.v2';

  /* A secure page may not open an insecure socket. This is the whole reason
   * v1 is a file you open, and the reason v2 can be hosted: see
   * docs/console-v2-plan.md §1. */
  var secureOrigin = (typeof location !== 'undefined' && location.protocol === 'https:');
  /* The broker is guessed to live on the machine serving the page, which is
   * right for the add-on's standalone use and never names anybody's network.
   * A browser that has connected before keeps what it saved. */
  var pageHost = (typeof location !== 'undefined' && location.hostname) || 'localhost';

  var DEFAULTS = {
    /* The default has to match the origin, or the first connect attempt fails
     * in a way that looks like a broker fault. */
    url:    secureOrigin ? 'wss://' + pageHost + ':9002' : 'ws://' + pageHost + ':9001',
    prefix: 'nowqtt',
    uid:    '',            /* blank discovers every gateway under the prefix */
    user:   '',
    pass:   '',
    autoconnect: true,
    hideHa: true,          /* the house's values are not this page's business */
    path:   { p1m: -40, n: 2.7, show: false },
    feedCap: 3000
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var state = clone(DEFAULTS);

  /* Names typed into this browser before the add-on kept them. Read once so
   * they can be handed to the add-on (migrateNames), never written back. */
  var legacyNames = null;

  /* Names the devices declare for themselves, keyed by id. Deliberately
   * outside `state`: state is persisted, and these arrive retained on every
   * connect, so storing them would only preserve a name a device has since
   * stopped using. */
  var declared = {};

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (!raw) return state;
    try {
      var got = JSON.parse(raw);
      Object.keys(DEFAULTS).forEach(function (k) {
        if (got[k] === undefined) return;
        if (k === 'path') {
          state[k] = Object.assign(clone(DEFAULTS[k]), got[k]);
        } else {
          state[k] = got[k];
        }
      });
      if (got.names && typeof got.names === 'object' && Object.keys(got.names).length) {
        legacyNames = got.names;
      }
    } catch (e) { /* corrupt: keep defaults rather than refuse to start */ }
    return state;
  }

  function save() {
    /* Old names ride along until migrateNames has handed them over, so that
     * saving anything else in the meantime does not lose them. */
    var out = legacyNames ? Object.assign({ names: legacyNames }, state) : state;
    try { localStorage.setItem(KEY, JSON.stringify(out)); } catch (e) { /* ignore */ }
  }

  /* A `ws://` URL on an https page is blocked mixed content. That is NOT
   * refused here, by the operator's decision: they allow it per-site in the
   * browser (Chrome: Site settings -> Insecure content -> Allow; Firefox:
   * security.mixed_content.block_active_content = false).
   *
   * It is still warned about, because when the exception is not in place the
   * failure does not look like what it is. The socket is blocked before it is
   * attempted, so it presents as "the broker never answered" -- which sends
   * you to the broker, then the firewall, then the ACLs, in that order. The
   * warning is the difference between a five-second fix and that hunt.
   *
   * The exception is also per-browser and per-profile, so a phone or a fresh
   * profile will need it again; docs/console-v2-plan.md §1 keeps the wss
   * listener as the durable alternative. */
  function checkUrl(url) {
    url = String(url || '').trim();
    if (!/^wss?:\/\//.test(url)) {
      return { ok: false, why: 'A broker URL starts with ws:// or wss://.' };
    }
    if (secureOrigin && url.slice(0, 6) !== 'wss://') {
      return {
        ok: true,
        warn: 'Plain ws:// from an https page is mixed content. It works only ' +
              'with a per-site insecure-content exception in this browser; ' +
              'without one the browser blocks the socket silently and this ' +
              'looks exactly like an unreachable broker.'
      };
    }
    return { ok: true };
  }

  /* Set when the page is being served by the Home Assistant add-on, from what
   * api/config reports. In that mode the broker is not the user's business:
   * the add-on proxies the socket on this same origin and injects the real
   * credentials into the MQTT CONNECT, so the page connects anonymously to a
   * relative path and never holds a password at all. */
  var managed = null;

  function adopt(apiConfig) {
    if (!apiConfig || apiConfig.mode !== 'addon') return false;
    /* Relative to this document, because ingress serves the add-on under
     * /api/hassio_ingress/<token>/ and that token changes on every restart.
     * An absolute path would leave the ingress prefix and hit Home Assistant
     * itself. */
    var href = new URL(apiConfig.ws_path || 'mqtt', location.href).href;
    state.url = href.replace(/^http/, 'ws');
    if (apiConfig.prefix) state.prefix = apiConfig.prefix;
    state.uid = '';
    state.user = '';
    state.pass = '';
    managed = apiConfig;
    /* Deliberately not saved: this is derived from where the page is served
     * from, and persisting an ingress URL whose token has rotated would be
     * worse than deriving it again. */
    return true;
  }

  /* What people set about a device -- its name and its antenna offset --
   * kept by the add-on (api/settings), so every browser and phone sees the
   * same thing. There is no copy in this browser: names used to live here
   * and were gone on a phone or after clearing site data, and an antenna
   * correction one browser applies and another does not would be two maps of
   * one mesh. Opened without the add-on there is nowhere to keep them, so
   * they are shown as absent and cannot be edited.
   *
   * antenna, in dB: how much stronger (+) or weaker (-) a device's antenna
   * and radio are than the fleet's usual board. The maps subtract both ends'
   * offsets from a link's RSSI before turning it into a distance. */
  var settings = {};
  var settingsLoaded = false;

  function loadSettings() {
    if (!managed) return Promise.resolve(false);
    return fetch('api/settings', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return false;
        settings = j.devices || {};
        settingsLoaded = true;
        return migrateNames().then(function () { return true; });
      })
      .catch(function () { return false; });
  }

  function update(id, patch) {
    if (!settingsLoaded) {
      return Promise.reject(new Error('device settings are kept by the add-on, ' +
                                      'and this page is not served by it'));
    }
    patch.id = id;
    return fetch('api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || ('HTTP ' + r.status)); });
      return r.json();
    }).then(function (j) { settings = j.devices || {}; });
  }

  /* Names typed into this browser under the old scheme go to the add-on once,
   * unless it already has a name for that device, and are then dropped from
   * local storage so they cannot come back over a name changed elsewhere. */
  function migrateNames() {
    if (!legacyNames) return Promise.resolve();
    var todo = Object.keys(legacyNames).filter(function (id) {
      return legacyNames[id] && !(settings[id] && settings[id].name);
    });
    return todo.reduce(function (p, id) {
      return p.then(function () { return update(id, { name: String(legacyNames[id]) }); })
              .catch(function () { /* one bad name does not stop the rest */ });
    }, Promise.resolve()).then(function () {
      legacyNames = null;
      save();                 /* state has no names, so this removes them */
    });
  }

  /* Each link's median RSSI over its recent reports, from the add-on
   * (server/links.py): measurer -> peer -> {rssi, n, last}. */
  var links = null;

  function loadLinks() {
    if (!managed) return Promise.resolve(false);
    return fetch('api/links', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.links) { links = j; return true; } return false; })
      .catch(function () { return false; });
  }

  function setAntenna(id, db) {
    db = Number(db);
    if (!isFinite(db) || Math.abs(db) > 30) return Promise.reject(new Error('between −30 and +30 dB'));
    return update(id, { antenna: Math.round(db * 10) / 10 || null });
  }

  NQ.store = {
    secureOrigin: secureOrigin,
    adopt: adopt,
    managed: function () { return managed; },
    defaults: DEFAULTS,
    get: function () { return state; },
    load: load,
    save: save,
    checkUrl: checkUrl,
    set: function (patch) { Object.assign(state, patch); save(); },
    /* the name set in the console, '' if none */
    name: function (id) { return (settings[id] && settings[id].name) || ''; },
    setName: function (id, name) { return update(id, { name: name || null }); },
    /* The name the firmware declares for itself, relayed by the gateway on
     * `t/name`. Not persisted and not saved: it arrives with the retained
     * topics on every connect, and writing it to local storage would leave a
     * stale copy of a name the device has since changed. */
    declared: function (id) { return declared[id] || ''; },
    setDeclared: function (id, name) {
      if (name) { declared[id] = name; } else { delete declared[id]; }
    },
    /* A name set here wins: somebody looking at this fleet decided what to
     * call the device. The firmware's name is what makes a browser that has
     * never seen this fleet show something other than a wall of addresses. */
    label: function (id) {
      return (settings[id] && settings[id].name) || declared[id] || id;
    },
    /* the same, with '' rather than the id when nothing names it */
    shownName: function (id) {
      return (settings[id] && settings[id].name) || declared[id] || '';
    },
    /* the manual antenna value, 0 if none; see antenna.js for what applies */
    antenna: function (id) { return (settings[id] && settings[id].antenna) || 0; },
    setAntenna: setAntenna,
    board: function (id) { return (settings[id] && settings[id].board) || ''; },
    setBoard: function (id, b) { return update(id, { board: b || null }); },
    boards: function () {
      var out = {};
      Object.keys(settings).forEach(function (id) { if (settings[id].board) out[settings[id].board] = true; });
      return Object.keys(out).sort();
    },
    linkAvg: function (measurer, peer) {
      var m = links && links.links[measurer];
      return (m && m[peer]) || null;
    },
    linksWindow: function () { return links ? links.window : 0; },
    loadLinks: loadLinks,
    editable: function () { return settingsLoaded; },
    loadSettings: loadSettings
  };
})(window.NQ = window.NQ || {});
