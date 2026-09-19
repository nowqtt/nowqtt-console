/* config.js — edit a device's dzg_config document.
 *
 * The engine is reflection-based (components/dzg-utils/config/dzg_config.h):
 * sections of plain structs, an active copy and a staged copy, apply() commits
 * and persists to NVS and fires change callbacks for fields that actually
 * changed. It publishes the whole document retained and accepts a PARTIAL one
 * to merge. So this editor is generic over the document rather than knowing
 * any field: whatever a device describes about itself is what gets rendered.
 *
 *   gateway   device/config/current   <-  retained echo
 *             device/config/apply      -> partial document
 *   node      dev/<mac>/t/config      <-  retained echo, over the mesh
 *             dev/<mac>/set/config     -> partial document
 *
 * Two rules that are not cosmetic:
 *
 * - A field is only sent if it CHANGED. The engine merges partials, so
 *   sending the whole document would fire change callbacks for fields nobody
 *   touched, and on a node it would spend a frame it did not need to.
 *
 * - A secret reads back as "********" and is left exactly so unless typed
 *   over. dzg_config_merge_json() ignores a secret whose incoming value is
 *   that mask, which is what lets a redacted document be edited and posted
 *   back without clobbering the stored password. Any other value, including
 *   an empty one, sets it.
 *
 * One limit, stated rather than papered over: an UNSET secret is emitted as
 * an empty string, not as the mask -- deliberately, so a reader can tell "no
 * password" from "there is one". From here that is indistinguishable from an
 * ordinary empty string, so a never-set secret is shown as a plain field. It
 * is not worth guessing from the field's name: this editor is generic over
 * whatever a device describes, and a name heuristic would eventually mask the
 * wrong thing. */

(function (NQ) {
  'use strict';

  var MASK = '********';

  function typeOf(v) {
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
    return 'str';
  }

  /* Flat list of editable leaves: section -> key -> value. Nested objects
   * beyond one level do not occur in this engine's documents; if one appears,
   * it is shown read-only rather than silently dropped. */
  function fields(doc) {
    var out = [];
    Object.keys(doc || {}).forEach(function (sec) {
      var body = doc[sec];
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        out.push({ section: '', key: sec, value: body, type: typeOf(body),
                   secret: body === MASK, path: sec });
        return;
      }
      Object.keys(body).forEach(function (k) {
        var v = body[k];
        if (v !== null && typeof v === 'object') {
          out.push({ section: sec, key: k, value: JSON.stringify(v),
                     type: 'nested', readonly: true, path: sec + '.' + k });
          return;
        }
        out.push({ section: sec, key: k, value: v, type: typeOf(v),
                   secret: v === MASK, path: sec + '.' + k });
      });
    });
    return out;
  }

  /* Build the partial document to publish. `edits` is path -> new raw value
   * (string from an input, or boolean from a checkbox). */
  function diff(doc, edits) {
    var patch = {};
    var count = 0;
    Object.keys(edits).forEach(function (path) {
      var parts = path.split('.');
      var sec = parts.length > 1 ? parts[0] : '';
      var key = parts.length > 1 ? parts.slice(1).join('.') : parts[0];
      var cur = sec ? (doc[sec] || {})[key] : doc[key];
      var raw = edits[path];
      var val;

      if (typeof cur === 'boolean') {
        val = (raw === true || raw === 'true' || raw === 1 || raw === '1');
      } else if (typeof cur === 'number') {
        if (raw === '' || raw === null || !isFinite(Number(raw))) return;
        val = Number(raw);
      } else {
        val = String(raw);
        /* An untouched secret must not be sent as a literal change; the
         * engine would ignore it, but sending it says "I changed this" in the
         * log of a device that logs every applied field. */
        if (val === MASK && cur === MASK) return;
      }
      if (val === cur) return;

      if (sec) { patch[sec] = patch[sec] || {}; patch[sec][key] = val; }
      else { patch[key] = val; }
      count++;
    });
    return { patch: patch, count: count };
  }

  function topics(dev, prefix, uid) {
    if (dev.kind === 'gateway') {
      return { apply: prefix + '/' + uid + '/device/config/apply',
               echo:  prefix + '/' + uid + '/device/config/current',
               overMesh: false };
    }
    return { apply: prefix + '/' + uid + '/dev/' + dev.id + '/set/config',
             echo:  prefix + '/' + uid + '/dev/' + dev.id + '/t/config',
             overMesh: true };
  }

  /* A partial document on its way to a node has to fit one ESP-NOW v2 frame:
   * 1470 bytes less the 20-byte header and the 8-byte tag, minus the topic.
   * Failing loudly here beats a truncated publish that arrives as invalid
   * JSON and makes a working device look broken. */
  var MESH_LIMIT = 1470 - 20 - 8 - 64;

  function publish(dev, prefix, uid, patch, cb) {
    var t = topics(dev, prefix, uid);
    var body = JSON.stringify(patch);
    if (t.overMesh && body.length > MESH_LIMIT) {
      cb(new Error('that is ' + body.length + ' bytes and one mesh frame holds ' +
                   MESH_LIMIT + '; apply fewer fields at a time'));
      return;
    }
    NQ.broker.publish(t.apply, body, { qos: 0 }, function (err) { cb(err || null); });
  }

  NQ.config = {
    MASK: MASK,
    fields: fields,
    diff: diff,
    topics: topics,
    publish: publish,
    MESH_LIMIT: MESH_LIMIT,
    typeOf: typeOf
  };
})(typeof window !== 'undefined' ? (window.NQ = window.NQ || {})
                                 : (globalThis.NQ = globalThis.NQ || {}));
