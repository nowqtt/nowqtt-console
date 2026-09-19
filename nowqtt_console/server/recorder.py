"""Subscribe to the fleet and keep what it says.

Two stores with two different jobs, which is why there are two rather than one
doing both badly:

- `soak.jsonl`: every message, one JSON line each, computed on not at all. The
  soak scorer needs every report to find gaps in each device's own counter, and
  the recorder stays deliberately dumb so a bug in the scoring cannot cost a
  week of data -- that rule is older than this file and has already paid for
  itself. About 86 MB a day on this fleet, so it rotates daily and keeps
  `raw_days`.

- `series.db`: a curated set of numeric series at a sample a minute, kept for
  `series_days`. This is what the console's charts read. See store.py for why
  the list is short.

What is NOT subscribed: `ota/+/data` and `ota/rx`. Those carry the firmware
image itself, and recording them would put three quarters of a megabyte into
both stores every time anybody updates a device.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time

import paho.mqtt.client as mqtt

LOG = logging.getLogger("recorder")

# Kept in series.db. Deliberately short: every extra key is a row a minute per
# device forever. Everything else stays in the raw recording, which is where
# you look when a question is worth 86 MB a day.
SERIES_KEYS = {
    # mains node
    "mesh.seq", "mesh.gw_hops", "mesh.peers", "mesh.routes", "mesh.tx_fail",
    "mesh.ack_us", "mesh.ltx.0", "mesh.ltx.1", "mesh.ltx.2", "mesh.leaf_acks",
    "free_heap", "rssi", "uptime",
    # sleeper
    "report.wake", "report.batt", "report.prev.awake_ms", "report.prev.acked",
    "report.silent", "report.radio_ms", "report.sensor_ms",
    # gateway (bridge/stats is flattened without a prefix)
    "heap", "uptime_s", "peers", "leaves", "tx_fail", "rx", "tx", "fwd",
    "drop_topic", "best_rssi", "routes",
}


def flatten(value, prefix, out):
    """Same un-flattening the console does, so the keys match what it shows."""
    if isinstance(value, list):
        for i, v in enumerate(value):
            flatten(v, f"{prefix}.{i}", out)
    elif isinstance(value, dict):
        for k, v in value.items():
            flatten(v, f"{prefix}.{k}" if prefix else k, out)
    elif isinstance(value, bool):
        out[prefix] = 1.0 if value else 0.0
    elif isinstance(value, (int, float)):
        out[prefix] = float(value)
    return out


class RawLog:
    """One file a day, `keep_days` of them."""

    def __init__(self, directory: str, keep_days: int):
        self.dir = directory
        self.keep_days = max(1, int(keep_days))
        self.day = None
        self.fh = None
        os.makedirs(directory, exist_ok=True)

    def _rotate(self, now: float) -> None:
        day = time.strftime("%Y-%m-%d", time.localtime(now))
        if day == self.day and self.fh is not None:
            return
        if self.fh is not None:
            self.fh.close()
        self.day = day
        path = os.path.join(self.dir, f"soak-{day}.jsonl")
        self.fh = open(path, "a", buffering=1)
        LOG.info("raw recording -> %s", path)
        self._reap()

    def _reap(self) -> None:
        try:
            names = sorted(n for n in os.listdir(self.dir)
                           if n.startswith("soak-") and n.endswith(".jsonl"))
        except OSError:
            return
        for name in names[:-self.keep_days]:
            try:
                os.remove(os.path.join(self.dir, name))
                LOG.info("removed old recording %s", name)
            except OSError as exc:
                LOG.warning("cannot remove %s: %s", name, exc)

    def write(self, line: str, now: float) -> None:
        self._rotate(now)
        # Flushed per line: a recording that ends with a killed container must
        # not lose its tail, which is the part you were watching.
        self.fh.write(line + "\n")

    def close(self) -> None:
        if self.fh is not None:
            self.fh.close()
            self.fh = None


class Recorder:
    def __init__(self, broker: dict, prefix: str, store, data_dir: str,
                 record_raw: bool = True, raw_days: int = 10):
        self.broker = broker
        self.prefix = prefix
        self.store = store
        self.raw = RawLog(os.path.join(data_dir, "raw"), raw_days) if record_raw else None
        self.messages = 0
        self.samples = 0
        self.connected = False
        self.last_message = 0.0
        self.client: mqtt.Client | None = None
        self._stop = threading.Event()
        self.backup = None          # netbackup.NetBackup, attached by app.py

    # ---- mqtt --------------------------------------------------------

    def filters(self) -> list[str]:
        base = f"{self.prefix}/+/"
        return [base + "device/#", base + "bridge/#", base + "dev/#",
                base + "ota/tx", base + "ota/+/status"]

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        ok = getattr(reason_code, "is_failure", reason_code != 0) is False
        self.connected = bool(ok)
        if not ok:
            LOG.error("broker refused the recorder: %s", reason_code)
            return
        LOG.info("recorder connected to %s:%s", self.broker["host"], self.broker["port"])
        # Re-subscribed on every connect, not once: a reconnect starts a fresh
        # session and inherits no subscriptions, which is how a previous
        # recorder silently recorded nothing after a broker restart.
        for f in self.filters():
            client.subscribe(f, qos=0)
        if self.backup is not None:
            self.backup.client = client

    def _on_disconnect(self, *args):
        self.connected = False
        LOG.warning("recorder disconnected; paho will retry")

    def _on_message(self, client, userdata, msg):
        now = time.time()
        self.messages += 1
        self.last_message = now
        try:
            payload = msg.payload.decode("utf-8", "replace")
        except Exception:
            return

        # The network backup carries the mesh key: kept by netbackup.py in its
        # own 0600 file, never in the raw log, which is kept for days and is
        # what gets copied off for analysis.
        if msg.topic.endswith("/bridge/netcfg/export"):
            if self.backup is not None:
                self.backup.on_export(msg.topic, payload)
            return
        if self.backup is not None and msg.topic.endswith("/bridge/netcfg"):
            self.backup.on_status(msg.topic, payload)

        if self.raw is not None:
            self.raw.write(json.dumps({
                "t": now, "topic": msg.topic, "payload": payload,
                "retained": bool(msg.retain),
            }), now)

        # A retained message at connect is the broker replaying history, not a
        # device reporting now. Writing it into a time series would invent a
        # sample at the wrong moment.
        if msg.retain:
            return

        parts = msg.topic.split("/")
        if len(parts) < 3:
            return
        uid, rest = parts[1], parts[2:]
        if rest[0] == "bridge" and len(rest) > 1 and rest[1] == "stats":
            device, leaf = uid, ""
        elif rest[0] == "dev" and len(rest) >= 4 and rest[2] == "t":
            device, leaf = rest[1], "/".join(rest[3:])
        else:
            return

        try:
            body = json.loads(payload)
        except ValueError:
            body = None

        flat = {}
        if isinstance(body, (dict, list)):
            flatten(body, leaf, flat)
        else:
            try:
                flat[leaf] = float(payload)
            except ValueError:
                return

        for key, value in flat.items():
            if key not in SERIES_KEYS:
                continue
            if self.store.add(device, key, now, value):
                self.samples += 1

    # ---- lifecycle ---------------------------------------------------

    def start(self) -> None:
        if not self.broker.get("host"):
            LOG.error("recorder not started: no broker configured")
            return
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                        client_id=f"nowqtt-console-recorder-{os.getpid()}")
        if self.broker.get("user"):
            c.username_pw_set(self.broker["user"], self.broker.get("password") or "")
        c.on_connect = self._on_connect
        c.on_disconnect = self._on_disconnect
        c.on_message = self._on_message
        # Retry forever rather than give up: a multi-week recording must not
        # end because the broker restarted once.
        c.reconnect_delay_set(min_delay=1, max_delay=30)
        self.client = c
        try:
            c.connect_async(self.broker["host"], int(self.broker["port"]), keepalive=45)
        except OSError as exc:
            LOG.error("recorder cannot reach the broker: %s", exc)
        c.loop_start()
        threading.Thread(target=self._housekeep, daemon=True).start()

    def _housekeep(self) -> None:
        while not self._stop.wait(30):
            try:
                self.store.flush()
                self.store.prune()
            except Exception as exc:                # noqa: BLE001
                LOG.error("housekeeping: %s", exc)

    def stop(self) -> None:
        self._stop.set()
        if self.client is not None:
            self.client.loop_stop()
        self.store.flush()
        if self.raw is not None:
            self.raw.close()

    def status(self) -> dict:
        return {
            "connected": self.connected,
            "messages": self.messages,
            "samples": self.samples,
            "last_message": self.last_message,
            "raw": self.raw is not None,
        }
