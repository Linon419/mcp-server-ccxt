# EMA21/55/100/200 接入 MCP 设计说明

## 目标

- 在 `mcp-server-ccxt` 内提供可复用的 EMA 计算能力，并通过 MCP Tool 对外暴露。
- 支持常见多周期（默认 `1d/4h/1h/15m`），便于同一交易对做多框架分析。

## 接口设计

- 新增 Public Tool：`ema-multi-series`
  - 入参：`exchange`、`symbol`、`timeframes[]`、`marketType?`、`limit`、`cacheTtlMs`
  - 输出：按 `timeframe` 分组的 EMA 序列数据，序列为 `[[ts, ema21, ema55, ema100, ema200], ...]`
  - 价格源：`close`

## 计算与性能策略

- EMA 采用“先 SMA 初始化，再递推 EMA”的方式：在 `period-1` 之前输出 `null`（序列中为 `NaN`，JSON 序列化为 `null`）。
- 为降低 EMA200 在样本偏短时的偏差，采用 warmup 拉取：
  - 实际拉取 `fetchLimit = min(1000, limit + 700)`
  - 对外返回最后 `limit` 根
- 通过现有 `rateLimiter` 统一限流，并对 `(exchange, marketType, symbol, timeframe, limit, fetchLimit)` 做缓存（默认 `30s`）。

