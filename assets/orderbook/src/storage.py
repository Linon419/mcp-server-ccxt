"""
SQLite storage for snapshots and OFI history.
"""

import json
import sqlite3
from pathlib import Path


class Storage:
    def __init__(self, db_path: str = "data/orderbook.db"):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self._init_tables()

    def _init_tables(self):
        cursor = self.conn.cursor()
        cursor.executescript(
            """
            CREATE TABLE IF NOT EXISTS wall_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                timeframe TEXT NOT NULL,
                data JSON NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_wall_symbol_time
                ON wall_snapshots(symbol, timestamp);

            CREATE TABLE IF NOT EXISTS ofi_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                raw REAL,
                ema REAL,
                z_score REAL,
                signal TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_ofi_symbol_time
                ON ofi_history(symbol, timestamp);

            CREATE TABLE IF NOT EXISTS signal_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
               timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                signal_type TEXT NOT NULL,
                price REAL,
                details JSON
            );
            CREATE INDEX IF NOT EXISTS idx_signal_symbol_time
                ON signal_log(symbol, timestamp);
            """
        )
        self.conn.commit()

    def save_wall_snapshot(self, symbol: str, timeframe: str, data: dict):
        cursor = self.conn.cursor()
        cursor.execute(
            "INSERT INTO wall_snapshots (symbol, timeframe, data) VALUES (?, ?, ?)",
            (symbol, timeframe, json.dumps(data)),
        )
        self.conn.commit()

    def save_ofi(self, symbol: str, ofi_state):
        cursor = self.conn.cursor()
        raw = ofi_state.raw if hasattr(ofi_state, "raw") else ofi_state.get("raw", 0)
        ema = ofi_state.ema if hasattr(ofi_state, "ema") else ofi_state.get("ema", 0)
        z_score = ofi_state.z_score if hasattr(ofi_state, "z_score") else ofi_state.get("z_score", 0)
        signal = ofi_state.signal if hasattr(ofi_state, "signal") else ofi_state.get("signal", "NEUTRAL")

        cursor.execute(
            "INSERT INTO ofi_history (symbol, raw, ema, z_score, signal) VALUES (?, ?, ?, ?, ?)",
            (symbol, raw, ema, z_score, signal),
        )
        self.conn.commit()

    def log_signal(self, symbol: str, signal_type: str, price: float, details: dict):
        cursor = self.conn.cursor()
        cursor.execute(
            "INSERT INTO signal_log (symbol, signal_type, price, details) VALUES (?, ?, ?, ?)",
            (symbol, signal_type, price, json.dumps(details)),
        )
        self.conn.commit()

    def get_recent_walls(self, symbol: str, timeframe: str, limit: int = 100):
        cursor = self.conn.cursor()
        cursor.execute(
            """
            SELECT timestamp, data FROM wall_snapshots
            WHERE symbol = ? AND timeframe = ?
            ORDER BY timestamp DESC LIMIT ?
            """,
            (symbol, timeframe, limit),
        )
        return cursor.fetchall()

    def get_recent_ofi(self, symbol: str, limit: int = 100):
        cursor = self.conn.cursor()
        cursor.execute(
            """
            SELECT timestamp, raw, ema, z_score, signal FROM ofi_history
            WHERE symbol = ?
            ORDER BY timestamp DESC LIMIT ?
            """,
            (symbol, limit),
        )
        return cursor.fetchall()

    def close(self):
        self.conn.close()

