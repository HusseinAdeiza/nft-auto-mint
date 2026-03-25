# 🤖 NFT Auto-Mint Bot

Automatically monitors an OpenSea collection and mints an NFT to your wallet the moment you become eligible — handling supply checks, allowlist gating, gas price limits, and multiple mint function signatures.

---

## ✨ Features

- 🔗 **Just paste an OpenSea URL** — no manual contract hunting
- ⛓️ **Multi-chain** — Ethereum, Base, Polygon, Arbitrum, Optimism, Avalanche
- 🕵️ **Eligibility detection** — checks paused state, supply, and allowlist status
- ⛽ **Gas gating** — waits until gas drops below your configured max
- 🔁 **Auto-retry** — keeps polling until mint succeeds or max retries hit
- 🎯 **Smart ABI** — tries multiple mint function signatures automatically

---

## 📋 Requirements

- [Node.js](https://nodejs.org/) v18 or higher
- An Ethereum-compatible wallet with some ETH for gas
- An RPC endpoint (free from [Infura](https://infura.io) or [Alchemy](https://alchemy.com))
- *(Recommended)* A free [OpenSea API key](https://docs.opensea.io/reference/api-overview)

---

## 🚀 Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/nft-auto-mint.git
cd nft-auto-mint
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up your environment

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```env
PRIVATE_KEY=your_wallet_private_key_here
RPC_URL=https://mainnet.infura.io/v3/YOUR_PROJECT_ID
OPENSEA_API_KEY=your_opensea_api_key_here   # optional but recommended
```

> ⚠️ **Security:** Never share your `.env` file or commit it to GitHub. It's already in `.gitignore`.

### 4. Run the bot

```bash
npm start
```

The bot will prompt you to paste an OpenSea collection URL:

```
🔗 Paste your OpenSea collection URL: https://opensea.io/collection/my-collection
```

**Or pass the URL directly as an argument:**

```bash
node index.js https://opensea.io/collection/my-collection
```

---

## ⚙️ Configuration

All settings live in your `.env` file. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | *(required)* | Your wallet private key |
| `RPC_URL` | *(required)* | Ethereum RPC endpoint |
| `OPENSEA_API_KEY` | *(optional)* | Prevents OpenSea rate limits |
| `MINT_AMOUNT` | `1` | NFTs to mint per transaction |
| `MAX_GAS_GWEI` | `50` | Max gas price — bot waits if exceeded |
| `MINT_VALUE_ETH` | `0.0` | ETH per mint (fallback if contract price can't be read) |
| `CHECK_INTERVAL` | `10000` | Eligibility poll interval (ms) |
| `RETRY_DELAY` | `30000` | Wait time after errors (ms) |
| `MAX_RETRIES` | `5` | Max consecutive failures before stopping |
| `MINT_ONCE` | `true` | Stop bot after first successful mint |

---

## 🔗 Supported URL Formats

```
https://opensea.io/collection/{slug}
https://opensea.io/assets/ethereum/{contractAddress}/{tokenId}
https://opensea.io/assets/base/{contractAddress}/{tokenId}
```

---

## 🌐 Supported Chains

| Chain | Built-in RPC | Custom RPC env var |
|---|---|---|
| Ethereum | *(use your own)* | `RPC_URL` or `RPC_URL_ETHEREUM` |
| Base | `mainnet.base.org` | `RPC_URL_BASE` |
| Polygon | `polygon-rpc.com` | `RPC_URL_POLYGON` |
| Arbitrum | `arb1.arbitrum.io/rpc` | `RPC_URL_ARBITRUM` |
| Optimism | `mainnet.optimism.io` | `RPC_URL_OPTIMISM` |
| Avalanche | `api.avax.network` | `RPC_URL_AVALANCHE` |

---

## 📁 Project Structure

```
nft-auto-mint/
├── index.js          # Entry point — handles URL input & startup
├── src/
│   ├── opensea.js    # OpenSea URL parser & API resolver
│   ├── minter.js     # Eligibility checks, gas gating, mint logic
│   └── utils.js      # Logging, sleep, env validation
├── .env.example      # Template — copy to .env
├── .gitignore        # Keeps .env out of git
└── package.json
```

---

## ⚠️ Disclaimer

This tool is for personal use only — to mint NFTs **you are legitimately eligible for**. Always verify you're interacting with the correct contract. Never share your private key with anyone.

---

## 📄 License

MIT

