#!/usr/bin/env python3
"""Local Woods Hole static server with one shared AISStream relay."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import threading
import time

import tornado.ioloop
import tornado.web
import tornado.websocket
import websocket


AIS_URL = "wss://stream.aisstream.io/v0/stream"
AIS_BOX = [[[41.20, -71.05], [41.70, -70.30]]]


class AISRelay:
    def __init__(self, loop: tornado.ioloop.IOLoop) -> None:
        self.loop = loop
        self.clients: set[AISHandler] = set()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="ais-relay", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def add(self, client: "AISHandler") -> None:
        self.clients.add(client)

    def remove(self, client: "AISHandler") -> None:
        self.clients.discard(client)

    def _broadcast(self, message: str) -> None:
        for client in tuple(self.clients):
            try:
                client.write_message(message)
            except tornado.websocket.WebSocketClosedError:
                self.clients.discard(client)

    def _run(self) -> None:
        delay = 2.0
        key = os.environ.get("AISSTREAM_API_KEY", "")
        if not key:
            print("AIS disabled: set AISSTREAM_API_KEY to enable the local relay.", flush=True)
            return
        subscription = json.dumps({
            "APIKey": key,
            "BoundingBoxes": AIS_BOX,
            "FilterMessageTypes": ["PositionReport"],
        })
        while not self._stop.is_set():
            sock = None
            try:
                sock = websocket.create_connection(AIS_URL, timeout=20, enable_multithread=True)
                sock.send(subscription)
                sock.settimeout(35)
                delay = 2.0
                while not self._stop.is_set():
                    try:
                        raw = sock.recv()
                    except websocket.WebSocketTimeoutException:
                        sock.ping()
                        continue
                    if not raw:
                        raise ConnectionError("AIS upstream closed")
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8", errors="replace")
                    try:
                        message = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if message.get("MessageType") != "PositionReport":
                        continue
                    self.loop.add_callback(self._broadcast, raw)
            except Exception as exc:  # the beta upstream is intermittently unavailable
                print(f"AIS relay reconnecting in {delay:.0f}s: {exc}", flush=True)
            finally:
                if sock is not None:
                    try:
                        sock.close()
                    except Exception:
                        pass
            self._stop.wait(delay)
            delay = min(delay * 1.7, 120.0)


class AISHandler(tornado.websocket.WebSocketHandler):
    def initialize(self, relay: AISRelay) -> None:
        self.relay = relay

    def check_origin(self, origin: str) -> bool:
        return True

    def open(self) -> None:
        self.set_nodelay(True)
        self.relay.add(self)

    def on_close(self) -> None:
        self.relay.remove(self)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent)
    args = parser.parse_args()
    root = args.root.resolve()
    loop = tornado.ioloop.IOLoop.current()
    relay = AISRelay(loop)
    app = tornado.web.Application([
        (r"/(?:WoodsHole/)?api/ais", AISHandler, {"relay": relay}),
        (r"/(.*)", tornado.web.StaticFileHandler, {"path": str(root), "default_filename": "index.html"}),
    ])
    app.listen(args.port, address="127.0.0.1")
    relay.start()
    print(f"Woods Hole server: http://127.0.0.1:{args.port}/", flush=True)
    loop.start()


if __name__ == "__main__":
    main()
