"""Where the broker is, and who we are to it.

Three sources, in this order:

1. The add-on options, if `broker_host` is set. An explicit answer wins,
   because this fleet's broker is a plain mosquitto on another host and the
   Supervisor knows nothing about it.
2. The Supervisor's MQTT service. This is what makes the add-on seamless when
   the broker *is* the Mosquitto add-on: host, port, username and password
   arrive without anybody typing them.
3. Nothing, and say so loudly. A console that silently points at localhost
   looks like a broken mesh rather than a missing setting.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

LOG = logging.getLogger("config")

SUPERVISOR = "http://supervisor"

DEFAULTS = {
    "topic_prefix": "nowqtt",
    "broker_host": "",
    "broker_port": 1883,
    "broker_user": "",
    "broker_password": "",
    "record_raw": True,
    "raw_days": 10,
    "series_every": 60,
    "series_days": 30,
}


def load_options(path: str = "/data/options.json") -> dict:
    opts = dict(DEFAULTS)
    try:
        with open(path) as fh:
            got = json.load(fh)
        if isinstance(got, dict):
            opts.update({k: v for k, v in got.items() if v is not None})
    except FileNotFoundError:
        LOG.info("%s not there; running with defaults (not under the Supervisor?)", path)
    except (OSError, ValueError) as exc:
        LOG.error("cannot read %s: %s -- using defaults", path, exc)
    return opts


def supervisor_mqtt(timeout: float = 5.0) -> dict | None:
    """The Mosquitto add-on's details, or None if there is no such service."""
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return None
    req = urllib.request.Request(f"{SUPERVISOR}/services/mqtt")
    # Both headers: the current one and the one older Supervisors want. Sending
    # an ignored header costs nothing; guessing wrong costs the whole feature.
    req.add_header("X-Supervisor-Token", token)
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        LOG.info("supervisor has no mqtt service (%s)", exc.code)
        return None
    except (urllib.error.URLError, OSError, ValueError) as exc:
        LOG.warning("supervisor mqtt lookup failed: %s", exc)
        return None
    data = body.get("data") or {}
    if not data.get("host"):
        return None
    return data


def resolve(opts: dict) -> dict:
    if opts.get("broker_host"):
        LOG.info("broker from add-on options: %s:%s", opts["broker_host"], opts["broker_port"])
        return {
            "host": opts["broker_host"],
            "port": int(opts["broker_port"]),
            "user": opts.get("broker_user") or "",
            "password": opts.get("broker_password") or "",
            "source": "options",
        }

    found = supervisor_mqtt()
    if found:
        LOG.info("broker from the Supervisor: %s:%s (user %s)",
                 found["host"], found.get("port"), found.get("username") or "-")
        if found.get("ssl"):
            # Not supported rather than silently plaintext: the proxy opens a
            # bare TCP socket, and connecting it to a TLS listener fails in a
            # way that reads like an unreachable broker.
            LOG.error("the Supervisor's MQTT service wants TLS, which this proxy "
                      "does not speak; set broker_host/port in the add-on options")
        return {
            "host": found["host"],
            "port": int(found.get("port") or 1883),
            "user": found.get("username") or "",
            "password": found.get("password") or "",
            "source": "supervisor",
        }

    LOG.error("no broker: set broker_host in the add-on options, or install the "
              "Mosquitto add-on so the Supervisor can supply one")
    return {"host": "", "port": 1883, "user": "", "password": "", "source": "none"}
