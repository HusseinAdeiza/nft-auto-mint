/**
 * src/minter.js
 * Core bot logic: eligibility checking, gas gating, and minting.
 */

const { ethers } = require("ethers");
const { log, sleep } = require("./utils");

// ─── CONFIG (from .env) ────────────────────────────────────────────────────────

const CONFIG = {
  mintAmount:      parseInt(process.env.MINT_AMOUNT    || "1"),
  maxGasGwei:      process.env.MAX_GAS_GWEI            || "50",
  mintValueEth:    process.env.MINT_VALUE_ETH          || "0.0",
  checkIntervalMs: parseInt(process.env.CHECK_INTERVAL || "10000"),
  retryDelayMs:    parseInt(process.env.RETRY_DELAY    || "30000"),
  maxRetries:      parseInt(process.env.MAX_RETRIES    || "5"),
  mintOnce:        process.env.MINT_ONCE !== "false",  // default: stop after first mint
};

// ─── ABI — covers the most common ERC-721/ERC-1155 mint patterns ──────────────

const ABI = [
  // State reads
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function mintingEnabled() view returns (bool)",
  "function paused() view returns (bool)",
  "function publicMintEnabled() view returns (bool)",
  "function isPublicMintEnabled() view returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function isWhitelisted(address account) view returns (bool)",
  "function allowlistMintEnabled() view returns (bool)",
  "function price() view returns (uint256)",
  "function mintPrice() view returns (uint256)",
  "function cost() view returns (uint256)",
  "function getPrice() view returns (uint256)",
  // Mint functions
  "function mint(uint256 quantity) payable",
  "function mint(address to, uint256 quantity) payable",
  "function publicMint(uint256 quantity) payable",
  "function allowlistMint(uint256 quantity) payable",
  "function presaleMint(uint256 quantity) payable",
  "function safeMint(address to) payable",
  "function mintPublic(uint256 quantity) payable",
  "function mintNFT(uint256 quantity) payable",
  // Events
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function tryRead(contract, fn, ...args) {
  try { return await contract[fn](...args); } catch { return null; }
}

async function getMintPrice(contract) {
  for (const fn of ["price", "mintPrice", "cost", "getPrice"]) {
    const p = await tryRead(contract, fn);
    if (p !== null) return p;
  }
  return ethers.parseEther(CONFIG.mintValueEth);
}

async function getMaxSupply(contract) {
  return (await tryRead(contract, "maxSupply")) ??
         (await tryRead(contract, "MAX_SUPPLY")) ??
         null;
}

// ─── ELIGIBILITY CHECK ────────────────────────────────────────────────────────

async function checkEligibility(contract, walletAddress) {
  const checks = [];

  // Paused?
  const paused = await tryRead(contract, "paused");
  if (paused === true) { log("❌ Contract is paused."); return false; }

  // Minting enabled?
  for (const fn of ["mintingEnabled", "publicMintEnabled", "isPublicMintEnabled"]) {
    const enabled = await tryRead(contract, fn);
    if (enabled === false) {
      log(`❌ ${fn}() returned false — mint not open yet.`);
      return false;
    }
  }

  // Supply check
  const total = await tryRead(contract, "totalSupply");
  const max   = await getMaxSupply(contract);
  if (total !== null && max !== null) {
    if (total >= max) { log(`❌ Sold out (${total}/${max})`); return false; }
    log(`   Supply: ${total} / ${max}`);
  }

  // Allowlist check (only if allowlist mint is active)
  const allowlistActive = await tryRead(contract, "allowlistMintEnabled");
  if (allowlistActive === true) {
    const whitelisted = await tryRead(contract, "isWhitelisted", walletAddress);
    if (whitelisted === false) {
      log(`❌ Wallet not on allowlist.`);
      return false;
    }
    log(`   Allowlist: ✅ eligible`);
  }

  return true;
}

// ─── GAS CHECK ────────────────────────────────────────────────────────────────

async function gasPriceOk(provider) {
  const feeData = await provider.getFeeData();
  const current = feeData.gasPrice;
  const maxGwei = ethers.parseUnits(CONFIG.maxGasGwei, "gwei");
  const currentGwei = ethers.formatUnits(current, "gwei");

  if (current > maxGwei) {
    log(`⛽ Gas too high: ${parseFloat(currentGwei).toFixed(1)} Gwei (max: ${CONFIG.maxGasGwei})`);
    return false;
  }
  log(`   Gas: ${parseFloat(currentGwei).toFixed(1)} Gwei ✅`);
  return true;
}

// ─── MINT ─────────────────────────────────────────────────────────────────────

async function attemptMint(contract, wallet, provider) {
  const gasPrice     = (await provider.getFeeData()).gasPrice;
  const pricePerUnit = await getMintPrice(contract);
  const totalValue   = pricePerUnit * BigInt(CONFIG.mintAmount);

  log(`   Mint price: ${ethers.formatEther(pricePerUnit)} ETH x ${CONFIG.mintAmount}`);
  log(`   Total cost: ${ethers.formatEther(totalValue)} ETH`);

  const opts = { gasPrice, value: totalValue };

  // Try mint function signatures in priority order
  const attempts = [
    () => contract.mint(CONFIG.mintAmount, opts),
    () => contract.publicMint(CONFIG.mintAmount, opts),
    () => contract.mintPublic(CONFIG.mintAmount, opts),
    () => contract.mintNFT(CONFIG.mintAmount, opts),
    () => contract.allowlistMint(CONFIG.mintAmount, opts),
    () => contract.presaleMint(CONFIG.mintAmount, opts),
    () => contract.mint(wallet.address, CONFIG.mintAmount, opts),
    () => contract.safeMint(wallet.address, opts),
  ];

  for (const attempt of attempts) {
    try {
      log(`🚀 Sending mint transaction...`);
      const tx = await attempt();
      log(`   Tx hash: ${tx.hash}`);
      const receipt = await tx.wait();
      log(`✅ Minted! Block #${receipt.blockNumber} | Gas used: ${receipt.gasUsed}`);
      return receipt;
    } catch (err) {
      // If the function doesn't exist on this contract, try the next one
      if (
        err.code === "CALL_EXCEPTION" ||
        err.message?.includes("is not a function") ||
        err.message?.includes("no matching function")
      ) {
        continue;
      }
      // Re-throw real errors (insufficient funds, revert reasons, etc.)
      throw err;
    }
  }

  throw new Error("No compatible mint function found on this contract's ABI.");
}

// ─── MAIN BOT LOOP ────────────────────────────────────────────────────────────

async function startMintBot(collection) {
  const { contractAddress, chain, rpcUrl, name, openseaUrl } = collection;

  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");
  if (!rpcUrl) throw new Error(`No RPC URL configured for chain: ${chain}`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const contract = new ethers.Contract(contractAddress, ABI, wallet);

  // Show wallet info
  const balance = await provider.getBalance(wallet.address);
  console.log("\n─────────────────────────────────────────");
  log(`Wallet:    ${wallet.address}`);
  log(`Balance:   ${ethers.formatEther(balance)} ETH`);
  log(`Collection: ${name}`);
  log(`Contract:  ${contractAddress}`);
  log(`Chain:     ${chain}`);
  log(`Interval:  every ${CONFIG.checkIntervalMs / 1000}s`);
  log(`Max gas:   ${CONFIG.maxGasGwei} Gwei`);
  console.log("─────────────────────────────────────────\n");

  let failures = 0;
  let minted   = false;

  while (!minted || !CONFIG.mintOnce) {
    log(`Checking eligibility...`);

    try {
      const eligible = await checkEligibility(contract, wallet.address);

      if (!eligible) {
        log(`Not eligible yet. Retrying in ${CONFIG.checkIntervalMs / 1000}s...\n`);
        failures = 0;
        await sleep(CONFIG.checkIntervalMs);
        continue;
      }

      log(`🟢 ELIGIBLE! Checking gas...`);

      const gasOk = await gasPriceOk(provider);
      if (!gasOk) {
        log(`Waiting ${CONFIG.retryDelayMs / 1000}s for gas to drop...\n`);
        await sleep(CONFIG.retryDelayMs);
        continue;
      }

      await attemptMint(contract, wallet, provider);
      failures = 0;
      minted   = true;

      console.log("\n🎉 ══════════════════════════════════════");
      log(`Mint successful!`);
      log(`View on OpenSea: https://opensea.io/${wallet.address}`);
      console.log("══════════════════════════════════════\n");

      if (CONFIG.mintOnce) {
        log("MINT_ONCE=true — bot stopping.");
        process.exit(0);
      }

    } catch (err) {
      failures++;
      log(`Error (${failures}/${CONFIG.maxRetries}): ${err.message}`, "ERROR");

      if (failures >= CONFIG.maxRetries) {
        log("Max retries reached. Stopping bot.", "ERROR");
        process.exit(1);
      }

      await sleep(CONFIG.retryDelayMs);
    }

    await sleep(CONFIG.checkIntervalMs);
  }
}

module.exports = { startMintBot };
