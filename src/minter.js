/**
 * src/minter.js
 * Core bot logic: time detection, eligibility checking, gas gating, and minting.
 */

const { ethers } = require("ethers");
const { log, sleep } = require("./utils");

const CONFIG = {
  mintAmount:      parseInt(process.env.MINT_AMOUNT    || "1"),
  maxGasGwei:      process.env.MAX_GAS_GWEI            || "50",
  mintValueEth:    process.env.MINT_VALUE_ETH          || "0.0",
  checkIntervalMs: parseInt(process.env.CHECK_INTERVAL || "10000"),
  retryDelayMs:    parseInt(process.env.RETRY_DELAY    || "30000"),
  maxRetries:      parseInt(process.env.MAX_RETRIES    || "5"),
  mintOnce:        process.env.MINT_ONCE !== "false",
  mintStartTime:   process.env.MINT_START_TIME         || null,
  minBalanceEth:   process.env.MIN_BALANCE_ETH         || "0.002",
};

const ABI = [
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
  "function mintStartTime() view returns (uint256)",
  "function startTime() view returns (uint256)",
  "function publicSaleStartTime() view returns (uint256)",
  "function saleStartTime() view returns (uint256)",
  "function mint(uint256 quantity) payable",
  "function mint(address to, uint256 quantity) payable",
  "function publicMint(uint256 quantity) payable",
  "function allowlistMint(uint256 quantity) payable",
  "function presaleMint(uint256 quantity) payable",
  "function safeMint(address to) payable",
  "function mintPublic(uint256 quantity) payable",
  "function mintNFT(uint256 quantity) payable",
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

function formatCountdown(ms) {
  if (ms <= 0) return "now";
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}h ${m}m ${s}s`;
}

// ─── TIME CHECK ───────────────────────────────────────────────────────────────

async function getMintStartTime(contract) {
  // 1. Check .env override first
  if (CONFIG.mintStartTime) {
    const t = new Date(CONFIG.mintStartTime);
    if (!isNaN(t.getTime())) {
      log(`⏰ Mint time from .env: ${t.toUTCString()}`);
      return t;
    }
  }

  // 2. Try to read mint start time directly from contract
  for (const fn of ["mintStartTime", "startTime", "publicSaleStartTime", "saleStartTime"]) {
    const ts = await tryRead(contract, fn);
    if (ts !== null && ts > 0n) {
      const t = new Date(Number(ts) * 1000);
      log(`⏰ Mint time from contract (${fn}): ${t.toUTCString()}`);
      return t;
    }
  }

  // 3. No time found — mint immediately when eligible
  log(`⏰ No scheduled mint time found — will mint as soon as eligible.`);
  return null;
}

async function waitForMintTime(mintTime) {
  if (!mintTime) return; // No scheduled time, proceed immediately

  const now = Date.now();
  const target = mintTime.getTime();

  if (now >= target) {
    log(`✅ Mint time already reached.`);
    return;
  }

  const diff = target - now;
  log(`⏳ Mint opens in ${formatCountdown(diff)} — waiting until ${mintTime.toUTCString()}`);

  // Print live countdown every 10 seconds while waiting
  while (Date.now() < target) {
    const remaining = target - Date.now();
    if (remaining > 60_000) {
      // More than 1 min away — update every 10s
      process.stdout.write(`\r⏳ Time until mint: ${formatCountdown(remaining)}   `);
      await sleep(10_000);
    } else if (remaining > 5_000) {
      // Under 1 minute — update every second
      process.stdout.write(`\r🔥 MINTING IN: ${formatCountdown(remaining)}   `);
      await sleep(1_000);
    } else {
      // Final 5 seconds
      process.stdout.write(`\r🚨 MINTING IN: ${Math.ceil(remaining / 1000)}s   `);
      await sleep(500);
    }
  }

  process.stdout.write("\n");
  log(`🟢 Mint time reached! Attempting to mint...`);
}

// ─── BALANCE CHECK ────────────────────────────────────────────────────────────

async function checkBalance(provider, walletAddress) {
  const balance = await provider.getBalance(walletAddress);
  const minBalance = ethers.parseEther(CONFIG.minBalanceEth);

  if (balance < minBalance) {
    log(`💸 Insufficient balance!`, "ERROR");
    log(`   Have:  ${ethers.formatEther(balance)} ETH`, "ERROR");
    log(`   Need:  ~${CONFIG.minBalanceEth} ETH for gas`, "ERROR");
    log(`   Top up your wallet and restart the bot.`, "ERROR");
    return false;
  }
  return true;
}

// ─── ELIGIBILITY CHECK ────────────────────────────────────────────────────────

async function checkEligibility(contract, walletAddress) {
  const paused = await tryRead(contract, "paused");
  if (paused === true) { log("❌ Contract is paused."); return false; }

  for (const fn of ["mintingEnabled", "publicMintEnabled", "isPublicMintEnabled"]) {
    const enabled = await tryRead(contract, fn);
    if (enabled === false) {
      log(`❌ ${fn}() = false — mint not open yet.`);
      return false;
    }
  }

  const total = await tryRead(contract, "totalSupply");
  const max   = await getMaxSupply(contract);
  if (total !== null && max !== null) {
    if (total >= max) { log(`❌ Sold out (${total}/${max})`); return false; }
    log(`   Supply: ${total} / ${max}`);
  }

  const allowlistActive = await tryRead(contract, "allowlistMintEnabled");
  if (allowlistActive === true) {
    const whitelisted = await tryRead(contract, "isWhitelisted", walletAddress);
    if (whitelisted === false) { log(`❌ Wallet not on allowlist.`); return false; }
    log(`   Allowlist: ✅`);
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
    log(`⛽ Gas too high: ${parseFloat(currentGwei).toFixed(2)} Gwei (max: ${CONFIG.maxGasGwei})`);
    return false;
  }
  log(`   Gas: ${parseFloat(currentGwei).toFixed(2)} Gwei ✅`);
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

  const attempts = [
    () => contract["mint(uint256)"](CONFIG.mintAmount, opts),
    () => contract["mint(address,uint256)"](wallet.address, CONFIG.mintAmount, opts),
    () => contract.publicMint(CONFIG.mintAmount, opts),
    () => contract.mintPublic(CONFIG.mintAmount, opts),
    () => contract.mintNFT(CONFIG.mintAmount, opts),
    () => contract.allowlistMint(CONFIG.mintAmount, opts),
    () => contract.presaleMint(CONFIG.mintAmount, opts),
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
      // Insufficient funds — stop immediately, no point retrying
      if (err.code === "INSUFFICIENT_FUNDS" || err.message?.includes("insufficient funds")) {
        log(`💸 Insufficient funds for gas.`, "ERROR");
        log(`   Top up your wallet with at least ${CONFIG.minBalanceEth} ETH and restart.`, "ERROR");
        process.exit(1);
      }
      // Wrong function signature — try next
      if (
        err.code === "CALL_EXCEPTION" ||
        err.message?.includes("is not a function") ||
        err.message?.includes("no matching function") ||
        err.message?.includes("ambiguous function")
      ) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("No compatible mint function found on this contract.");
}

// ─── MAIN BOT LOOP ────────────────────────────────────────────────────────────

async function startMintBot(collection) {
  const { contractAddress, chain, rpcUrl, name } = collection;

  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");
  if (!rpcUrl) throw new Error(`No RPC URL for chain: ${chain}`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const contract = new ethers.Contract(contractAddress, ABI, wallet);

  const balance = await provider.getBalance(wallet.address);
  console.log("\n─────────────────────────────────────────");
  log(`Wallet:     ${wallet.address}`);
  log(`Balance:    ${ethers.formatEther(balance)} ETH`);
  log(`Collection: ${name}`);
  log(`Contract:   ${contractAddress}`);
  log(`Chain:      ${chain}`);
  log(`Interval:   every ${CONFIG.checkIntervalMs / 1000}s`);
  log(`Max gas:    ${CONFIG.maxGasGwei} Gwei`);
  console.log("─────────────────────────────────────────\n");

  // ── STEP 1: Balance pre-check ──────────────────────────────────────────────
  const balanceOk = await checkBalance(provider, wallet.address);
  if (!balanceOk) process.exit(1);

  // ── STEP 2: Detect & wait for mint start time ──────────────────────────────
  const mintTime = await getMintStartTime(contract);
  await waitForMintTime(mintTime);

  // ── STEP 3: Eligibility + mint loop ───────────────────────────────────────
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

      if (CONFIG.mintOnce) { log("MINT_ONCE=true — bot stopping."); process.exit(0); }

    } catch (err) {
      failures++;
      log(`Error (${failures}/${CONFIG.maxRetries}): ${err.message}`, "ERROR");
      if (failures >= CONFIG.maxRetries) {
        log("Max retries reached. Stopping.", "ERROR");
        process.exit(1);
      }
      await sleep(CONFIG.retryDelayMs);
    }

    await sleep(CONFIG.checkIntervalMs);
  }
}

module.exports = { startMintBot };
