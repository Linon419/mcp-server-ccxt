#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import json
import os
import time
from typing import Any, Dict

from web3 import Web3

from abis import FACTORY_ABI, PAIR_ABI, ERC20_ABI


DEFAULT_BSC_RPC = os.environ.get("BSC_RPC_URL", "https://binance.llamarpc.com")
DEFAULT_FACTORY_ADDRESS = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"  # PancakeSwap V2 Factory
DEFAULT_WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
MAX_RPC_ERRORS = 50
MAX_FAILED_RANGES = 50


def _as_checksum(w3: Web3, address: str) -> str:
    return w3.to_checksum_address(address)


def _safe_float(x: Any) -> float:
    try:
        return float(x)
    except Exception:
        return 0.0


def analyze_volume(
    token_address: str,
    blocks_back: int,
    rpc_url: str,
    factory_address: str,
    wbnb_address: str,
    chunk_size: int,
) -> Dict[str, Any]:
    started = time.time()
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    if not w3.is_connected():
        raise Exception("无法连接到 BSC RPC 节点")

    factory = w3.eth.contract(address=_as_checksum(w3, factory_address), abi=FACTORY_ABI)

    token_checksum = _as_checksum(w3, token_address)
    wbnb_checksum = _as_checksum(w3, wbnb_address)

    pair_address = factory.functions.getPair(token_checksum, wbnb_checksum).call()
    if int(pair_address, 16) == 0:
        return {
            "ok": False,
            "error": "未找到该代币与 WBNB 的交易对",
            "tokenAddress": token_address,
            "pairAddress": pair_address,
        }

    pair_contract = w3.eth.contract(address=_as_checksum(w3, pair_address), abi=PAIR_ABI)
    token0 = pair_contract.functions.token0().call()
    token1 = pair_contract.functions.token1().call()

    token_contract = w3.eth.contract(address=token_checksum, abi=ERC20_ABI)
    symbol = token_contract.functions.symbol().call()
    decimals = int(token_contract.functions.decimals().call())

    is_token0 = token_checksum.lower() == token0.lower()

    latest_block = int(w3.eth.block_number)
    start_block = max(0, latest_block - int(blocks_back))

    logs = []
    rpc_errors = []
    failed_ranges = []
    suppressed_rpc_errors = 0
    suppressed_failed_ranges = 0
    for i in range(start_block, latest_block + 1, int(chunk_size)):
        end = min(i + int(chunk_size) - 1, latest_block)
        attempt = 0
        backoff = 0.6
        while True:
            try:
                chunk_logs = pair_contract.events.Swap().get_logs(from_block=i, to_block=end)
                logs.extend(chunk_logs)
                break
            except Exception as e:
                attempt += 1
                if len(rpc_errors) < MAX_RPC_ERRORS:
                    rpc_errors.append({"fromBlock": i, "toBlock": end, "attempt": attempt, "error": str(e)})
                else:
                    suppressed_rpc_errors += 1
                if attempt >= 4:
                    if len(failed_ranges) < MAX_FAILED_RANGES:
                        failed_ranges.append({"fromBlock": i, "toBlock": end})
                    else:
                        suppressed_failed_ranges += 1
                    break
                time.sleep(backoff)
                backoff = min(8.0, backoff * 2.0)

    buys = 0
    sells = 0
    buy_volume = 0.0
    sell_volume = 0.0
    buy_volume_bnb = 0.0
    sell_volume_bnb = 0.0

    for log in logs:
        args = log["args"]
        if is_token0:
            token_amount_in = _safe_float(args["amount0In"]) / (10**decimals)
            token_amount_out = _safe_float(args["amount0Out"]) / (10**decimals)
            bnb_amount_in = _safe_float(args["amount1In"]) / (10**18)
            bnb_amount_out = _safe_float(args["amount1Out"]) / (10**18)
        else:
            token_amount_in = _safe_float(args["amount1In"]) / (10**decimals)
            token_amount_out = _safe_float(args["amount1Out"]) / (10**decimals)
            bnb_amount_in = _safe_float(args["amount0In"]) / (10**18)
            bnb_amount_out = _safe_float(args["amount0Out"]) / (10**18)

        if token_amount_out > 0:
            buys += 1
            buy_volume += token_amount_out
            buy_volume_bnb += bnb_amount_in
        elif token_amount_in > 0:
            sells += 1
            sell_volume += token_amount_in
            sell_volume_bnb += bnb_amount_out

    reserves = pair_contract.functions.getReserves().call()
    if is_token0:
        price_in_bnb = (reserves[1] / 10**18) / (reserves[0] / 10**decimals)
    else:
        price_in_bnb = (reserves[0] / 10**18) / (reserves[1] / 10**decimals)

    total_bnb = buy_volume_bnb + sell_volume_bnb
    buy_ratio = (buy_volume_bnb / total_bnb) * 100 if total_bnb > 0 else 0.0

    elapsed_ms = int((time.time() - started) * 1000)

    return {
        "ok": True,
        "tokenAddress": token_address,
        "symbol": symbol,
        "decimals": decimals,
        "pairAddress": pair_address,
        "token0": token0,
        "token1": token1,
        "startBlock": start_block,
        "endBlock": latest_block,
        "blocksBack": int(blocks_back),
        "priceInBNB": price_in_bnb,
        "buys": buys,
        "sells": sells,
        "buyVolumeToken": buy_volume,
        "sellVolumeToken": sell_volume,
        "buyVolumeBNB": buy_volume_bnb,
        "sellVolumeBNB": sell_volume_bnb,
        "netInflowBNB": buy_volume_bnb - sell_volume_bnb,
        "buyRatioBNB": buy_ratio,
        "rpcUrl": rpc_url,
        "logCount": len(logs),
        "failedRanges": failed_ranges,
        "failedRangeCount": len(failed_ranges) + suppressed_failed_ranges,
        "failedRangesTruncated": suppressed_failed_ranges > 0,
        "rpcErrors": rpc_errors,
        "rpcErrorCount": len(rpc_errors) + suppressed_rpc_errors,
        "rpcErrorsTruncated": suppressed_rpc_errors > 0,
        "elapsedMs": elapsed_ms,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="BSC Volume Analyzer (MCP CLI)")
    parser.add_argument("--token", required=True, help="Token contract address (0x...)")
    parser.add_argument("--blocks-back", type=int, default=1000, help="How many blocks back to analyze")
    parser.add_argument("--rpc", default=DEFAULT_BSC_RPC, help="BSC RPC URL")
    parser.add_argument("--factory", default=DEFAULT_FACTORY_ADDRESS, help="PancakeSwap V2 factory address")
    parser.add_argument("--wbnb", default=DEFAULT_WBNB_ADDRESS, help="WBNB address")
    parser.add_argument("--chunk-size", type=int, default=100, help="Log query chunk size (blocks)")

    args = parser.parse_args()
    result = analyze_volume(
        token_address=args.token,
        blocks_back=args.blocks_back,
        rpc_url=args.rpc,
        factory_address=args.factory,
        wbnb_address=args.wbnb,
        chunk_size=args.chunk_size,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
