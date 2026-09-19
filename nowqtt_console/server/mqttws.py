"""The WebSocket half of the MQTT proxy. See mqttproto.py for the rewrite."""

from __future__ import annotations

import asyncio
import logging

from aiohttp import WSMsgType, web

from .mqttproto import Incomplete, inject_credentials, packet_length

LOG = logging.getLogger("mqttws")


async def handler(request: web.Request) -> web.WebSocketResponse:
    cfg = request.app["mqtt"]
    ws = web.WebSocketResponse(protocols=("mqtt", "mqttv3.1"), heartbeat=30)
    await ws.prepare(request)

    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(cfg["host"], cfg["port"]), timeout=10)
    except (OSError, asyncio.TimeoutError) as exc:
        # Said out loud rather than closing silently: from the page this is
        # indistinguishable from a broker that is up and refusing the login.
        LOG.error("cannot reach broker %s:%s: %s", cfg["host"], cfg["port"], exc)
        await ws.close(code=1011, message=b"broker unreachable")
        return ws

    LOG.info("socket up: %s -> %s:%s", request.remote, cfg["host"], cfg["port"])

    async def to_broker() -> None:
        pending = bytearray()
        rewritten = False
        async for msg in ws:
            if msg.type is not WSMsgType.BINARY:
                if msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                    break
                continue
            if rewritten:
                writer.write(msg.data)
                await writer.drain()
                continue
            # Only the very first packet is a CONNECT, and it may arrive split
            # across frames or sharing one with what follows it.
            pending += msg.data
            try:
                total = packet_length(pending)
            except Incomplete:
                continue
            except ValueError as exc:
                LOG.error("bad first packet: %s", exc)
                break
            first = inject_credentials(bytes(pending[:total]), cfg["user"], cfg["password"])
            writer.write(first + bytes(pending[total:]))
            await writer.drain()
            pending.clear()
            rewritten = True

    async def to_page() -> None:
        while True:
            data = await reader.read(8192)
            if not data:
                break
            await ws.send_bytes(data)

    up = asyncio.create_task(to_broker())
    down = asyncio.create_task(to_page())
    try:
        done, pend = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
        for t in pend:
            t.cancel()
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass
        if not ws.closed:
            await ws.close()
    return ws
