/**
 * src/minter.js
 * Core bot: auto-detects mint time, waits with countdown,
 * checks eligibility, gates on gas, then mints.
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
  minBalanceEth:   process.env.MIN_BALANCE_ETH         || "0.0005",
  // Manual override — only used if OpenSea API returns nothing
  mintStartTime:   process.env.MINT_START_TIME         || null,
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
  // Contract-level time functions (fallback)
  "function mintStartTime() view returns (uint256)",
  "function startTime() view returns (uint256)",
  "function publicSaleStartTime() view returns (uint256)",
  "function saleStartTime() view returns (uint256)",
  // Mint functions
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
         (await tryRead(contract, "MAX_SUPPLY")) ?? null;
}

function formatCountdown(ms) {
  if (ms <= 0) return "NOW";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0)  return `${h}h ${m}m ${sec}s`;
  if (m > 0)  return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ─── MINT TIME RESOLUTION ─────────────────────────────────────────────────────
// Priority: 1) OpenSea API (passed in from opensea.js)
//           2) Manual .env override
//           3) Contract on-chain time functions
//           4) No time → mint immediately when eligible

async function resolveMintTime(collection, contract) {

  // 1. OpenSea API — already fetched in opensea.js
  if (collection.mintStartTime) {
    const t = new Date(collection.mintStartTime);
    log(`⏰ Mint time (from OpenSea API): ${t.toUTCString()}`);
    if (collection.mintStage) log(`   Stage: ${collection.mintStage}`);
    return t;
  }

  // 2. Manual .env override
  if (CONFIG.mintStartTime) {
    const t = new Date(CONFIG.mintStartTime);
    if (!isNaN(t.getTime())) {
      log(`⏰ Mint time (from .env override): ${t.toUTCString()}`);
      return t;
    }
  }

  // 3. Read time directly from contract
  for (const fn of ["mintStartTime", "startTime", "publicSaleStartTime", "saleStartTime"]) {
    const ts = await tryRead(contract, fn);
    if (ts !== null && ts > 0n) {
      const t = new Date(Number(ts) * 1000);
      log(`⏰ Mint time (from contract ${fn}()): ${t.toUTCString()}`);
      return t;
    }
  }

  // 4. No scheduled time found
  log(`⏰ No scheduled mint time detected — will mint as soon as eligible.`);
  return null;
}

// ─── COUNTDOWN ────────────────────────────────────────────────────────────────

async function waitForMintTime(mintTime) {
  if (!mintTime) return;

  const now    = Date.now();
  const target = mintTime.getTime();

  if (now >= target) {
    log(`✅ Mint time already passed — proceeding immediately.`);
    return;
  }

  const diff = target - now;
  log(`\n⏳ Bot is armed. Mint opens in ${formatCountdown(diff)}`);
  log(`   Target: ${mintTime.toUTCString()}`);
  log(`   Bot will fire automatically — you can leave this running.\n`);

  while (Date.now() < target) {
    const remaining = target - Date.now();

    if (remaining > 3_600_000) {
      // > 1 hour: update every 60s
      process.stdout.write(`\r⏳  ${formatCountdown(remaining)} until mint...   `);
      await sleep(60_000);
    } else if (remaining > 60_000) {
      // 1 hour → 1 min: update every 10s
      process.stdout.write(`\r⏳  ${formatCountdown(remaining)} until mint...   `);
      await sleep(10_000);
    } else if (remaining > 5_000) {
      // Under 1 min: update every second
      process.stdout.write(`\r🔥  MINTING IN ${formatCountdown(remaining)}...   `);
      await sleep(1_000);
    } else {
      // Final 5 seconds
      process.stdout.write(`\r🚨  FIRING IN ${Math.ceil(remaining / 1000)}s...   `);
      await sleep(500);
    }
  }

  process.stdout.write("\n");
  log(`🟢 Mint time reached! Executing...`);
}

// ─── BALANCE CHECK ────────────────────────────────────────────────────────────

async function checkBalance(provider, address) {
  const balance    = await provider.getBalance(address);
  const minBalance = ethers.parseEther(CONFIG.minBalanceEth);
  if (balance < minBalance) {
    log(`\n💸 Wallet balance too low!`, "ERROR");
    log(`   Have: ${ethers.formatEther(balance)} ETH`, "ERROR");
    log(`   Need: ~${CONFIG.minBalanceEth} ETH for gas`, "ERROR");
    log(`   Top up and restart the bot.`, "ERROR");
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
    if (enabled === false) { log(`❌ ${fn}() = false — not open yet.`); return false; }
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
    log(`   Allowlist: ✅ eligible`);
  }

  return true;
}

// ─── GAS CHECK ────────────────────────────────────────────────────────────────

async function gasPriceOk(provider) {
  const feeData      = await provider.getFeeData();
  const current      = feeData.gasPrice;
  const maxGwei      = ethers.parseUnits(CONFIG.maxGasGwei, "gwei");
  const currentGwei  = parseFloat(ethers.formatUnits(current, "gwei")).toFixed(3);
  if (current > maxGwei) {
    log(`⛽ Gas too high: ${currentGwei} Gwei (max: ${CONFIG.maxGasGwei})`);
    return false;
  }
  log(`   Gas: ${currentGwei} Gwei ✅`);
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
      const tx      = await attempt();
      log(`   Tx hash: ${tx.hash}`);
      const receipt = await tx.wait();
      log(`✅ Minted! Block #${receipt.blockNumber} | Gas used: ${receipt.gasUsed}`);
      return receipt;
    } catch (err) {
      if (err.code === "INSUFFICIENT_FUNDS" || err.message?.includes("insufficient funds")) {
        log(`💸 Insufficient funds for gas. Top up and restart.`, "ERROR");
        process.exit(1);
      }
      if (
        err.code === "CALL_EXCEPTION" ||
        err.message?.includes("is not a function") ||
        err.message?.includes("no matching function") ||
        err.message?.includes("ambiguous function")
      ) continue;
      throw err;
    }
  }
  throw new Error("No compatible mint function found on this contract.");
}

// ─── MAIN BOT LOOP ────────────────────────────────────────────────────────────

async function startMintBot(collection) {
  const { contractAddress, chain, rpcUrl, name } = collection;

  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");
  if (!rpcUrl) throw new Error(`No RPC URL configured for chain: ${chain}`);

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
  log(`Mint amt:   ${CONFIG.mintAmount}`);
  log(`Max gas:    ${CONFIG.maxGasGwei} Gwei`);
  console.log("─────────────────────────────────────────\n");

  // Step 1 — Balance pre-check
  const balanceOk = await checkBalance(provider, wallet.address);
  if (!balanceOk) process.exit(1);

  // Step 2 — Resolve mint time (API → .env → contract → none)
  const mintTime = await resolveMintTime(collection, contract);

  // Step 3 — Wait with live countdown
  await waitForMintTime(mintTime);

  // Step 4 — Eligibility + mint loop
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
        log(`Waiting ${CONFIG.retryDelayMs / 1000}s for gas to drop...`);
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
