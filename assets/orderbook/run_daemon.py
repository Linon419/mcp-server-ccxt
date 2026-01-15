#!/usr/bin/env python3
"""
OrderBook collector daemon.

Continuously collects Binance futures orderbook updates, tracks walls and OFI,
and writes:
- latest.json (for near-real-time reads)
- orderbook.db (optional history)

Default output dir:
  ~/.mcp-server-ccxt/orderbook

Override via:
  ORDERBOOK_DATA_DIR=/path/to/dir
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
from datetime import datetime
from pathlib import Path
from typing import Dict, List


def _default_data_dir() -> Path:
    env = os.getenv("ORDERBOOK_DATA_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".mcp-server-ccxt" / "orderbook"


def _parse_symbols(raw: str) -> List[str]:
    symbols = [s.strip().upper() for s in (raw or "").split(",") if s.strip()]
    return symbols or ["BTCUSDT"]


def _parse_thresholds(raw: str) -> Dict[str, float]:
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
        if not isinstance(obj, dict):
            return {}
        out: Dict[str, float] = {}
        for k, v in obj.items():
            out[str(k).upper()] = float(v)
        return out
    except Exception:
        return {}


class DaemonCollector:
    def __init__(
        self,
        data_dir: Path,
        symbols: List[str],
        thresholds: Dict[str, float],
        write_interval_sec: float = 2.0,
        ofi_interval_sec: float = 30.0,
        wall_snapshot_interval_sec: float = 300.0,
    ):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)

        self.latest_file = self.data_dir / "latest.json"
        self.db_path = self.data_dir / "orderbook.db"

        import sys

        sys.path.insert(0, str(Path(__file__).parent))
        from src.collector import DataCollector  # type: ignore
        from src.storage import Storage  # type: ignore

        self.storage = Storage(str(self.db_path))
        self.collector = DataCollector(symbols, thresholds)

        self.symbols = symbols
        self.thresholds = thresholds

        self.write_interval_sec = write_interval_sec
        self.ofi_interval_sec = ofi_interval_sec
        self.wall_snapshot_interval_sec = wall_snapshot_interval_sec

        self._last_write_ts = 0.0
        self._last_ofi_ts = 0.0
        self._last_wall_ts = 0.0

        self.latest_data = {}

    def _save_latest(self):
        payload = {"timestamp": datetime.now().isoformat(), "data": self.latest_data}
        tmp = self.latest_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.latest_file)

    async def on_update(self, data: dict):
        symbol = str(data.get("symbol", "")).upper()
        if not symbol:
            return

        self.latest_data[symbol] = data

        now_ts = datetime.now().timestamp()

        if now_ts - self._last_write_ts >= self.write_interval_sec:
            self._save_latest()
            self._last_write_ts = now_ts

        if now_ts - self._last_ofi_ts >= self.ofi_interval_sec:
            self.storage.save_ofi(symbol, data.get("ofi", {}))
            self._last_ofi_ts = now_ts

        if now_ts - self._last_wall_ts >= self.wall_snapshot_interval_sec:
            self.storage.save_wall_snapshot(symbol, "4h", data.get("wall_map_4h", {}))
            self.storage.save_wall_snapshot(symbol, "1h", data.get("wall_map_1h", {}))
            self.storage.save_wall_snapshot(symbol, "15min", data.get("wall_map_15min", {}))
            self._last_wall_ts = now_ts

    async def start(self):
        self.collector.on_update(self.on_update)
        print("=" * 60)
        print("OrderBook collector started")
        print(f"data_dir: {self.data_dir}")
        print(f"symbols: {', '.join(self.symbols)}")
        if self.thresholds:
            print(f"thresholds: {self.thresholds}")
        print("=" * 60)
        await self.collector.start()

    def stop(self):
        self.collector.stop()
        try:
            self.storage.close()
        except Exception:
            pass


async def _main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default=str(_default_data_dir()))
    parser.add_argument("--symbols", default=os.getenv("ORDERBOOK_SYMBOLS", "BTCUSDT"))
    parser.add_argument("--thresholds-json", default=os.getenv("ORDERBOOK_THRESHOLDS_JSON", ""))
    parser.add_argument("--write-interval-sec", type=float, default=float(os.getenv("ORDERBOOK_WRITE_INTERVAL_SEC", "2")))
    parser.add_argument("--ofi-interval-sec", type=float, default=float(os.getenv("ORDERBOOK_OFI_INTERVAL_SEC", "30")))
    parser.add_argument(
        "--wall-snapshot-interval-sec",
        type=float,
        default=float(os.getenv("ORDERBOOK_WALL_SNAPSHOT_INTERVAL_SEC", "300")),
    )

    args = parser.parse_args()
    data_dir = Path(args.data_dir).expanduser()
    symbols = _parse_symbols(args.symbols)
    thresholds = _parse_thresholds(args.thresholds_json)

    daemon = DaemonCollector(
        data_dir=data_dir,
        symbols=symbols,
        thresholds=thresholds,
        write_interval_sec=args.write_interval_sec,
        ofi_interval_sec=args.ofi_interval_sec,
        wall_snapshot_interval_sec=args.wall_snapshot_interval_sec,
    )

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, daemon.stop)
        except NotImplementedError:
            pass

    await daemon.start()
    return 0


def main() -> int:
    return asyncio.run(_main())


if __name__ == "__main__":
    raise SystemExit(main())

