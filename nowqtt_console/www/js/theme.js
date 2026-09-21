/* theme.js — look like the Home Assistant around the page.
 *
 * Under the add-on the console is an ingress panel: an iframe served from
 * Home Assistant's own origin. Same origin means the frame may read its
 * parent's computed style, so rather than a copy of Home Assistant's palette
 * that goes stale the moment someone picks a custom theme or switches to light
 * mode, this reads the live values and follows them when they change.
 *
 * Opened any other way (from disk, a plain web server, a parent on another
 * origin) there is nothing to read, and the stylesheet's defaults apply: Home
 * Assistant's default dark theme, or its light one if the system prefers it.
 *
 * Loaded in <head>, before the body exists, so the first paint is already in
 * the right colours. */

(function (NQ) {
  'use strict';

  /* ours <- Home Assistant's, first one that is set wins */
  var MAP = {
    '--ha-bg':         ['--primary-background-color'],
    '--ha-card':       ['--card-background-color', '--ha-card-background'],
    '--ha-bg-2':       ['--secondary-background-color'],
    '--ha-bar':        ['--sidebar-background-color', '--card-background-color'],
    '--ha-fg':         ['--primary-text-color'],
    '--ha-fg-2':       ['--secondary-text-color'],
    '--ha-line':       ['--divider-color'],
    '--ha-primary':    ['--primary-color'],
    '--ha-on-primary': ['--text-primary-color'],
    '--ha-success':    ['--success-color'],
    '--ha-warning':    ['--warning-color'],
    '--ha-error':      ['--error-color'],
    '--ha-header-h':   ['--header-height']
  };

  function parentDoc() {
    try {
      if (!window.parent || window.parent === window) return null;
      var d = window.parent.document;           /* throws cross-origin */
      return d && d.documentElement ? d : null;
    } catch (e) { return null; }
  }

  /* Relative luminance of a computed colour, enough to tell dark from light
   * so native controls (scrollbars, date pickers) match. */
  function isDark(color) {
    var m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(color || '');
    if (!m) return true;
    return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 < 0.5;
  }

  var fontsCopied = false;

  /* The font is declared in Home Assistant's document, and @font-face does not
   * cross into a frame. Copying the rules (with their URLs made absolute, as
   * they were relative to a stylesheet that is not ours) lets the frame load
   * the same files from the same origin -- cached already, since the parent
   * loaded them. */
  function copyFonts(pd) {
    if (fontsCopied) return;
    fontsCopied = true;
    var out = [];
    try {
      Array.prototype.forEach.call(pd.styleSheets, function (sh) {
        var rules;
        try { rules = sh.cssRules; } catch (e) { return; }
        var base = sh.href || pd.baseURI;
        Array.prototype.forEach.call(rules || [], function (r) {
          if (r.type !== 5) return;                  /* CSSRule.FONT_FACE_RULE */
          out.push(r.cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, function (all, q, u) {
            try { return 'url("' + new URL(u, base).href + '")'; } catch (e) { return all; }
          }));
        });
      });
    } catch (e) { /* no fonts is fine; the fallback stack is close */ }
    if (!out.length) return;
    var st = document.createElement('style');
    st.textContent = out.join('\n');
    document.head.appendChild(st);
  }

  function apply() {
    var pd = parentDoc();
    if (!pd) return false;
    var root = document.documentElement;
    var cs, bodyCs;
    try {
      cs = window.parent.getComputedStyle(pd.documentElement);
      bodyCs = pd.body ? window.parent.getComputedStyle(pd.body) : null;
    } catch (e) { return false; }

    var any = false;
    Object.keys(MAP).forEach(function (ours) {
      for (var i = 0; i < MAP[ours].length; i++) {
        var v = cs.getPropertyValue(MAP[ours][i]).trim();
        if (v) { root.style.setProperty(ours, v); any = true; return; }
      }
      root.style.removeProperty(ours);
    });
    if (!any) return false;                       /* a parent, but not HA */

    if (bodyCs && bodyCs.fontFamily) {
      root.style.setProperty('--ha-font', bodyCs.fontFamily + ', system-ui, sans-serif');
      copyFonts(pd);
    }

    /* The probe resolves whatever form the theme wrote its colour in (a
     * name, hsl(), a var() chain) to rgb() for the luminance test. */
    var probe = document.createElement('i');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--ha-bg)';
    (document.body || root).appendChild(probe);
    var bg = getComputedStyle(probe).color;
    probe.remove();
    var dark = isDark(bg);
    root.setAttribute('data-ha-theme', dark ? 'dark' : 'light');
    root.style.setProperty('color-scheme', dark ? 'dark' : 'light');
    root.style.setProperty('--shadow', dark ? '0 6px 24px rgba(0,0,0,.35)'
                                            : '0 4px 16px rgba(0,0,0,.12)');
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', bg);

    if (NQ.theme) NQ.theme.changed();
    return true;
  }

  var listeners = [];

  function watch() {
    var pd = parentDoc();
    if (!pd || typeof MutationObserver === 'undefined') return;
    /* Home Assistant writes a theme change, dark mode included, as inline
     * custom properties on its <html>; a class or attribute flip covers the
     * rest. Coalesced to one apply per frame. */
    var pending = false;
    var mo = new window.parent.MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; apply(); });
    });
    mo.observe(pd.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'dark'] });
    try {
      window.parent.matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', function () { apply(); });
    } catch (e) { /* older engines */ }
  }

  NQ.theme = {
    /* modules that paint on a canvas cannot use var(); they ask here */
    onChange: function (fn) { listeners.push(fn); },
    changed: function () { listeners.forEach(function (fn) { try { fn(); } catch (e) { } }); },
    apply: apply
  };

  if (typeof document !== 'undefined' && document.documentElement &&
      document.documentElement.style && document.documentElement.style.setProperty) {
    apply();
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('DOMContentLoaded', function () { apply(); watch(); });
    }
  }
  if (typeof window.matchMedia === 'function') {
    try {
      window.matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', function () { NQ.theme.changed(); });
    } catch (e) { /* older engines */ }
  }
})(window.NQ = window.NQ || {});
