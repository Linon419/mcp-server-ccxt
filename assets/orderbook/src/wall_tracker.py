"""
Wall Map tracker.
Tracks large orderbook levels ("walls") and their lifecycle.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Tuple
import time


WALL_PARAMS = {
    "4h": {"min_age_minutes": 120, "min_persistence": 150, "influence_zone_pct": 0.005},
    "1h": {"min_age_minutes": 30, "min_persistence": 40, "influence_zone_pct": 0.003},
    "15min": {"min_age_minutes": 10, "min_persistence": 15, "influence_zone_pct": 0.0015},
}


class WallSide(Enum):
    BID = "bid"
    ASK = "ask"


@dataclass
class Wall:
    price: float
    side: WallSide
    initial_qty: float
    current_qty: float
    first_seen: float
    last_seen: float
    replenish_count: int = 0
    test_count: int = 0
    peak_qty: float = 0

    def __post_init__(self):
        self.peak_qty = max(self.peak_qty, self.initial_qty)

    @property
    def age_minutes(self) -> float:
        return (time.time() - self.first_seen) / 60

    @property
    def notional(self) -> float:
        return self.price * self.current_qty

    @property
    def health(self) -> float:
        if self.peak_qty == 0:
            return 0
        return min(1.0, self.current_qty / self.peak_qty)

    @property
    def persistence_score(self) -> float:
        if self.test_count == 0:
            return self.age_minutes * 0.5
        replenish_ratio = self.replenish_count / max(1, self.test_count)
        return self.age_minutes * (1 + replenish_ratio)

    def is_real(self, timeframe: str) -> bool:
        params = WALL_PARAMS.get(timeframe, WALL_PARAMS["1h"])
        return self.age_minutes >= params["min_age_minutes"] and self.persistence_score >= params["min_persistence"]

    def to_dict(self) -> dict:
        return {
            "price": self.price,
            "side": self.side.value,
            "current_qty": self.current_qty,
            "notional": self.notional,
            "age_minutes": round(self.age_minutes, 1),
            "persistence_score": round(self.persistence_score, 1),
            "health": round(self.health, 2),
            "replenish_count": self.replenish_count,
            "test_count": self.test_count,
        }


class WallTracker:
    def __init__(self, symbol: str, threshold_usd: float = 200_000):
        self.symbol = symbol
        self.threshold = threshold_usd
        self.walls: Dict[Tuple[float, WallSide], Wall] = {}

    def update(self, orderbook) -> List[dict]:
        events: List[dict] = []
        current_price = orderbook.mid_price

        events.extend(self._process_side(orderbook.bids, WallSide.BID, current_price))
        events.extend(self._process_side(orderbook.asks, WallSide.ASK, current_price))
        events.extend(self._cleanup_dead_walls(orderbook))

        return events

    def _process_side(self, levels: List, side: WallSide, current_price: float) -> List[dict]:
        events: List[dict] = []

        for level in levels:
            price = level.price
            qty = level.quantity
            notional = level.notional
            key = (price, side)

            if notional >= self.threshold:
                if key in self.walls:
                    wall = self.walls[key]
                    old_qty = wall.current_qty

                    if qty > old_qty * 1.2:
                        wall.replenish_count += 1
                        events.append({"type": "WALL_REPLENISH", "wall": wall.to_dict()})

                    if current_price:
                        distance = abs(current_price - price) / price
                        if distance < 0.003:
                            wall.test_count += 1

                    wall.current_qty = qty
                    wall.peak_qty = max(wall.peak_qty, qty)
                    wall.last_seen = time.time()
                else:
                    wall = Wall(
                        price=price,
                        side=side,
                        initial_qty=qty,
                        current_qty=qty,
                        first_seen=time.time(),
                        last_seen=time.time(),
                    )
                    self.walls[key] = wall
                    events.append({"type": "NEW_WALL", "wall": wall.to_dict()})

        return events

    def _cleanup_dead_walls(self, orderbook) -> List[dict]:
        events: List[dict] = []
        all_prices = {(l.price, WallSide.BID) for l in orderbook.bids} | {(l.price, WallSide.ASK) for l in orderbook.asks}

        dead_keys: List[Tuple[float, WallSide]] = []
        for key, wall in self.walls.items():
            if key not in all_prices:
                events.append(
                    {
                        "type": "WALL_REMOVED",
                        "wall": wall.to_dict(),
                        "reason": "consumed" if wall.test_count > 0 else "cancelled",
                    }
                )
                dead_keys.append(key)

        for key in dead_keys:
            del self.walls[key]

        return events

    def get_real_walls(self, timeframe: str = "1h") -> List[Wall]:
        return [w for w in self.walls.values() if w.is_real(timeframe)]

    def get_wall_map(self, timeframe: str = "1h") -> dict:
        real_walls = self.get_real_walls(timeframe)

        bid_walls = sorted([w for w in real_walls if w.side == WallSide.BID], key=lambda w: w.persistence_score, reverse=True)
        ask_walls = sorted([w for w in real_walls if w.side == WallSide.ASK], key=lambda w: w.persistence_score, reverse=True)

        return {
            "timeframe": timeframe,
            "timestamp": time.time(),
            "bid_walls": [w.to_dict() for w in bid_walls[:5]],
            "ask_walls": [w.to_dict() for w in ask_walls[:5]],
            "total_bid_walls": len(bid_walls),
            "total_ask_walls": len(ask_walls),
        }

