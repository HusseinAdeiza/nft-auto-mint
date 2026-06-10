# 🤖 NFT Auto-Mint Bot

Automatically detects mint time, waits with precision countdown, and fires mint transactions **instantly** at the exact millisecond — beating manual minters every time.

---

## ✨ Features

- 🔗 **Just paste an OpenSea URL** — no manual contract hunting
- ⏰ **Auto-detects mint time** from OpenSea API, contract, or manual override
- 🎯 **10ms precision firing** — busy-waits final milliseconds for exact timing
- ⚡ **Zero pre-checks at mint time** — fires instantly, no wasted seconds
- ⛽ **3x gas boost** — priority block inclusion over other minters
- 👛 **Multi-wallet support** — fires up to 5 wallets simultaneously
- 🔎 **Auto-fetches real ABI** from Etherscan/Arbiscan/Basescan V2 API
- 🌊 **SeaDrop support** — handles OpenSea native drop contracts automatically
- ⛓️ **Multi-chain** — Ethereum, Base, Polygon, Arbitrum, Optimism, Avalanche
- 🔁 **Auto-retry** — retries every 2 seconds if mint fails

---

## 📋 Requirements

- [Node.js](https://nodejs.org/) v18 or higher
- ETH in your wallet(s) for gas fees
- An RPC endpoint (free from [Infura](https://infura.io) or [Alchemy](https://alchemy.com))
- A free [Etherscan API key](https://etherscan.io/apis) for ABI fetching
- *(Recommended)* A free [OpenSea API key](https://docs.opensea.io/reference/api-overview)

---

## 🚀 Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/HusseinAdeiza/nft-auto-mint.git
cd nft-auto-mint
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up your environment

```bash
cp .env.example .env
nano .env
```

Fill in your values:

```env
# ── REQUIRED ──────────────────────────────────────
PRIVATE_KEY=your_main_wallet_private_key

# ── MULTI-WALLET (optional, up to 5 wallets) ──────
PRIVATE_KEY_2=your_second_wallet_private_key
PRIVATE_KEY_3=your_third_wallet_private_key
PRIVATE_KEY_4=your_fourth_wallet_private_key
PRIVATE_KEY_5=your_fifth_wallet_private_key

# ── RPC ENDPOINTS ─────────────────────────────────
RPC_URL=https://mainnet.infura.io/v3/YOUR_PROJECT_ID
RPC_URL_BASE=https://mainnet.base.org
RPC_URL_ARBITRUM=https://arb1.arbitrum.io/rpc
RPC_URL_POLYGON=https://polygon-rpc.com

# ── API KEYS ──────────────────────────────────────
ETHERSCAN_API_KEY=your_etherscan_api_key
ARBISCAN_API_KEY=your_etherscan_api_key
BASESCAN_API_KEY=your_etherscan_api_key
OPENSEA_API_KEY=your_opensea_api_key

# ── BOT SETTINGS ──────────────────────────────────
MINT_AMOUNT=1
MAX_GAS_GWEI=500
MINT_VALUE_ETH=0.0
CHECK_INTERVAL=2000
RETRY_DELAY=2000
MAX_RETRIES=30
MINT_ONCE=true
MIN_BALANCE_ETH=0.00001
```

> ⚠️ **Security:** Never share your `.env` file or commit it to GitHub. It's already in `.gitignore`.

---

## 🎯 How to Run

### Basic usage (auto-detects everything):
```bash
node index.js https://opensea.io/collection/COLLECTION-SLUG/overview
```

### With manual mint time override:
```bash
MINT_START_TIME=2026-06-01T14:00:00Z node index.js https://opensea.io/collection/COLLECTION-SLUG/overview
```

### With custom mint price and amount:
```bash
MINT_START_TIME=2026-06-01T14:00:00Z MINT_VALUE_ETH=0.001 MINT_AMOUNT=2 node index.js https://opensea.io/collection/COLLECTION-SLUG/overview
```

### Full options (recommended for competitive mints):
```bash
MINT_START_TIME=2026-06-01T14:00:00Z \
MINT_VALUE_ETH=0.0 \
MINT_AMOUNT=1 \
MAX_RETRIES=30 \
RETRY_DELAY=2000 \
MAX_GAS_GWEI=500 \
node index.js https://opensea.io/collection/COLLECTION-SLUG/overview
```

### Run in background (VPS/server):
```bash
nohup bash -c 'MINT_START_TIME=2026-06-01T14:00:00Z node index.js https://opensea.io/collection/COLLECTION-SLUG/overview' > mint.log 2>&1 &

# Monitor live output:
tail -f mint.log

# Stop the bot:
pkill -f "node index.js"
```

### Bypass OpenSea API (use when network issues):
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

## ⚙️ Configuration

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | *(required)* | Main wallet private key |
| `PRIVATE_KEY_2` to `PRIVATE_KEY_5` | *(optional)* | Additional wallets — all fire simultaneously |
| `RPC_URL` | *(required)* | Ethereum RPC endpoint |
| `ETHERSCAN_API_KEY` | *(optional)* | Fetches real contract ABI — highly recommended |
| `OPENSEA_API_KEY` | *(optional)* | Auto-detects mint time and collection data |
| `MINT_START_TIME` | *(auto-detected)* | Manual override e.g. `2026-06-01T14:00:00Z` (UTC) |
| `MINT_AMOUNT` | `1` | NFTs to mint per wallet per transaction |
| `MINT_VALUE_ETH` | `0.0` | ETH cost per mint (0.0 for free mints) |
| `MAX_GAS_GWEI` | `500` | Max gas price ceiling in Gwei |
| `RETRY_DELAY` | `2000` | Milliseconds between retries |
| `MAX_RETRIES` | `30` | Max attempts before stopping |
| `MIN_BALANCE_ETH` | `0.00001` | Minimum ETH balance to attempt mint |
| `MINT_ONCE` | `true` | Stop after first successful mint |

---

## ⏰ Mint Time Detection (Priority Order)

1. **OpenSea API** — auto-fetched from collection drop schedule
2. **Manual `.env`** — `MINT_START_TIME=2026-06-01T14:00:00Z`
3. **Contract on-chain** — reads `startTime()`, `mintStartTime()` etc.
4. **Immediate** — mints as soon as eligible if no time found

---

## 🌐 Supported Chains

| Chain | RPC env var |
|---|---|
| Ethereum | `RPC_URL` |
| Base | `RPC_URL_BASE` |
| Arbitrum | `RPC_URL_ARBITRUM` |
| Polygon | `RPC_URL_POLYGON` |
| Optimism | `RPC_URL_OPTIMISM` |
| Avalanche | `RPC_URL_AVALANCHE` |

---

## 📁 Project Structure
nft-auto-mint/
├── index.js          # Entry point — handles URL input & startup
├── src/
│   ├── opensea.js    # OpenSea URL parser, API resolver, mint schedule
│   ├── minter.js     # Core bot — precision timing, multi-wallet, minting
│   └── utils.js      # Logging, sleep, env validation
├── .env.example      # Template — copy to .env
├── .gitignore        # Keeps .env out of git
└── package.json

---

## 💡 Pro Tips

- **Always top up ALL wallets** before mint time — even free mints need gas
- **Run on VPS + laptop simultaneously** for maximum coverage
- **Use `screen` or `nohup`** on VPS to prevent disconnection
- **Set `MAX_GAS_GWEI=500`** to never miss a mint due to gas limits
- **Get Etherscan API key** — without it the bot uses fallback ABI and may miss some contracts
- **Convert mint time to UTC** — e.g. 4:00 PM GMT+1 = `T15:00:00Z`

---

## ⚠️ Disclaimer

This tool is for minting NFTs you are legitimately eligible for. Always verify contract addresses before running. Never share your `.env` file or private keys.

---

## 📄 License

MIT
