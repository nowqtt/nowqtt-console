"""The one piece of MQTT this add-on has to understand: the CONNECT packet.

The proxy in mqttws.py is otherwise a byte relay -- MQTT over WebSocket puts
MQTT packets in binary frames with no framing of its own, so a frame may hold
part of a packet or several, and none of that needs interpreting.

The exception is the first packet. The broker's username and password come
from the Supervisor, and handing them to the browser so it can put them in its
own CONNECT would be giving the page a secret it has no use for, which would
then sit in localStorage. So the CONNECT is intercepted and its credentials
replaced: the page connects anonymously and the broker sees a real login.

No aiohttp here on purpose. This is byte surgery on a wire protocol whose
failure mode is a rejected login that looks exactly like a wrong password, so
it is kept separate and tested on its own (test/test_mqttws.py).

Only protocol level 3 and 4 (MQTT 3.1 and 3.1.1) are rewritten. Level 5 puts a
property block in the variable header, and the console pins version 4, so a v5
CONNECT is passed through untouched rather than parsed speculatively.
"""

from __future__ import annotations

import logging

LOG = logging.getLogger("mqttproto")

CONNECT = 1


class Incomplete(Exception):
    """Not enough bytes yet to see a whole packet."""


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    mult = 1
    value = 0
    for _ in range(4):
        if i >= len(buf):
            raise Incomplete()
        b = buf[i]
        i += 1
        value += (b & 0x7F) * mult
        if not b & 0x80:
            return value, i
        mult *= 128
    raise ValueError("malformed remaining length")


def _enc_varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        if n:
            b |= 0x80
        out.append(b)
        if not n:
            return bytes(out)


def _enc_str(s: str) -> bytes:
    raw = s.encode("utf-8")
    return len(raw).to_bytes(2, "big") + raw


def packet_length(buf: bytes) -> int:
    """Total length of the packet at the head of buf. Raises Incomplete."""
    if len(buf) < 2:
        raise Incomplete()
    remaining, i = _varint(buf, 1)
    total = i + remaining
    if len(buf) < total:
        raise Incomplete()
    return total


def inject_credentials(pkt: bytes, user: str, password: str) -> bytes:
    """Return the CONNECT packet with username/password replaced.

    Anything that is not a level 3/4 CONNECT is returned unchanged, as is any
    packet when there is no username to set -- an anonymous broker wants the
    client's own CONNECT, not a rewritten one.
    """
    if not user:
        return pkt
    if pkt[0] >> 4 != CONNECT:
        return pkt

    remaining, i = _varint(pkt, 1)
    body = pkt[i:i + remaining]

    nlen = int.from_bytes(body[0:2], "big")
    j = 2 + nlen
    if j >= len(body):
        return pkt
    level = body[j]
    j += 1
    if level not in (3, 4):
        LOG.warning("CONNECT protocol level %d left alone; credentials not injected", level)
        return pkt

    flags_at = j
    flags = body[j]
    j += 1
    j += 2                                    # keep-alive
    payload_at = j

    def skip_field(p: int) -> int:
        n = int.from_bytes(body[p:p + 2], "big")
        return p + 2 + n

    p = skip_field(payload_at)                # client id
    if flags & 0x04:                          # will topic + message
        p = skip_field(p)
        p = skip_field(p)
    keep = body[payload_at:p]                 # client id and will, preserved

    new_flags = (flags & ~0xC0) | 0x80
    creds = _enc_str(user)
    if password:
        new_flags |= 0x40
        creds += _enc_str(password)

    new_body = (body[:flags_at] + bytes([new_flags]) + body[flags_at + 1:payload_at]
                + keep + creds)
    return bytes([pkt[0]]) + _enc_varint(len(new_body)) + new_body


