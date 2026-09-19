/* store.js — settings, per-device names, and the origin rule.
 *
 * Everything here is per-browser. Broker credentials are kept in
 * localStorage because that is the spec, and the page says out loud next to
 * the field that localStorage is not a secret store: anything that can run
 * script on this origin can read it. For a LAN broker that also accepts
 * anonymous clients that is the right trade. It would not be for anything
 * reachable from outside.
 *
 * Device names also live here. They have nowhere else to go until a node
 * carries its own `name` config field (plan §4); the key shape is chosen to
 * match that eventual field, so migrating is a publish loop rather than a
 * rewrite. */

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
    names:  {},            /* id -> friendly name */
    hideHa: true,          /* the house's values are not this page's business */
    path:   { p1m: -40, n: 2.7, show: false },
    feedCap: 3000
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var state = clone(DEFAULTS);

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (!raw) return state;
    try {
      var got = JSON.parse(raw);
      Object.keys(DEFAULTS).forEach(function (k) {
        if (got[k] === undefined) return;
        if (k === 'path' || k === 'names') {
          state[k] = Object.assign(clone(DEFAULTS[k]), got[k]);
        } else {
          state[k] = got[k];
        }
      });
    } catch (e) { /* corrupt: keep defaults rather than refuse to start */ }
    return state;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
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
    name: function (id) { return state.names[id] || ''; },
    setName: function (id, name) {
      if (name) { state.names[id] = name; } else { delete state.names[id]; }
      save();
    },
    label: function (id) { return state.names[id] || id; }
  };
})(window.NQ = window.NQ || {});
