# 🤖 NFT Auto-Mint Bot

Automatically detects mint time and fires transactions **instantly** at the exact millisecond — beating manual minters every time. Works with any OpenSea collection on any chain.

---

## ✨ Features

- 🔗 **Just paste any OpenSea URL** — no manual contract hunting
- ⏰ **Auto-detects mint time** from OpenSea API, contract, or manual override
- 🎯 **10ms precision firing** — busy-waits final milliseconds for exact timing
- ⚡ **Zero pre-checks at mint time** — fires instantly, no wasted seconds
- ⛽ **3x gas boost** — priority block inclusion over other minters
- 👛 **Multi-wallet** — fires up to 5 wallets simultaneously
- 🔎 **Auto-fetches real ABI** from block explorer API
- 🌊 **SeaDrop support** — handles OpenSea native drop contracts
- ⛓️ **Multi-chain** — Ethereum, Base, Polygon, Arbitrum, Optimism, Avalanche
- 🔁 **Auto-retry** — retries every 2 seconds on failure

---

## 📋 Requirements

- [Node.js](https://nodejs.org/) v18+
- ETH in your wallet(s) for gas
- Free RPC from [Alchemy](https://alchemy.com) or [Infura](https://infura.io)
- Free [Etherscan API key](https://etherscan.io/apis)
- Free [OpenSea API key](https://docs.opensea.io/reference/api-overview) *(recommended)*

---

## 🚀 Setup (One Time Only)

### 1. Clone the repo
```bash
git clone https://github.com/HusseinAdeiza/nft-auto-mint.git
cd nft-auto-mint
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure your .env
```bash
cp .env.example .env
nano .env
```

Fill in:
```env
# ── REQUIRED ──────────────────────────────────────
PRIVATE_KEY=your_wallet_private_key

# ── MULTI-WALLET (optional, up to 5) ──────────────
PRIVATE_KEY_2=second_wallet_key
PRIVATE_KEY_3=third_wallet_key
PRIVATE_KEY_4=fourth_wallet_key
PRIVATE_KEY_5=fifth_wallet_key

# ── RPC ENDPOINTS ─────────────────────────────────
RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
RPC_URL_BASE=https://mainnet.base.org
RPC_URL_ARBITRUM=https://arb1.arbitrum.io/rpc
RPC_URL_POLYGON=https://polygon-rpc.com
RPC_URL_OPTIMISM=https://mainnet.optimism.io

# ── API KEYS ──────────────────────────────────────
ETHERSCAN_API_KEY=your_etherscan_key
ARBISCAN_API_KEY=your_etherscan_key
BASESCAN_API_KEY=your_etherscan_key
OPENSEA_API_KEY=your_opensea_key

# ── BOT SETTINGS ──────────────────────────────────
MINT_AMOUNT=1
MAX_GAS_GWEI=500
MINT_VALUE_ETH=0.0
RETRY_DELAY=2000
CHECK_INTERVAL=2000
MAX_RETRIES=30
MINT_ONCE=true
MIN_BALANCE_ETH=0.00001
```

---

## 🎯 How to Mint

### Simple — paste any OpenSea URL:
```bash
node index.js https://opensea.io/collection/COLLECTION-SLUG/overview
```

### Free mint with auto time detection:
```bash
MINT_VALUE_ETH=0.0 MINT_AMOUNT=1 node index.js https://opensea.io/collection/COLLECTION-SLUG/overview
```

### Paid mint:
```bash
MINT_VALUE_ETH=0.001 MINT_AMOUNT=2 node index.js https://opensea.io/collection/COLLECTION-SLUG/overview
```

### Manual mint time override (when auto-detection fails):
```bash
MINT_START_TIME=2026-06-01T14:00:00Z MINT_VALUE_ETH=0.0 MINT_AMOUNT=1 node index.js https://opensea.io/collection/COLLECTION-SLUG/overview
```

### Full competitive settings:
```bash
MINT_START_TIME=2026-06-01T14:00:00Z \
MINT_VALUE_ETH=0.0 \
MINT_AMOUNT=1 \
MAX_RETRIES=30 \
RETRY_DELAY=2000 \
MAX_GAS_GWEI=500 \
node index.js https://opensea.io/collection/COLLECTION-SLUG/overview
```

### Run in background on VPS (recommended):
```bash
nohup bash -c 'MINT_START_TIME=2026-06-01T14:00:00Z MINT_VALUE_ETH=0.0 MINT_AMOUNT=1 node index.js https://opensea.io/collection/COLLECTION-SLUG/overview' > mint.log 2>&1 &

# Watch live output:
tail -f mint.log

# Stop the bot:
pkill -f "node index.js"
```

### OpenSea API unreachable (bypass mode):
```bash
node -e "
require('dotenv').config();
const { startMintBot } = require('./src/minter');
startMintBot({
  name: 'Collection Name',
  contractAddress: '0xYOUR_CONTRACT_ADDRESS',
  chain: 'ethereum',
  rpcUrl: process.env.RPC_URL,
  openseaUrl: 'https://opensea.io/collection/SLUG',
  mintStartTime: '2026-06-01T14:00:00Z',
  mintStage: 'Public',
  scheduleSource: 'manual'
});
"
```

---

## ⏰ How Mint Time Works

The bot detects mint time automatically in this order:

| Priority | Source | How |
|---|---|---|
| 1st | OpenSea API | Fetches drop schedule automatically |
| 2nd | Manual `.env` | Set `MINT_START_TIME=2026-06-01T14:00:00Z` |
| 3rd | Contract | Reads `startTime()` on-chain |
| 4th | Immediate | Mints instantly if no time found |

> **Time format:** Always use UTC — e.g. 4:00 PM GMT+1 = `2026-06-01T15:00:00Z`

---

## ⚙️ All Settings

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | required | Main wallet private key |
| `PRIVATE_KEY_2` to `5` | optional | Extra wallets — all fire at once |
| `RPC_URL` | required | Ethereum RPC endpoint |
| `MINT_START_TIME` | auto | UTC time e.g. `2026-06-01T14:00:00Z` |
| `MINT_VALUE_ETH` | `0.0` | ETH cost per mint (0.0 for free mints) |
| `MINT_AMOUNT` | `1` | How many NFTs to mint per wallet |
| `MAX_GAS_GWEI` | `500` | Max gas — set high to never miss a mint |
| `RETRY_DELAY` | `2000` | Milliseconds between retries (2000 = 2s) |
| `MAX_RETRIES` | `30` | Max attempts before giving up |
| `MIN_BALANCE_ETH` | `0.00001` | Skip wallet if balance too low |
| `MINT_ONCE` | `true` | Stop after first successful mint |

---

## 🌐 Supported Chains

| Chain | Set in .env |
|---|---|
| Ethereum | `RPC_URL` |
| Base | `RPC_URL_BASE` |
| Arbitrum | `RPC_URL_ARBITRUM` |
| Polygon | `RPC_URL_POLYGON` |
| Optimism | `RPC_URL_OPTIMISM` |
| Avalanche | `RPC_URL_AVALANCHE` |

---

## 💡 Pro Tips

- ✅ **Top up ALL wallets** before mint time — even free mints need gas
- ✅ **Run on VPS + laptop** simultaneously for maximum coverage
- ✅ **Use `screen` or `nohup`** on VPS to prevent disconnection
- ✅ **Set `MAX_GAS_GWEI=500`** to never be blocked by gas limits
- ✅ **Get Etherscan API key** — without it the bot uses fallback ABI
- ✅ **Convert time to UTC** before setting `MINT_START_TIME`
- ✅ **Check wallet eligibility** on OpenSea before running the bot
- ✅ **For Base/Arbitrum mints** make sure wallet has ETH on that chain

---

## 📁 Project Structure
nft-auto-mint/
├── index.js          # Entry point — URL input & startup
├── src/
│   ├── opensea.js    # URL parser, OpenSea API, mint schedule
│   ├── minter.js     # Precision timing, multi-wallet, ABI, minting
│   └── utils.js      # Logging, sleep, env validation
├── .env.example      # Template — copy to .env and fill in
├── .gitignore        # Keeps .env and private keys out of git
└── package.json

---

## ⚠️ Disclaimer

This tool is for minting NFTs you are legitimately eligible for. Always verify contract addresses. Never share your `.env` or private keys with anyone.

---

## 📄 License

MIT
