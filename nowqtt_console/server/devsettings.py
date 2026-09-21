"""What people set about a device, kept by the add-on so every browser sees it.

Three settings, all about how the console shows a device and none of them the
device's own business:

board    which kind of hardware it is ("c3-supermini"). Devices of one board
         share one antenna offset, and the console estimates that offset per
         board from all the links its devices have: one unknown fitted to
         many links is well determined where one per device is not. A device
         with no board is the reference the others are measured against.
name     what to call it. The firmware may declare a name of its own (relayed
         on t/name); one set here wins, because somebody looking at the fleet
         decided on it.
antenna  in dB, an override: how much stronger (+) or weaker (-) this
         device's antenna and radio are than the fleet's usual board, when
         known better than the estimate. RSSI carries both ends'
         gains as well as the distance, so a board with an external dipole
         reads several dB stronger at the same spot and the map draws it
         closer than it is. RSSI alone cannot tell the two apart -- a
         stronger antenna and a shorter distance look the same on any link,
         and fitting the geometry per device does not resolve it (tried;
         see docs/console-v2-plan.md, "Antennas") -- which is why the
         estimate is per board and this is here to override it.

Kept here rather than in the browser's local storage because that is where
names used to live, and they were gone on a phone or after clearing site
data; a correction one browser applies and another does not would draw two
different maps of one mesh.
"""

from __future__ import annotations

import json
import os
import re

# A device id as the console uses it: a MAC without separators, either case
# (the gateway's uid is upper case, mesh MACs are lower).
ID = re.compile(r"^[0-9A-Fa-f]{12}$")
ANTENNA_LIMIT = 30.0   # dB. More than any antenna difference: a typo, not a board.
NAME_LIMIT = 64
BOARD = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,31}$")


def _clean_name(v) -> str:
    if not isinstance(v, str):
        raise ValueError("name must be a string")
    v = " ".join(v.split())
    if len(v) > NAME_LIMIT:
        raise ValueError(f"name is longer than {NAME_LIMIT} characters")
    return v


def _clean_board(v) -> str:
    if not isinstance(v, str):
        raise ValueError("board must be a string")
    v = v.strip().lower()
    if v and not BOARD.match(v):
        raise ValueError("board: up to 32 letters, digits, space . _ + -")
    return v


def _clean_antenna(v) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError("antenna must be a number of dB")
    if not -ANTENNA_LIMIT <= v <= ANTENNA_LIMIT:
        raise ValueError(f"antenna must be within ±{ANTENNA_LIMIT:g} dB")
    return round(float(v), 1)


class DeviceSettings:
    FIELDS = ("name", "board", "antenna")

    def __init__(self, data_dir: str) -> None:
        self.path = os.path.join(data_dir, "devices.json")

    def all(self) -> dict[str, dict]:
        try:
            with open(self.path, encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            return {}
        devs = doc.get("devices") if isinstance(doc, dict) else None
        if not isinstance(devs, dict):
            return {}
        out = {}
        for dev, s in devs.items():
            if not ID.match(dev) or not isinstance(s, dict):
                continue
            keep = {}
            try:
                if s.get("name"):
                    keep["name"] = _clean_name(s["name"])
                if s.get("board"):
                    keep["board"] = _clean_board(s["board"])
                if s.get("antenna"):
                    keep["antenna"] = _clean_antenna(s["antenna"])
            except ValueError:
                continue
            if keep:
                out[dev] = keep
        return out

    def update(self, dev, patch) -> dict[str, dict]:
        """Change some of one device's settings; an empty value clears one.

        One device and only the fields sent, so two people editing at once --
        one renaming, one correcting an antenna -- do not undo each other with
        a stale copy of the whole."""
        if not isinstance(dev, str) or not ID.match(dev):
            raise ValueError("id must be a 12-digit hex device id")
        if not isinstance(patch, dict) or not any(k in patch for k in self.FIELDS):
            raise ValueError("nothing to change: send name and/or antenna")
        devs = self.all()
        cur = dict(devs.get(dev, {}))
        if "name" in patch:
            v = patch["name"]
            v = _clean_name(v) if v is not None else ""
            if v:
                cur["name"] = v
            else:
                cur.pop("name", None)
        if "board" in patch:
            v = patch["board"]
            v = _clean_board(v) if v is not None else ""
            if v:
                cur["board"] = v
            else:
                cur.pop("board", None)
        if "antenna" in patch:
            v = patch["antenna"]
            v = _clean_antenna(v) if v is not None else 0.0
            if v:
                cur["antenna"] = v
            else:
                cur.pop("antenna", None)
        if cur:
            devs[dev] = cur
        else:
            devs.pop(dev, None)
        self._write({"devices": devs})
        return devs

    def _write(self, doc: dict) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=1, sort_keys=True)
        os.replace(tmp, self.path)
