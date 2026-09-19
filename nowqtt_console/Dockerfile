# Pinned here rather than taken from BUILD_FROM. Recent Supervisors pass
# BUILD_FROM=ghcr.io/home-assistant/base:latest regardless of build.yaml, and
# that image is plain Alpine with no Python -- the first install on a real
# Home Assistant failed with "pip: not found". python:*-alpine is multi-arch,
# so Docker pulls the right one for amd64, aarch64 and armv7 by itself.
FROM python:3.12-alpine

# aiohttp serves the page, proxies the MQTT socket and answers the history API
# from one port, which is what ingress requires: Home Assistant proxies exactly
# one. paho-mqtt is pure Python and does the recording.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY server/ /app/server/
COPY www/ /app/www/

WORKDIR /app
ENV PYTHONUNBUFFERED=1 NOWQTT_WWW=/app/www NOWQTT_DATA=/data

CMD ["python3", "-m", "server.app"]
