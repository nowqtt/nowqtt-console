"""Link RSSI, averaged: the median of each link's last reports.

A device's topology report carries the RSSI of the last single frame it heard
from each neighbour (aodv_peer_seen overwrites it on every frame), so one
report is one sample -- and a sample swings by several dB with a door, a
person or the other radio's traffic. The maps turn RSSI into distance and the
antenna estimate turns it into dB of gain; both need the level, not the
swing.

The add-on sees every report around the clock, where a browser sees only what
arrives while it is open, so the averaging is done here: a median of the last
WINDOW reports per link (robust to the odd frame caught mid-fade, which a mean
is not), kept across restarts.

Keyed by who measured it: the gateway's bridge/mesh (measurer = its uid) and
each node's dev/<mac>/t/topo. A link heard from both ends is two entries, and
the difference between them is information, not noise to average away.
"""

from __future__ import annotations

import json
import os
import statistics
import threading
import time

WINDOW = 30               # reports per link; a node reports every few minutes
FORGET_S = 24 * 3600      # a link not reported for a day is gone


class LinkStats:
    def __init__(self, data_dir: str) -> None:
        self.path = os.path.join(data_dir, "links.json")
        self._lock = threading.Lock()
        self._dirty = False
        # measurer -> peer -> {"s": [rssi, ...], "last": t}
        self._links: dict[str, dict[str, dict]] = {}
        self._load()

    # ---- input -------------------------------------------------------

    def on_message(self, topic: str, payload: str, retained: bool,
                   now: float | None = None) -> None:
        parts = topic.split("/")
        if len(parts) == 4 and parts[2] == "bridge" and parts[3] == "mesh":
            measurer = parts[1]
        elif len(parts) == 6 and parts[2] == "dev" and parts[4] == "t" and parts[5] == "topo":
            measurer = parts[3]
        else:
            return
        try:
            body = json.loads(payload)
        except ValueError:
            return
        peers = body.get("peers") if isinstance(body, dict) else None
        if not isinstance(peers, list):
            return
        measurer = measurer.lower()
        now = time.time() if now is None else now
        with self._lock:
            known = self._links.get(measurer)
            # A retained report is the broker replaying the last one. After a
            # restart that report is already in the saved window; counting it
            # again would weight one sample twice.
            if retained and known:
                return
            links = self._links.setdefault(measurer, {})
            for p in peers:
                if not isinstance(p, dict):
                    continue
                m, rssi = p.get("m"), p.get("rssi")
                if not isinstance(m, str) or isinstance(rssi, bool) \
                        or not isinstance(rssi, (int, float)) or rssi == 0:
                    continue          # 0 is "no reading", not a perfect link
                e = links.setdefault(m.lower(), {"s": [], "last": 0.0})
                e["s"].append(int(rssi))
                del e["s"][:-WINDOW]
                e["last"] = now
            self._dirty = True

    # ---- output ------------------------------------------------------

    def snapshot(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        out: dict[str, dict] = {}
        with self._lock:
            for measurer, links in self._links.items():
                for peer, e in links.items():
                    if not e["s"] or now - e["last"] > FORGET_S:
                        continue
                    out.setdefault(measurer, {})[peer] = {
                        "rssi": round(statistics.median(e["s"]), 1),
                        "n": len(e["s"]),
                        "last": round(e["last"]),
                    }
        return {"window": WINDOW, "links": out}

    # ---- persistence -------------------------------------------------

    def _load(self) -> None:
        try:
            with open(self.path, encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            return
        links = doc.get("links") if isinstance(doc, dict) else None
        if not isinstance(links, dict):
            return
        for measurer, peers in links.items():
            if not isinstance(peers, dict):
                continue
            for peer, e in peers.items():
                if isinstance(e, dict) and isinstance(e.get("s"), list):
                    s = [int(v) for v in e["s"] if isinstance(v, (int, float))][-WINDOW:]
                    if s:
                        self._links.setdefault(measurer, {})[peer] = {
                            "s": s, "last": float(e.get("last") or 0)}

    def flush(self, now: float | None = None) -> None:
        """Write if anything changed, and forget links gone for a day."""
        now = time.time() if now is None else now
        with self._lock:
            if not self._dirty:
                return
            for measurer in list(self._links):
                links = self._links[measurer]
                for peer in [p for p, e in links.items() if now - e["last"] > FORGET_S]:
                    del links[peer]
                if not links:
                    del self._links[measurer]
            doc = {"links": self._links}
            self._dirty = False
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(doc, fh)
            os.replace(tmp, self.path)
