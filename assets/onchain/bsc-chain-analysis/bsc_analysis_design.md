# BSC 链上买卖量分析程序设计方案

## 1. 目标
开发一个 Python 程序，能够分析 BSC 链上特定代币（如 CAKE）在 PancakeSwap 等 DEX 上的实时或历史买卖量。

## 2. 技术选型
*   **语言**: Python 3.11
*   **库**: `web3.py` (与区块链交互), `requests` (调用 API), `pandas` (数据处理)
*   **数据源**: 
    *   **方案 A (推荐)**: 使用 **Bitquery API**。它直接提供 `buyAmount` 和 `sellAmount` 字段，处理逻辑最简单。
    *   **方案 B (原生)**: 使用 **Web3.py + BSC RPC**。通过监听 PancakeSwap Pair 合约的 `Swap` 事件，根据代币流入流出方向判断买卖。

## 3. 核心逻辑 (以 Web3.py 为例)
对于一个交易对（如 Token/WBNB）：
*   **买入 (Buy)**: 用户转入 WBNB，转出 Token。
    *   `Swap` 事件中：`amountWBNB_In > 0` 且 `amountToken_Out > 0`。
*   **卖出 (Sell)**: 用户转入 Token，转出 WBNB。
    *   `Swap` 事件中：`amountToken_In > 0` 且 `amountWBNB_Out > 0`。

## 4. 程序架构
1.  **配置模块**: 存储 RPC 节点地址、代币合约地址、Pair 合约地址。
2.  **数据获取模块**: 
    *   获取代币的 Pair 地址（通过 Factory 合约）。
    *   获取最新的 `Swap` 日志。
3.  **解析模块**: 将原始日志解析为买/卖动作、金额和价格。
4.  **统计模块**: 汇总特定时间段内的买入总量、卖出总量、净流入等。
5.  **输出模块**: 打印控制台报告或保存为 CSV。

## 5. 待办事项
- [ ] 获取 PancakeSwap V2 Factory 和 Router 地址。
- [ ] 编写获取 Pair 地址的脚本。
- [ ] 编写解析 Swap 事件的脚本。
- [ ] 整合为完整的分析工具。
