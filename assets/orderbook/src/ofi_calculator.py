"""
OFI (Order Flow Imbalance) calculator.

Keeps internal history to compute a simple z-score. Implemented without numpy to
minimize runtime dependencies.
"""

from dataclasses import dataclass
from collections import deque
from typing import Deque, List, Tuple
import math


@dataclass
class OFIState:
    raw: float = 0.0
    ema: float = 0.0
    std: float = 1.0
    z_score: float = 0.0
    signal: str = "NEUTRAL"


def _std(values: List[float]) -> float:
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    var = sum((v - mean) ** 2 for v in values) / len(values)
    return math.sqrt(var)


class OFICalculator:
    def __init__(self, depth: int = 10, ema_span: int = 20, history_size: int = 100):
        self.depth = depth
        self.ema_span = ema_span
        self.alpha = 2 / (ema_span + 1)

        self._prev_bids: List[Tuple[float, float]] | None = None
        self._prev_asks: List[Tuple[float, float]] | None = None
        self._ema = 0.0
        self._history: Deque[float] = deque(maxlen=history_size)
        self._initialized = False

    def update(self, orderbook) -> OFIState:
        bids = [(l.price, l.quantity) for l in orderbook.bids[: self.depth]]
        asks = [(l.price, l.quantity) for l in orderbook.asks[: self.depth]]

        if self._prev_bids is None:
            self._prev_bids = bids
            self._prev_asks = asks
            return OFIState()

        raw_ofi = self._calculate_raw_ofi(bids, asks)

        if not self._initialized:
            self._ema = raw_ofi
            self._initialized = True
        else:
            self._ema = self.alpha * raw_ofi + (1 - self.alpha) * self._ema

        self._history.append(raw_ofi)

        if len(self._history) >= 20:
            std = float(_std(list(self._history)))
            z_score = self._ema / std if std > 0 else 0.0
        else:
            std = 1.0
            z_score = 0.0

        signal = self._get_signal(z_score)

        self._prev_bids = bids
        self._prev_asks = asks

        return OFIState(raw=raw_ofi, ema=self._ema, std=std, z_score=z_score, signal=signal)

    def _calculate_raw_ofi(self, bids, asks) -> float:
        prev_bid_map = {p: q for p, q in (self._prev_bids or [])}
        prev_ask_map = {p: q for p, q in (self._prev_asks or [])}
        curr_bid_map = {p: q for p, q in bids}
        curr_ask_map = {p: q for p, q in asks}

        bid_delta = 0.0
        for price in set(prev_bid_map.keys()) | set(curr_bid_map.keys()):
            bid_delta += curr_bid_map.get(price, 0) - prev_bid_map.get(price, 0)

        ask_delta = 0.0
        for price in set(prev_ask_map.keys()) | set(curr_ask_map.keys()):
            ask_delta += curr_ask_map.get(price, 0) - prev_ask_map.get(price, 0)

        return bid_delta - ask_delta

    def _get_signal(self, z_score: float) -> str:
        if z_score > 2.0:
            return "STRONG_BUY"
        if z_score > 1.0:
            return "BUY"
        if z_score < -2.0:
            return "STRONG_SELL"
        if z_score < -1.0:
            return "SELL"
        return "NEUTRAL"

    def reset(self):
        self._prev_bids = None
        self._prev_asks = None
        self._ema = 0.0
        self._history.clear()
        self._initialized = False

