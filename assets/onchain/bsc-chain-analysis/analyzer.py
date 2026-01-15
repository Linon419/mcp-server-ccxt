import time
import pandas as pd
from web3 import Web3
from abis import FACTORY_ABI, PAIR_ABI, ERC20_ABI

# 配置
BSC_RPC = "https://binance.llamarpc.com"
FACTORY_ADDRESS = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"
WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"

class BSCVolumeAnalyzer:
    def __init__(self, rpc_url):
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        if not self.w3.is_connected():
            raise Exception("无法连接到 BSC 节点")
        self.factory = self.w3.eth.contract(address=FACTORY_ADDRESS, abi=FACTORY_ABI)

    def get_pair_address(self, token_address):
        pair_address = self.factory.functions.getPair(token_address, WBNB_ADDRESS).call()
        return pair_address

    def get_token_info(self, token_address):
        contract = self.w3.eth.contract(address=token_address, abi=ERC20_ABI)
        symbol = contract.functions.symbol().call()
        decimals = contract.functions.decimals().call()
        return symbol, decimals

    def analyze_volume(self, token_address, blocks_back=1000):
        pair_address = self.get_pair_address(token_address)
        if pair_address == "0x0000000000000000000000000000000000000000":
            print("未找到该代币与 WBNB 的交易对")
            return

        pair_contract = self.w3.eth.contract(address=pair_address, abi=PAIR_ABI)
        token0 = pair_contract.functions.token0().call()
        token1 = pair_contract.functions.token1().call()
        
        symbol, decimals = self.get_token_info(token_address)
        is_token0 = (token_address.lower() == token0.lower())

        latest_block = self.w3.eth.block_number
        start_block = latest_block - blocks_back

        print(f"正在分析 {symbol} 在过去 {blocks_back} 个区块内的交易 (从 {start_block} 到 {latest_block})...")

        # 分批获取 Swap 事件以避免 RPC 限制
        logs = []
        chunk_size = 100
        for i in range(start_block, latest_block, chunk_size):
            end = min(i + chunk_size - 1, latest_block)
            try:
                chunk_logs = pair_contract.events.Swap().get_logs(from_block=i, to_block=end)
                logs.extend(chunk_logs)
            except Exception as e:
                print(f"获取区块 {i} 到 {end} 的日志失败: {e}")

        buys = 0
        sells = 0
        buy_volume = 0.0
        sell_volume = 0.0
        buy_volume_bnb = 0.0
        sell_volume_bnb = 0.0

        for log in logs:
            args = log['args']
            if is_token0:
                # Token 是 token0, WBNB 是 token1
                token_amount_in = args['amount0In'] / (10**decimals)
                token_amount_out = args['amount0Out'] / (10**decimals)
                bnb_amount_in = args['amount1In'] / (10**18)
                bnb_amount_out = args['amount1Out'] / (10**18)
            else:
                # Token 是 token1, WBNB 是 token0
                token_amount_in = args['amount1In'] / (10**decimals)
                token_amount_out = args['amount1Out'] / (10**decimals)
                bnb_amount_in = args['amount0In'] / (10**18)
                bnb_amount_out = args['amount0Out'] / (10**18)

            if token_amount_out > 0:
                # 用户收到 Token -> 买入 (用户支付了 BNB)
                buys += 1
                buy_volume += token_amount_out
                buy_volume_bnb += bnb_amount_in
            elif token_amount_in > 0:
                # 用户发送 Token -> 卖出 (用户收到了 BNB)
                sells += 1
                sell_volume += token_amount_in
                sell_volume_bnb += bnb_amount_out

        # 获取当前价格
        reserves = pair_contract.functions.getReserves().call()
        if is_token0:
            price_in_bnb = (reserves[1] / 10**18) / (reserves[0] / 10**decimals)
        else:
            price_in_bnb = (reserves[0] / 10**18) / (reserves[1] / 10**decimals)

        print(f"\n--- 分析结果 ({symbol}) ---")
        print(f"当前价格: {price_in_bnb:.8f} BNB")
        print(f"买入次数: {buys}")
        print(f"卖出次数: {sells}")
        print(f"买入总量: {buy_volume:.4f} {symbol} ({buy_volume_bnb:.4f} BNB)")
        print(f"卖出总量: {sell_volume:.4f} {symbol} ({sell_volume_bnb:.4f} BNB)")
        print(f"净流入量: {(buy_volume_bnb - sell_volume_bnb):.4f} BNB")
        
        if buy_volume_bnb + sell_volume_bnb > 0:
            buy_ratio = (buy_volume_bnb / (buy_volume_bnb + sell_volume_bnb)) * 100
            print(f"买入占比 (按 BNB 计算): {buy_ratio:.2f}%")

if __name__ == "__main__":
    # 示例：分析 CAKE 代币
    CAKE_ADDRESS = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"
    analyzer = BSCVolumeAnalyzer(BSC_RPC)
    analyzer.analyze_volume(CAKE_ADDRESS, blocks_back=1000)
