"""The add-on: one port serving the console, its MQTT socket and its history.

One port because that is what ingress gives you. Home Assistant proxies a
single port per add-on, so the static page, the WebSocket the page talks MQTT
over, and the history API all hang off the same aiohttp application.

Every path the page uses is relative. Ingress serves the add-on under
/api/hassio_ingress/<token>/, which changes on every restart, so an absolute
"/api/config" would leave the ingress path and 404 against Home Assistant
itself.
"""

from __future__ import annotations

import asyncio
import logging
import os

from aiohttp import web

from . import config as cfgmod
from . import mqttws
from .devsettings import DeviceSettings
from .links import LinkStats
from .netbackup import NetBackup
from .recorder import Recorder
from .store import SeriesStore

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
LOG = logging.getLogger("app")

WWW = os.environ.get("NOWQTT_WWW", "/app/www")
DATA = os.environ.get("NOWQTT_DATA", "/data")
PORT = int(os.environ.get("NOWQTT_PORT", "8099"))


async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def api_config(request: web.Request) -> web.Response:
    """What the page needs to know about where it is running.

    `credentials: "proxy"` is the important one: it tells the console not to
    ask anybody for a broker username or password. The proxy puts the real ones
    into the CONNECT, so the page never holds them and nothing lands in
    localStorage.
    """
    broker = request.app["mqtt"]
    rec: Recorder = request.app["recorder"]
    return web.json_response({
        "mode": "addon",
        "ws_path": "mqtt",
        "prefix": request.app["prefix"],
        "credentials": "proxy" if broker.get("user") else "anonymous",
        "broker": {
            # Host and port, so the page can say what it is talking to. Never
            # the username, and never the password.
            "host": broker.get("host") or None,
            "port": broker.get("port"),
            "source": broker.get("source"),
        },
        "history": True,
        "recorder": rec.status(),
    })


async def api_status(request: web.Request) -> web.Response:
    rec: Recorder = request.app["recorder"]
    return web.json_response(rec.status())


async def api_devices(request: web.Request) -> web.Response:
    store: SeriesStore = request.app["store"]
    return web.json_response({"devices": store.devices()})


async def api_series(request: web.Request) -> web.Response:
    store: SeriesStore = request.app["store"]
    device = request.query.get("device")
    if not device:
        raise web.HTTPBadRequest(text="device is required")
    return web.json_response({"device": device, "series": store.series_for(device)})


async def api_history(request: web.Request) -> web.Response:
    store: SeriesStore = request.app["store"]
    device = request.query.get("device")
    series = request.query.get("series")
    if not device or not series:
        raise web.HTTPBadRequest(text="device and series are required")

    def num(name, default=None):
        raw = request.query.get(name)
        if raw in (None, ""):
            return default
        try:
            return int(float(raw))
        except ValueError:
            raise web.HTTPBadRequest(text=f"{name} must be a number")

    return web.json_response(store.query(
        device, series, since=num("since"), until=num("until"),
        limit=max(1, min(20000, num("limit", 2000)))))


async def api_netcfg_backups(request: web.Request) -> web.Response:
    """Which gateways have a backup, and of which epoch. No key in here."""
    nb: NetBackup = request.app["netbackup"]
    return web.json_response({"backups": nb.status()})


async def api_netcfg_backup(request: web.Request) -> web.Response:
    """The whole backup, key included, for the console's download and restore.

    Only reachable through Home Assistant's ingress, which is Home Assistant's
    own login: the add-on publishes no port. Not cached anywhere.
    """
    nb: NetBackup = request.app["netbackup"]
    doc = nb.latest(request.match_info["uid"])
    if doc is None:
        raise web.HTTPNotFound(text="no backup for that gateway")
    return web.json_response(doc, headers={"Cache-Control": "no-store"})


async def api_settings(request: web.Request) -> web.Response:
    """Every device's name and antenna offset, as people set them."""
    ds: DeviceSettings = request.app["devsettings"]
    return web.json_response({"devices": ds.all()},
                             headers={"Cache-Control": "no-store"})


async def api_settings_set(request: web.Request) -> web.Response:
    """Change one device: {"id": "<mac>", "name"?, "board"?, "antenna"?}; null clears."""
    ds: DeviceSettings = request.app["devsettings"]
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("expected a JSON object")
        devs = ds.update(body.get("id"), {k: body[k] for k in ds.FIELDS if k in body})
    except ValueError as e:
        raise web.HTTPBadRequest(text=str(e))
    return web.json_response({"devices": devs})


async def api_links(request: web.Request) -> web.Response:
    """Each link's median RSSI over its last reports, per measuring end."""
    ls: LinkStats = request.app["links"]
    return web.json_response(ls.snapshot(), headers={"Cache-Control": "no-store"})


async def index(request: web.Request) -> web.StreamResponse:
    path = os.path.join(WWW, "index.html")
    if not os.path.exists(path):
        return web.Response(status=500, text=(
            "The console is not in this image. www/ is assembled from "
            "console-v2/ by addon/publish.sh; see that script."))
    return web.FileResponse(path)


def build_app() -> web.Application:
    opts = cfgmod.load_options(os.path.join(DATA, "options.json"))
    broker = cfgmod.resolve(opts)

    store = SeriesStore(os.path.join(DATA, "series.db"),
                        min_interval=int(opts["series_every"]),
                        retain_days=int(opts["series_days"]))
    recorder = Recorder(broker, opts["topic_prefix"], store, DATA,
                        record_raw=bool(opts["record_raw"]),
                        raw_days=int(opts["raw_days"]))

    netbackup = NetBackup(DATA, opts["topic_prefix"])
    recorder.backup = netbackup
    links = LinkStats(DATA)
    recorder.links = links

    app = web.Application()
    app["mqtt"] = broker
    app["prefix"] = opts["topic_prefix"]
    app["store"] = store
    app["recorder"] = recorder
    app["netbackup"] = netbackup
    app["devsettings"] = DeviceSettings(DATA)
    app["links"] = links

    app.router.add_get("/api/health", health)
    app.router.add_get("/api/config", api_config)
    app.router.add_get("/api/status", api_status)
    app.router.add_get("/api/history/devices", api_devices)
    app.router.add_get("/api/history/series", api_series)
    app.router.add_get("/api/history", api_history)
    app.router.add_get("/api/netcfg/backups", api_netcfg_backups)
    app.router.add_get("/api/netcfg/backup/{uid}", api_netcfg_backup)
    app.router.add_get("/api/settings", api_settings)
    app.router.add_post("/api/settings", api_settings_set)
    app.router.add_get("/api/links", api_links)
    app.router.add_get("/mqtt", mqttws.handler)
    app.router.add_get("/", index)
    if os.path.isdir(WWW):
        # Last, so it cannot shadow the API routes above.
        app.router.add_static("/", WWW, show_index=False)

    async def on_start(_app):
        recorder.start()

    async def on_stop(_app):
        recorder.stop()

    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    return app


def main() -> None:
    app = build_app()
    LOG.info("serving %s on 0.0.0.0:%d", WWW, PORT)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None,
                print=lambda *a: None)


if __name__ == "__main__":
    main()
