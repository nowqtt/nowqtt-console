# nowqtt console

The technical management interface for a nowqtt ESP-NOW mesh, served from
inside Home Assistant as a sidebar tab: mesh topology drawn from measured
RSSI, every counter the firmware publishes, per-device configuration, and
firmware updates from a file dialog.

It deliberately leaves out the values Home Assistant already owns —
temperature, humidity — because those belong on a dashboard. This page is
about the network.

## Why an add-on

A page served from an `https://` origin may not open a plain `ws://` socket,
and the broker's WebSocket listener is plaintext. Hosting the console publicly
therefore meant either putting TLS on the broker or setting a per-browser
insecure-content exception. Serving it from inside Home Assistant removes the
question rather than answering it: **the add-on proxies the MQTT socket
itself**, so the page and its socket are the same origin, whatever that origin
is.

Three things follow that a static host could not do:

- **Credentials are never in the browser.** The add-on reads the broker's
  username and password from the Supervisor (or its own options) and rewrites
  the MQTT `CONNECT` packet as it passes through. The page connects
  anonymously; the broker sees a real login. Nothing lands in `localStorage`.
- **Nothing is exposed.** There is no published port. The only way in is
  through Home Assistant's own authentication.
- **There is somewhere to keep history.** `/data` is a persistent volume, so
  the add-on records the fleet long-term instead of a browser tab being the
  only witness.

## Options

| option | default | what it does |
| --- | --- | --- |
| `topic_prefix` | `nowqtt` | the root the gateway publishes under |
| `broker_host` | *(empty)* | set this for a broker that is **not** the Mosquitto add-on; leaving it empty asks the Supervisor |
| `broker_port` | `1883` | plain MQTT, not the WebSocket port — the add-on speaks TCP to the broker |
| `broker_user` / `broker_password` | *(empty)* | only needed with `broker_host` |
| `record_raw` | `true` | keep every message, for soak scoring |
| `raw_days` | `10` | how many daily raw files to keep |
| `series_every` | `60` | seconds between kept samples of a numeric series |
| `series_days` | `30` | how long to keep them |

**Where the broker comes from**, in order: `broker_host` if set, then the
Supervisor's MQTT service (i.e. the Mosquitto add-on), then nothing — and the
log says which, because a console silently pointing at the wrong broker looks
like a dead mesh rather than a missing setting.

TLS to the broker is not supported. The proxy opens a plain TCP socket, and
pointing it at a TLS listener fails in a way that reads like an unreachable
broker, so the log says so outright instead.

## What it stores, and how much

Two stores, because they answer different questions:

- **`/data/raw/soak-<date>.jsonl`** — every message, one JSON line each, nothing
  computed. The soak scorer needs every report to find gaps in each device's
  own counter. Measured at about **86 MB a day** on a ten-device fleet, so it
  rotates daily and keeps `raw_days`. Turn it off with `record_raw: false` if
  you are not scoring a soak.
- **`/data/series.db`** — a curated set of numeric series at one sample a
  minute, for the charts. Ten devices × about twenty series × 1440 samples is
  roughly **10 MB a day**; thirty days is some 300 MB.

Both numbers are in this table rather than discovered later, because they are
what the defaults were chosen from.

## Firmware updates

The OTA tab drives the same protocol as `docs/tools/mqtt-ota.py`: one chunk in
flight, each waiting for its own ack, a `nack` rewinding to the sequence the
device asks for, and a blind mode for a sleeping battery leaf whose first
replies cannot reach anybody.

The file dialog reads the image and tells you what it is — project, version,
chip, build date, IDF version — but it is **not** the guard. The guard is in
the device: both receivers refuse an image built for another chip on the first
chunk, so every sender gets that protection and not just this page.
