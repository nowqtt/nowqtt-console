ARG BUILD_FROM=python:3.12-alpine
FROM ${BUILD_FROM}

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
