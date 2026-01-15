"""
Data collector:
- Connects Binance futures WebSocket
- Maintains orderbook state
- Computes wall map + OFI
"""

import asyncio
import json
import os
from datetime import datetime
from typing import Callable, Dict, List

import aiohttp

from .ofi_calculator import OFICalculator
from .orderbook import OrderBookManager
from .wall_tracker import WallTracker


def _ws_base() -> str:
    return os.getenv("ORDERBOOK_BINANCE_WS_URL", "wss://fstream.binance.com/ws")


class DataCollector:
    def __init__(self, symbols: List[str], thresholds: Dict[str, float] | None = None):
        self.symbols = symbols
        self.thresholds = thresholds or {}

        self.managers: Dict[str, OrderBookManager] = {}
        self.wall_trackers: Dict[str, WallTracker] = {}
        self.ofi_calculators: Dict[str, OFICalculator] = {}

        for symbol in symbols:
            self.managers[symbol] = OrderBookManager(symbol, depth=20)
            threshold = float(self.thresholds.get(symbol, 200_000))
            self.wall_trackers[symbol] = WallTracker(symbol, threshold_usd=threshold)
            self.ofi_calculators[symbol] = OFICalculator(depth=10, ema_span=20)

        self._running = False
        self._callbacks: List[Callable] = []

    def on_update(self, callback: Callable):
        self._callbacks.append(callback)

    async def start(self):
        self._running = True

        async with aiohttp.ClientSession() as session:
            init_tasks = [self.managers[s].initialize(session) for s in self.symbols]
            await asyncio.gather(*init_tasks)

            streams = [f"{s.lower()}@depth20@500ms" for s in self.symbols]
            ws_url = f"{_ws_base()}/stream?streams={'/'.join(streams)}"

            while self._running:
                try:
                    async with session.ws_connect(ws_url) as ws:
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await self._handle_message(msg.data, session)
                            elif msg.type == aiohttp.WSMsgType.ERROR:
                                break
                except Exception:
                    await asyncio.sleep(5)

    async def _handle_message(self, data: str, session: aiohttp.ClientSession):
        try:
            msg = json.loads(data)
            stream = msg.get("stream", "")
            event = msg.get("data", {})

            symbol = stream.split("@")[0].upper()
            if symbol not in self.managers:
                return

            manager = self.managers[symbol]
            success = manager.process_update(event)
            if not success:
                await manager.initialize(session)
                return

            orderbook = manager.get_snapshot()
            wall_events = self.wall_trackers[symbol].update(orderbook)
            ofi_state = self.ofi_calculators[symbol].update(orderbook)

            update_data = {
                "symbol": symbol,
                "timestamp": datetime.now().isoformat(),
                "orderbook": {
                    "best_bid": orderbook.best_bid,
                    "best_ask": orderbook.best_ask,
                    "mid_price": orderbook.mid_price,
                    "spread_bps": orderbook.spread_bps,
                },
                "ofi": {
                    "raw": ofi_state.raw,
                    "ema": ofi_state.ema,
                    "z_score": ofi_state.z_score,
                    "signal": ofi_state.signal,
                },
                "wall_events": wall_events,
                "wall_map_4h": self.wall_trackers[symbol].get_wall_map("4h"),
                "wall_map_1h": self.wall_trackers[symbol].get_wall_map("1h"),
                "wall_map_15min": self.wall_trackers[symbol].get_wall_map("15min"),
            }

            for callback in self._callbacks:
                try:
                    if asyncio.iscoroutinefunction(callback):
                        await callback(update_data)
                    else:
                        callback(update_data)
                except Exception:
                    continue
        except Exception:
            return

    def stop(self):
        self._running = False

