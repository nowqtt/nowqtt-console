"""Keep a copy of the mesh's network record, so a gateway that loses its own
can be given it back.

Since the first key rotation the mesh key exists nowhere but in the devices,
and a gateway never learns the record from the mesh -- it is the authority.
A gateway whose NVS is lost (an erase-flash, a partition-table change, a dead
flash chip) comes back on the factory key, and every node ignores it. The
record is what puts it back, and nobody remembers to take a backup after
every change, so this does it.

How: the gateway publishes its status on `bridge/netcfg` (retained, on every
step). When that names a finished change on an epoch we hold no copy of, this
asks with `bridge/netcfg/set {"export":true}`, and the gateway answers once,
not retained, on `bridge/netcfg/export`. The answer is written to
`/data/netcfg/<uid>.json`, mode 0600, and each epoch is also kept as its own
file so an older one is still there if it is ever needed.

The raw recorder never writes the export: see recorder.py.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time

LOG = logging.getLogger("netbackup")

# The states in which the record is settled. During a change the gateway is
# still on the old epoch, and a copy then would be out of date a second later.
SETTLED = {"idle", "done", "aborted", "reverted"}
ASK_EVERY_S = 60
_UID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_KEY = re.compile(r"^[0-9a-f]{64}$")


class NetBackup:
    def __init__(self, data_dir: str, prefix: str):
        self.dir = os.path.join(data_dir, "netcfg")
        self.prefix = prefix
        self.client = None                  # set by the recorder once connected
        self._asked: dict[str, float] = {}
        os.makedirs(self.dir, mode=0o700, exist_ok=True)

    # ---- files --------------------------------------------------------

    def _path(self, uid: str, epoch: int | None = None) -> str:
        name = f"{uid}.json" if epoch is None else f"{uid}-epoch{epoch}.json"
        return os.path.join(self.dir, name)

    def latest(self, uid: str) -> dict | None:
        if not _UID.match(uid or ""):
            return None
        try:
            with open(self._path(uid), encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def gateways(self) -> list[str]:
        try:
            names = os.listdir(self.dir)
        except OSError:
            return []
        return sorted(n[:-5] for n in names
                      if n.endswith(".json") and "-epoch" not in n)

    def _write(self, path: str, doc: dict) -> None:
        tmp = path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        os.replace(tmp, path)

    # ---- messages -----------------------------------------------------

    @staticmethod
    def _uid(topic: str) -> str | None:
        parts = topic.split("/")
        return parts[1] if len(parts) >= 3 and _UID.match(parts[1]) else None

    def on_status(self, topic: str, payload: str) -> None:
        uid = self._uid(topic)
        if uid is None:
            return
        try:
            st = json.loads(payload)
        except ValueError:
            return
        epoch = st.get("epoch")
        # Epoch 0 is the factory record: nothing to keep, and a gateway on it
        # may be one that lost its record -- the copy we hold is then exactly
        # the thing that must not be overwritten.
        if not isinstance(epoch, int) or epoch == 0:
            return
        if st.get("state", "idle") not in SETTLED:
            return
        have = self.latest(uid)
        if have and have.get("epoch") == epoch:
            return
        now = time.time()
        if now - self._asked.get(uid, 0) < ASK_EVERY_S or self.client is None:
            return
        self._asked[uid] = now
        LOG.info("gateway %s is on epoch %s; asking for a backup", uid, epoch)
        self.client.publish(f"{self.prefix}/{uid}/bridge/netcfg/set",
                            json.dumps({"export": True}), qos=1)

    def on_export(self, topic: str, payload: str) -> None:
        uid = self._uid(topic)
        if uid is None:
            return
        try:
            doc = json.loads(payload)
        except ValueError:
            return
        epoch, channel, key = doc.get("epoch"), doc.get("channel"), doc.get("key")
        if (not isinstance(epoch, int) or epoch == 0 or not isinstance(channel, int)
                or not isinstance(key, str) or not _KEY.match(key)):
            LOG.warning("gateway %s sent a backup that is not one; ignored", uid)
            return
        doc = {"uid": uid, "saved": int(time.time()), "epoch": epoch,
               "channel": channel, "revert_s": doc.get("revert_s", 0),
               "grace_s": doc.get("grace_s", 0), "key": key}
        self._write(self._path(uid, epoch), doc)
        self._write(self._path(uid), doc)
        LOG.info("backed up gateway %s: epoch %s, channel %s", uid, epoch, channel)

    def status(self) -> dict:
        out = {}
        for uid in self.gateways():
            d = self.latest(uid) or {}
            out[uid] = {"epoch": d.get("epoch"), "channel": d.get("channel"),
                        "saved": d.get("saved")}
        return out
