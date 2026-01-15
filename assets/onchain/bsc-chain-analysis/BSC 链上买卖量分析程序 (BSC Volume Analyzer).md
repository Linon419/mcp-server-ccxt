# BSC 链上买卖量分析程序 (BSC Volume Analyzer)

这是一个基于 Python 的 BSC 链上数据分析工具，专门用于分析 PancakeSwap V2 上的代币买卖量。

## 功能特点
- **实时价格获取**: 直接从流动性池获取代币对 BNB 的价格。
- **买卖量统计**: 自动解析 `Swap` 事件，区分买入和卖出行为。
- **多维度分析**: 提供买卖次数、代币总量、BNB 总量以及买入占比等数据。
- **分批查询**: 针对公共 RPC 节点的限制，实现了分批获取日志的逻辑，确保稳定性。

## 核心逻辑说明
程序通过监听 PancakeSwap Pair 合约的 `Swap` 事件来判断交易方向：
- **买入 (Buy)**: 用户将 BNB 存入池中，换取目标代币。
- **卖出 (Sell)**: 用户将目标代币存入池中，换取 BNB。

## 使用方法
1. **安装依赖**:
   ```bash
   pip install web3 pandas
   ```
2. **配置参数**:
   在 `analyzer.py` 中修改 `CAKE_ADDRESS` 为你想要分析的代币合约地址。
3. **运行程序**:
   ```bash
   python analyzer.py
   ```

## 文件结构
- `analyzer.py`: 主程序逻辑。
- `abis.py`: 包含 Factory, Pair 和 ERC20 的 ABI 定义。
- `README.md`: 项目说明文档。

## 注意事项
- 本程序默认使用公共 RPC 节点 (`binance.llamarpc.com`)。如果需要更高频率或更大范围的数据分析，建议使用私有 RPC 节点（如 QuickNode, Ankr 等）。
- 目前仅支持 PancakeSwap V2 交易对。
