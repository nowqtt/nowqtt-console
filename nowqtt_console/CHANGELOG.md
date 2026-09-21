# Changelog

## 0.4.0

- **A 3D map.** A new tab places every device in three dimensions so that the
  distance between the two ends of each measured link follows its RSSI, on
  the same scale the 2D map uses. A house is not flat, and a plane cannot hold
  every distance at once. The panel says how closely the measured links are
  reproduced. Drag to rotate, right-drag or shift-drag to pan, and use the
  wheel to zoom. On a touchscreen, one finger rotates, two pan and pinch, and
  a double tap resets the view.
- **Looks like Home Assistant.** The console reads the theme of the Home
  Assistant it is embedded in (colours, font, light or dark mode, custom
  themes) and follows it when it changes. The header is the same height as
  Home Assistant's sidebar title, so the two line up.
- **Works on a phone.** The header folds into two rows with scrolling tabs.
  Two-column pages become one column. The device list and a device's detail
  take turns, with a back button. The map's panels start folded, and the 2D
  map pinches and pans with two fingers.

## 0.3.1

- **A device arrives with a name.** The gateway now republishes each device's
  declared name on `dev/<mac>/name`, and the console uses it as the label and
  as the placeholder in the name field. Until now a fresh browser showed a
  wall of MAC addresses: names were typed in and kept in that one browser's
  local storage, so they were gone on a phone or after clearing site data. A
  name typed here still wins — it is the more specific statement. Needs
  gateway firmware `8864cbe` or later.

## 0.3.0

- **Keeps a backup of the mesh's network record.** Since the first key
  rotation the mesh key exists only in the devices; a gateway that loses its
  flash comes back on the factory key and no node listens to it. Whenever the
  gateway settles on a new epoch, the add-on asks it for a copy and keeps it
  in `/data/netcfg` (readable by the add-on only). The Network tab shows
  whether the copy is current, downloads it, and restores it to a gateway
  that is back on the factory record. Needs gateway firmware `fd51820` or later.
- The raw recording no longer stores the backup, which carries the key. The
  console never shows the key in its live feed or messages.

## 0.2.0

- New **Network** tab for the mesh-wide settings: move the whole mesh to
  another Wi-Fi channel, rotate the mesh key, and open a join window for
  devices flashed with the factory key. It shows the change as the gateway
  runs it (who acknowledged, who did not, done/aborted/reverted), and which
  channel and key epoch every device reports it is on, so a device that
  missed a change shows up as one. Needs a gateway that publishes
  `bridge/netcfg`.

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
