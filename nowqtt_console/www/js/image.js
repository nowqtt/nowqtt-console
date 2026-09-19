/* image.js — read an ESP application image before putting it on the air.
 *
 * No DOM, no network: bytes in, facts out. Tested against the real .bin files
 * in the build trees (test/image-test.js).
 *
 * Why this exists. Before spending ~750 KB of airtime on a radio whose whole
 * design is about not spending any, it is worth knowing what is in the file:
 * which project, which version, which chip, built when, against which IDF.
 * The file dialog is where a person can still change their mind.
 *
 * This is a READING, not a guard. The guard is in the device -- aodv_ota.c and
 * mqtt_ota.c refuse a foreign chip id on the first chunk -- because a check in
 * a sending tool only protects whoever uses that tool.
 *
 * Layout (esp_image_format.h, esp_app_format.h):
 *   0        esp_image_header_t, 24 bytes
 *     +0     magic 0xE9
 *     +1     segment_count
 *     +12    chip_id, uint16 LE
 *     +23    hash_appended
 *   24       first segment header, 8 bytes (load_addr, data_len)
 *   32=0x20  esp_app_desc_t, magic 0xABCD5432
 *
 * The descriptor sitting at 0x20 is what proves segments start at 24 rather
 * than 40 -- an earlier walk of this layout in this project used 24+16, read
 * "9ddd" out of the middle of a version string, and reported it as a load
 * address. */

(function (NQ) {
  'use strict';

  var CHIPS = {
    0x0000: 'ESP32',    0x0002: 'ESP32-S2', 0x0005: 'ESP32-C3',
    0x0009: 'ESP32-S3', 0x000c: 'ESP32-C2', 0x000d: 'ESP32-C6',
    0x0010: 'ESP32-H2', 0x0012: 'ESP32-P4', 0x0017: 'ESP32-C5'
  };

  var IMG_MAGIC  = 0xe9;
  var DESC_OFF   = 0x20;
  var DESC_MAGIC = 0xabcd5432;

  function cstr(bytes, off, len) {
    var end = off + len, s = '';
    for (var i = off; i < end && i < bytes.length; i++) {
      if (bytes[i] === 0) break;
      s += String.fromCharCode(bytes[i]);
    }
    return s.replace(/[^\x20-\x7e]/g, '');
  }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  /**
   * @param {Uint8Array} bytes  the whole image
   * @returns {object} { ok, why, size, chipId, chip, segments, entry,
   *                     hashAppended, desc: {project, version, date, time,
   *                     idf, secure} }
   */
  function parse(bytes) {
    var r = { ok: false, why: '', size: bytes ? bytes.length : 0, desc: null };
    if (!bytes || bytes.length < DESC_OFF + 176) {
      r.why = 'too short to be an application image (' + r.size + ' bytes)';
      return r;
    }
    if (bytes[0] !== IMG_MAGIC) {
      r.why = 'not an ESP image: first byte is 0x' +
              bytes[0].toString(16) + ', expected 0xe9';
      return r;
    }

    r.segments     = bytes[1];
    r.entry        = u32(bytes, 4);
    r.chipId       = u16(bytes, 12);
    r.chip         = CHIPS[r.chipId] || ('unknown chip id 0x' + r.chipId.toString(16));
    r.chipKnown    = CHIPS[r.chipId] !== undefined;
    r.hashAppended = bytes[23] === 1;
    r.minRev       = u16(bytes, 15);

    /* An image whose first segment does not carry the descriptor is a
     * bootloader or a raw binary, not an OTA-able app. Saying which is more
     * useful than "invalid". */
    if (u32(bytes, DESC_OFF) !== DESC_MAGIC) {
      r.why = 'no esp_app_desc at 0x20 (magic 0x' +
              u32(bytes, DESC_OFF).toString(16) +
              ') -- this looks like a bootloader or a raw binary, not an app image';
      return r;
    }

    r.desc = {
      secure:  u32(bytes, DESC_OFF + 4),
      version: cstr(bytes, DESC_OFF + 16, 32),
      project: cstr(bytes, DESC_OFF + 48, 32),
      time:    cstr(bytes, DESC_OFF + 80, 16),
      date:    cstr(bytes, DESC_OFF + 96, 16),
      idf:     cstr(bytes, DESC_OFF + 112, 32)
    };
    r.ok = true;
    return r;
  }

  /* NOT the guard -- the device is.
   *
   * The authoritative check lives in the receiving firmware: the first chunk
   * carries the image header, and both receivers (aodv_ota.c for the mesh,
   * mqtt_ota.c for the gateway's own path) refuse a foreign chip id on chunk
   * zero with ESP_ERR_OTA_VALIDATE_FAILED. A check in a sending tool only
   * protects whoever happens to use that tool; a check in the device protects
   * the device, from this page and from anything anyone writes later.
   *
   * So what this function does is *describe* what is about to be sent, and
   * flag what is worth a second look before the airtime is spent. It refuses
   * nothing that the device would accept, and claims no authority it has. */
  function describe(img, target) {
    var out = { fatal: [], warn: [], info: [] };
    if (!img.ok) { out.fatal.push(img.why); return out; }

    out.info.push(img.desc.project + ' ' + img.desc.version + ' for ' + img.chip +
                  ', built ' + img.desc.date + ' with IDF ' + img.desc.idf);

    if (!img.chipKnown) {
      out.warn.push('chip id 0x' + img.chipId.toString(16) +
                    ' is not one this page knows; the device will still check it');
    }
    if (target && target.build && img.desc.version &&
        target.build === img.desc.version) {
      out.warn.push('the target already reports build ' + target.build +
                    ' -- this image is the one it is already running');
    }
    if (!img.hashAppended) {
      out.warn.push('no SHA-256 appended: esp_ota_end() cannot verify this image');
    }
    if (img.size > 1536 * 1024) {
      out.warn.push('image is ' + (img.size / 1024).toFixed(0) +
                    ' KB, larger than the 1.5 MB OTA slots this fleet uses');
    }
    return out;
  }

  NQ.image = { parse: parse, describe: describe, CHIPS: CHIPS };
})(typeof window !== 'undefined' ? (window.NQ = window.NQ || {})
                                 : (globalThis.NQ = globalThis.NQ || {}));
