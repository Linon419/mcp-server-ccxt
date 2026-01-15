# PancakeSwap V2 Factory ABI (Partial)
FACTORY_ABI = [
    {
        "constant": True,
        "inputs": [
            {"name": "tokenA", "type": "address"},
            {"name": "tokenB", "type": "address"}
        ],
        "name": "getPair",
        "outputs": [{"name": "pair", "type": "address"}],
        "payable": False,
        "stateMutability": "view",
        "type": "function"
    }
]

# PancakeSwap V2 Pair ABI (Partial)
PAIR_ABI = [
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True, "name": "sender", "type": "address"},
            {"indexed": False, "name": "amount0In", "type": "uint256"},
            {"indexed": False, "name": "amount1In", "type": "uint256"},
            {"indexed": False, "name": "amount0Out", "type": "uint256"},
            {"indexed": False, "name": "amount1Out", "type": "uint256"},
            {"indexed": True, "name": "to", "type": "address"}
        ],
        "name": "Swap",
        "type": "event"
    },
    {
        "constant": True,
        "inputs": [],
        "name": "token0",
        "outputs": [{"name": "", "type": "address"}],
        "payable": False,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": True,
        "inputs": [],
        "name": "token1",
        "outputs": [{"name": "", "type": "address"}],
        "payable": False,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": True,
        "inputs": [],
        "name": "getReserves",
        "outputs": [
            {"name": "reserve0", "type": "uint112"},
            {"name": "reserve1", "type": "uint112"},
            {"name": "blockTimestampLast", "type": "uint32"}
        ],
        "payable": False,
        "stateMutability": "view",
        "type": "function"
    }
]

# ERC20 ABI (Partial)
ERC20_ABI = [
    {
        "constant": True,
        "inputs": [],
        "name": "symbol",
        "outputs": [{"name": "", "type": "string"}],
        "payable": False,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": True,
        "inputs": [],
        "name": "decimals",
        "outputs": [{"name": "", "type": "uint8"}],
        "payable": False,
        "stateMutability": "view",
        "type": "function"
    }
]
