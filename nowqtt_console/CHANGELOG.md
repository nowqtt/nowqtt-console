# Changelog

## 0.6.2

- **Offline devices are marked, and left off the map.** The console now reads
  the gateway's availability (`dev/<mac>/status`): a device the gateway has
  given up on is listed last, dimmed and labelled *offline*, and the 2D and
  3D maps no longer draw it or any link to it. It comes back the moment it
  sends a frame.
- **Retained messages no longer count as a device being seen.** An unplugged
  device's name, config and topology stay on the broker and arrive on every
  page load, which made it look alive with "seen now". *Seen* is now the last
  frame the device actually sent.
- The device count in the tab only counts devices that are online.

## 0.6.1

- **Ping button in the bottom-right corner** of both maps, with the result
  right above it, so on a phone the tool panel can stay folded. It only
  appears when a node is selected.
- **No more ghost `0000…0000` device.** A sleeper the gateway hears itself
  now hangs off the gateway. A sleeper that nobody claims gets no edge.
- **Shorter map panels.** The explanations are gone; the numbers stay.

## 0.6.0

- **Ping a node from the map.** Select a node on the 2D or 3D map and press
  **Ping**. The gateway sends it one confirmed frame. The map then replays the
  trip slowly, out in one colour and back in another, along the neighbours
  the frame really went through, which are not always the same both ways.
  The panel gives the round trip, the tries and the RSSI of the last hop.
  The gateway only sees its own neighbour on each side, so a relay-to-node
  hop is drawn dotted and called assumed. Needs gateway firmware with
  `bridge/ping`; sleepers cannot be pinged.

## 0.5.2

- **Hide a kind of link on the maps.** Click a row in the map legend to hide
  or show those links, on the 2D and 3D maps together. Only the drawing
  changes: hidden links still place the devices, so nothing moves. The
  legend also gains the −60 … −72 dBm row it was missing.

## 0.5.1

- **A board estimate is applied only if it survives leaving any one device
  out.** Checked against the live fleet, the 0.5.0 estimates had the right
  directions (gateway −14, C3 −4, Wallbox +9 dB), but each moved by 10–20 dB
  when a single neighbour was left out of the fit. The ± shown until now came
  from resampling links, and it reported ±2–5 dB for all of that. The gate and
  the ± are now that leave-one-device-out test. On today's mesh no board
  passes it, and the reason is shown. Use the per-device override for an
  antenna you know.

## 0.5.0

- **Antenna corrections for the maps.** Give a device a **board** under
  Devices (for example `c3-supermini`). The console estimates one antenna
  offset per board from all the links its devices have, and both maps
  subtract it before turning RSSI into distance. A weak-antenna board then no
  longer sits further away than it is. Devices with no board are the 0 dB
  reference. The dBm on a link stays what was measured. The estimate is used
  only when there is enough evidence, and tends to fall a little short of the
  real offset, never past it. A per-device **override** replaces it with a
  value you know better.
- **Averaged link RSSI.** A topology report carries the RSSI of a single
  frame. The add-on now keeps each link's median over its last 30 reports, per
  measuring end, across restarts, and the maps use it.
- **Names, boards and overrides are kept by the add-on**, in
  `/data/devices.json`, so every browser and phone shows the same fleet.
  Nothing about a device is kept in the browser any more. Names typed into a
  browser earlier are handed to the add-on the first time that browser opens
  this version, then removed from it.
- Typing into a device's fields is no longer interrupted by the page
  refreshing underneath.

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
