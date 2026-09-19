"""Long-term history, in SQLite.

Not a copy of the raw recording. The raw `soak.jsonl` exists so delivery can be
scored from every device's own report counter -- that needs every message, and
it costs about 86 MB a day measured on this fleet, so it is rotated and kept
for days rather than months. This store answers the other question, "what has
this number been doing for the last month", and for that a sample a minute is
plenty.

The arithmetic, because it decides the defaults rather than being discovered
afterwards: ten devices, about twenty kept series each, one sample a minute is
288,000 rows a day, roughly 10 MB with the index. Thirty days is some 300 MB.
Both the interval and the retention are add-on options, so anybody who wants
finer or longer can have it knowingly.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time

LOG = logging.getLogger("store")

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    device TEXT    NOT NULL,
    series TEXT    NOT NULL,
    ts     INTEGER NOT NULL,
    value  REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_samples ON samples (device, series, ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""


class SeriesStore:
    def __init__(self, path: str, min_interval: int = 60, retain_days: int = 30):
        self.path = path
        self.min_interval = max(0, int(min_interval))
        self.retain_days = max(1, int(retain_days))
        self._last: dict[tuple[str, str], float] = {}
        self._lock = threading.Lock()
        self._pending = 0
        self._last_prune = 0.0

        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        # WAL because the recorder writes while the web server reads, and the
        # default journal makes those block each other.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)
        self.db.commit()
        LOG.info("series store %s (every %ds, keep %dd)", path,
                 self.min_interval, self.retain_days)

    def add(self, device: str, series: str, ts: float, value: float) -> bool:
        key = (device, series)
        if self.min_interval:
            prev = self._last.get(key)
            if prev is not None and ts - prev < self.min_interval:
                return False
        self._last[key] = ts
        with self._lock:
            self.db.execute(
                "INSERT INTO samples (device, series, ts, value) VALUES (?,?,?,?)",
                (device, series, int(ts), float(value)))
            self._pending += 1
            # Committing every row costs an fsync per sample; committing never
            # loses the tail on a container restart. Every few hundred, or
            # whenever flush() is called on the timer.
            if self._pending >= 400:
                self.db.commit()
                self._pending = 0
        return True

    def flush(self) -> None:
        with self._lock:
            if self._pending:
                self.db.commit()
                self._pending = 0

    def prune(self, force: bool = False) -> int:
        now = time.time()
        if not force and now - self._last_prune < 3600:
            return 0
        self._last_prune = now
        cutoff = int(now - self.retain_days * 86400)
        with self._lock:
            cur = self.db.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
            self.db.commit()
        if cur.rowcount > 0:
            LOG.info("pruned %d samples older than %d days", cur.rowcount, self.retain_days)
        return cur.rowcount

    # ---- reads -------------------------------------------------------

    def devices(self) -> list[str]:
        with self._lock:
            return [r[0] for r in self.db.execute(
                "SELECT DISTINCT device FROM samples ORDER BY device")]

    def series_for(self, device: str) -> list[dict]:
        with self._lock:
            rows = self.db.execute(
                "SELECT series, COUNT(*), MIN(ts), MAX(ts) FROM samples "
                "WHERE device=? GROUP BY series ORDER BY series", (device,)).fetchall()
        return [{"series": r[0], "count": r[1], "first": r[2], "last": r[3]} for r in rows]

    def query(self, device: str, series: str, since: int | None = None,
              until: int | None = None, limit: int = 2000) -> dict:
        """Samples, thinned by taking every nth row rather than averaging.

        Averaging would smooth away the spike that is usually the reason
        somebody opened the chart. Thinning keeps real samples and says how
        many it skipped.
        """
        sql = "SELECT ts, value FROM samples WHERE device=? AND series=?"
        args: list = [device, series]
        if since is not None:
            sql += " AND ts >= ?"
            args.append(int(since))
        if until is not None:
            sql += " AND ts <= ?"
            args.append(int(until))
        sql += " ORDER BY ts"
        with self._lock:
            rows = self.db.execute(sql, args).fetchall()
        total = len(rows)
        step = 1 if total <= limit else (total + limit - 1) // limit
        return {
            "device": device, "series": series, "total": total, "step": step,
            "points": [[r[0], r[1]] for r in rows[::step]],
        }
