"""
OrderBook state machine.

Tracks L2 snapshots and incremental updates for Binance futures.
"""

import os
import time
import copy
from dataclasses import dataclass, field
from typing import List, Optional

import aiohttp


def _rest_base() -> str:
    return os.getenv("ORDERBOOK_BINANCE_REST_URL", "https://fapi.binance.com")


@dataclass
class PriceLevel:
    price: float
    quantity: float

    @property
    def notional(self) -> float:
        return self.price * self.quantity


@dataclass
class OrderBook:
    symbol: str
    bids: List[PriceLevel] = field(default_factory=list)
    asks: List[PriceLevel] = field(default_factory=list)
    last_update_id: int = 0
    timestamp: float = 0

    @property
    def best_bid(self) -> Optional[float]:
        return self.bids[0].price if self.bids else None

    @property
    def best_ask(self) -> Optional[float]:
        return self.asks[0].price if self.asks else None

    @property
    def mid_price(self) -> Optional[float]:
        if self.best_bid and self.best_ask:
            return (self.best_bid + self.best_ask) / 2
        return None

    @property
    def spread_bps(self) -> Optional[float]:
        if self.best_bid and self.best_ask and self.mid_price:
            return (self.best_ask - self.best_bid) / self.mid_price * 10000
        return None


class OrderBookManager:
    def __init__(self, symbol: str, depth: int = 20, rest_url: Optional[str] = None):
        self.symbol = symbol
        self.depth = depth
        self.rest_url = rest_url or _rest_base()
        self.orderbook = OrderBook(symbol=symbol)
        self._last_u = 0
        self._initialized = False

    async def initialize(self, session: aiohttp.ClientSession):
        url = f"{self.rest_url}/fapi/v1/depth"
        params = {"symbol": self.symbol, "limit": self.depth}
        async with session.get(url, params=params) as resp:
            data = await resp.json()

        self.orderbook.bids = [PriceLevel(float(p), float(q)) for p, q in data["bids"]]
        self.orderbook.asks = [PriceLevel(float(p), float(q)) for p, q in data["asks"]]
        self.orderbook.last_update_id = data["lastUpdateId"]
        self.orderbook.timestamp = time.time()
        self._last_u = data["lastUpdateId"]
        self._initialized = True

    def process_update(self, event: dict) -> bool:
        if not self._initialized:
            return False

        U = event.get("U", event.get("u"))
        u = event["u"]
        pu = event.get("pu", self._last_u)

        if self._last_u == self.orderbook.last_update_id:
            if not (U <= self._last_u + 1 <= u):
                return False
        else:
            if pu != self._last_u:
                return False

        self._apply_update(event["b"], self.orderbook.bids, reverse=True)
        self._apply_update(event["a"], self.orderbook.asks, reverse=False)

        self.orderbook.bids = self.orderbook.bids[: self.depth]
        self.orderbook.asks = self.orderbook.asks[: self.depth]

        self.orderbook.last_update_id = u
        self.orderbook.timestamp = time.time()
        self._last_u = u

        if self.orderbook.best_bid and self.orderbook.best_ask:
            if self.orderbook.best_bid >= self.orderbook.best_ask:
                return False

        return True

    def _apply_update(self, updates: List, book_side: List[PriceLevel], reverse: bool):
        price_map = {level.price: level for level in book_side}

        for price_str, qty_str in updates:
            price = float(price_str)
            qty = float(qty_str)

            if qty == 0:
                price_map.pop(price, None)
            else:
                price_map[price] = PriceLevel(price, qty)

        book_side.clear()
        book_side.extend(sorted(price_map.values(), key=lambda x: x.price, reverse=reverse))

    def get_snapshot(self) -> OrderBook:
        return copy.deepcopy(self.orderbook)

