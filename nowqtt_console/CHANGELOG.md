# Changelog

## 0.1.1

- Fixes the install on current Home Assistant: the build failed with
  `pip: not found`, because the Supervisor now passes its own Python-less base
  image regardless of `build.yaml`. The Dockerfile pins `python:3.12-alpine`.
- Docker's init runs as PID 1, since that image brings none of its own.

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
