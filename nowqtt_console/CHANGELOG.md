# Changelog

## 0.1.0

First release. The console v2 packaged as an add-on.

- Served through ingress as a sidebar tab; no published port.
- MQTT over WebSocket proxied on the add-on's own origin, which is what makes
  a hosted console possible at all without TLS on the broker.
- Broker credentials taken from the Supervisor's MQTT service or the add-on
  options and injected into the MQTT `CONNECT`, so the page never holds them.
- Long-term recording into `/data`: raw messages for soak scoring, rotated
  daily, and a SQLite series store for the charts.
- Mesh map drawn only from links something actually reported, with unmeasured
  paths marked rather than invented.
- Firmware update from a file dialog, including blind mode for a sleeping leaf.
- Per-device configuration editor over the same `dzg_config` documents the
  gateway and the nodes publish.
