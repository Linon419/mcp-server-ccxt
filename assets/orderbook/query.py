#!/usr/bin/env python3
"""
OrderBook (Wall Map + OFI) helper CLI.

This is NOT an MCP server. It reads collector outputs from a local data directory:
- latest.json (real-time snapshot written by run_daemon.py)
- orderbook.db (optional history written by run_daemon.py)

It prints a single JSON object to stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional


def _default_data_dir() -> Path:
    env = os.getenv("ORDERBOOK_DATA_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".mcp-server-ccxt" / "orderbook"


def _data_paths(data_dir: Path) -> tuple[Path, Path]:
    data_dir.mkdir(parents=True, exist_ok=True)
    latest = data_dir / "latest.json"
    db = data_dir / "orderbook.db"
    return latest, db


def _load_latest(latest_file: Path) -> Dict[str, Any]:
    if not latest_file.exists():
        return {}
    with latest_file.open("r", encoding="utf-8") as f:
        return json.load(f)


def _load_latest_symbol(latest_file: Path, symbol: str) -> Dict[str, Any]:
    content = _load_latest(latest_file)
    data = content.get("data", {}) if isinstance(content, dict) else {}
    return data.get(symbol.upper(), {}) if isinstance(data, dict) else {}


def _status(latest_file: Path) -> Dict[str, Any]:
    if not latest_file.exists():
        return {
            "status": "OFFLINE",
            "message": "Collector output not found (latest.json missing). Start the collector first.",
        }

    content = _load_latest(latest_file)
    last_update = content.get("timestamp", "")
    data = content.get("data", {})

    age_seconds: Optional[float] = None
    if last_update:
        try:
            last_dt = datetime.fromisoformat(last_update)
            age_seconds = (datetime.now() - last_dt).total_seconds()
        except Exception:
            age_seconds = None

    if age_seconds is not None and age_seconds > 10:
        return {
            "status": "STALE",
            "last_update": last_update,
            "age_seconds": round(age_seconds, 1),
            "symbols": list(data.keys()) if isinstance(data, dict) else [],
            "message": f"latest.json is stale ({age_seconds:.0f}s old). Collector may be stopped.",
        }

    return {
        "status": "ONLINE",
        "last_update": last_update,
        "age_seconds": round(age_seconds, 1) if age_seconds is not None else None,
        "symbols": list(data.keys()) if isinstance(data, dict) else [],
    }


def _get_wall_map(latest_file: Path, symbol: str, timeframe: str) -> Dict[str, Any]:
    sym = _load_latest_symbol(latest_file, symbol)
    if not sym:
        return {"error": f"No data for symbol: {symbol.upper()}"}
    key = f"wall_map_{timeframe}"
    return {
        "symbol": symbol.upper(),
        "timeframe": timeframe,
        "timestamp": sym.get("timestamp"),
        "wall_map": sym.get(key, {}),
    }


def _get_ofi(latest_file: Path, symbol: str) -> Dict[str, Any]:
    sym = _load_latest_symbol(latest_file, symbol)
    if not sym:
        return {"error": f"No data for symbol: {symbol.upper()}"}
    ofi = sym.get("ofi", {}) or {}
    signal = ofi.get("signal", "NEUTRAL")
    return {
        "symbol": symbol.upper(),
        "signal": signal,
        "z_score": round(float(ofi.get("z_score", 0) or 0), 2),
        "ofi": ofi,
    }


def _get_orderbook(latest_file: Path, symbol: str) -> Dict[str, Any]:
    sym = _load_latest_symbol(latest_file, symbol)
    if not sym:
        return {"error": f"No data for symbol: {symbol.upper()}"}
    ob = sym.get("orderbook", {}) or {}
    spread_bps = ob.get("spread_bps", 0) or 0
    return {
        "symbol": symbol.upper(),
        "best_bid": ob.get("best_bid"),
        "best_ask": ob.get("best_ask"),
        "mid_price": ob.get("mid_price"),
        "spread_bps": round(float(spread_bps), 2),
        "timestamp": sym.get("timestamp"),
    }


def _get_real_walls(latest_file: Path, symbol: str, side: str) -> Dict[str, Any]:
    sym = _load_latest_symbol(latest_file, symbol)
    if not sym:
        return {"error": f"No data for symbol: {symbol.upper()}"}

    wall_4h = sym.get("wall_map_4h", {}) or {}
    wall_1h = sym.get("wall_map_1h", {}) or {}

    result: Dict[str, Any] = {"symbol": symbol.upper(), "timestamp": datetime.now().isoformat()}

    if side in ("bid", "both"):
        result["support"] = {
            "strong_4h": (wall_4h.get("bid_walls", []) or [])[:3],
            "moderate_1h": (wall_1h.get("bid_walls", []) or [])[:3],
        }
    if side in ("ask", "both"):
        result["resistance"] = {
            "strong_4h": (wall_4h.get("ask_walls", []) or [])[:3],
            "moderate_1h": (wall_1h.get("ask_walls", []) or [])[:3],
        }
    return result


def _check_signal(latest_file: Path, symbol: str) -> Dict[str, Any]:
    sym = _load_latest_symbol(latest_file, symbol)
    if not sym:
        return {"error": f"No data for symbol: {symbol.upper()}"}

    ofi = sym.get("ofi", {}) or {}
    ob = sym.get("orderbook", {}) or {}
    wall_map = sym.get("wall_map_1h", {}) or {}

    price = float(ob.get("mid_price") or 0)
    ofi_signal = ofi.get("signal", "NEUTRAL")
    z_score = float(ofi.get("z_score") or 0)

    near_support = None
    near_resistance = None

    if price:
        for wall in wall_map.get("bid_walls", []) or []:
            wprice = float(wall.get("price") or 0)
            if wprice and abs(price - wprice) / price < 0.005:
                near_support = wall
                break
        for wall in wall_map.get("ask_walls", []) or []:
            wprice = float(wall.get("price") or 0)
            if wprice and abs(price - wprice) / price < 0.005:
                near_resistance = wall
                break

    signal = "NONE"
    confidence = "LOW"
    reasons = []
    action = None

    if near_support and ofi_signal in ("BUY", "STRONG_BUY"):
        signal = "LONG"
        confidence = "HIGH" if ofi_signal == "STRONG_BUY" else "MEDIUM"
        reasons = [
            f"Price near support wall: {near_support.get('price')}",
            f"OFI buy pressure ({ofi_signal}, z={z_score:.1f})",
            f"Wall persistence_score {near_support.get('persistence_score')}",
        ]
        action = f"Consider long near {near_support.get('price')}"
    elif near_resistance and ofi_signal in ("SELL", "STRONG_SELL"):
        signal = "SHORT"
        confidence = "HIGH" if ofi_signal == "STRONG_SELL" else "MEDIUM"
        reasons = [
            f"Price near resistance wall: {near_resistance.get('price')}",
            f"OFI sell pressure ({ofi_signal}, z={z_score:.1f})",
            f"Wall persistence_score {near_resistance.get('persistence_score')}",
        ]
        action = f"Consider short near {near_resistance.get('price')}"
    elif abs(z_score) > 2:
        signal = "WATCH"
        confidence = "MEDIUM"
        reasons = [f"OFI extreme (z={z_score:.2f}); volatility likely."]
        action = "Watch closely and wait for confirmation"

    return {
        "symbol": symbol.upper(),
        "price": price or None,
        "signal": signal,
        "confidence": confidence,
        "reasons": reasons,
        "action": action,
        "ofi": ofi_signal,
        "z_score": round(z_score, 2),
        "near_support": near_support.get("price") if near_support else None,
        "near_resistance": near_resistance.get("price") if near_resistance else None,
    }


def _get_history(db_path: Path, symbol: str, hours: int) -> Dict[str, Any]:
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        from src.storage import Storage  # type: ignore

        storage = Storage(str(db_path))
        ofi_records = storage.get_recent_ofi(symbol.upper(), limit=max(1, hours * 2))
        wall_snapshots = storage.get_recent_walls(symbol.upper(), "1h", limit=max(1, hours))
        storage.close()

        signal_counts: Dict[str, int] = {}
        for _ts, _raw, _ema, _z, sig in ofi_records:
            signal_counts[sig] = signal_counts.get(sig, 0) + 1

        return {
            "symbol": symbol.upper(),
            "period_hours": hours,
            "ofi_signal_distribution": signal_counts,
            "total_ofi_records": len(ofi_records),
            "total_wall_snapshots": len(wall_snapshots),
        }
    except Exception as e:
        return {"error": str(e)}


def _healthcheck() -> Dict[str, Any]:
    result: Dict[str, Any] = {"python": sys.version}
    try:
        import aiohttp  # noqa: F401

        result["aiohttp"] = "ok"
    except Exception as e:
        result["aiohttp"] = f"missing ({e})"
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default=str(_default_data_dir()), help="Data directory (latest.json + orderbook.db)")

    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("healthcheck")
    sub.add_parser("status")

    p_wall = sub.add_parser("wall-map")
    p_wall.add_argument("--symbol", default="BTCUSDT")
    p_wall.add_argument("--timeframe", default="1h", choices=["4h", "1h", "15min"])

    p_ofi = sub.add_parser("ofi")
    p_ofi.add_argument("--symbol", default="BTCUSDT")

    p_ob = sub.add_parser("orderbook")
    p_ob.add_argument("--symbol", default="BTCUSDT")

    p_real = sub.add_parser("real-walls")
    p_real.add_argument("--symbol", default="BTCUSDT")
    p_real.add_argument("--side", default="both", choices=["bid", "ask", "both"])

    p_sig = sub.add_parser("check-signal")
    p_sig.add_argument("--symbol", default="BTCUSDT")

    p_hist = sub.add_parser("history")
    p_hist.add_argument("--symbol", default="BTCUSDT")
    p_hist.add_argument("--hours", type=int, default=24)

    args = parser.parse_args()
    data_dir = Path(args.data_dir).expanduser()
    latest_file, db_path = _data_paths(data_dir)

    if args.cmd == "healthcheck":
        out = _healthcheck()
    elif args.cmd == "status":
        out = _status(latest_file)
    elif args.cmd == "wall-map":
        out = _get_wall_map(latest_file, args.symbol, args.timeframe)
    elif args.cmd == "ofi":
        out = _get_ofi(latest_file, args.symbol)
    elif args.cmd == "orderbook":
        out = _get_orderbook(latest_file, args.symbol)
    elif args.cmd == "real-walls":
        out = _get_real_walls(latest_file, args.symbol, args.side)
    elif args.cmd == "check-signal":
        out = _check_signal(latest_file, args.symbol)
    elif args.cmd == "history":
        out = _get_history(db_path, args.symbol, int(args.hours))
    else:
        raise RuntimeError("unknown cmd")

    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

