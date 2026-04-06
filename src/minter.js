/**
 * src/minter.js
 * Core bot: auto-fetches real contract ABI from block explorer,
 * finds the correct mint function, waits for mint time, then mints.
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
  minBalanceEth:   process.env.MIN_BALANCE_ETH         || "0.0001",
  mintStartTime:   process.env.MINT_START_TIME         || null,
};

// Explorer API endpoints per chain
const EXPLORER_API = {
  ethereum:  { url: "https://api.etherscan.io/v2/api?chainid=1",  key: process.env.ETHERSCAN_API_KEY  || "" },
  arbitrum:  { url: "https://api.etherscan.io/v2/api?chainid=42161", key: process.env.ARBISCAN_API_KEY   || "" },
  base:      { url: "https://api.basescan.org/api",              key: process.env.BASESCAN_API_KEY   || "" },
  polygon:   { url: "https://api.polygonscan.com/api",           key: process.env.POLYGONSCAN_API_KEY|| "" },
  optimism:  { url: "https://api-optimistic.etherscan.io/api",   key: process.env.OPTIMISM_API_KEY   || "" },
  avalanche: { url: "https://api.snowtrace.io/api",              key: process.env.SNOWTRACE_API_KEY  || "" },
};

// Fallback ABI — used if explorer fetch fails
const FALLBACK_ABI = [
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
  "function mintTo(address to, uint256 quantity) payable",
  "function claim() payable",
  "function claim(address to) payable",
  "function claim(uint256 quantity) payable",
  "function claimNFT() payable",
  "function freeMint() payable",
  "function freeMint(uint256 quantity) payable",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];


// SeaDrop contract address (OpenSea's minting contract — same on all EVM chains)
const SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const SEADROP_ABI = [
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
];

async function trySeaDrop(nftAddress, wallet, provider, opts) {
  const feeRecipient = '0x0000a26b00c1F0DF003000390027140000fAa719'; // OpenSea fee recipient
  const seadrop = new (require("ethers").ethers.Contract)(SEADROP_ADDRESS, SEADROP_ABI, wallet);
  log('🌊 SeaDrop contract detected — calling SeaDrop.mintPublic()...');
  const tx = await seadrop.mintPublic(nftAddress, feeRecipient, wallet.address, opts.quantity || 1, { gasPrice: opts.gasPrice, value: opts.value });
  log('   Tx hash: ' + tx.hash);
  const receipt = await tx.wait();
  log('✅ Minted via SeaDrop! Block #' + receipt.blockNumber + ' | Gas: ' + receipt.gasUsed);
  return receipt;
}

// Keywords that identify a mint/claim write function
const MINT_KEYWORDS = ["mint", "claim", "free", "drop", "collect", "redeem", "issue", "create"];

// ─── ABI FETCHER ──────────────────────────────────────────────────────────────

async function fetchABIFromExplorer(contractAddress, chain) {
  const explorer = EXPLORER_API[chain];
  if (!explorer) return null;

  try {
    const url = `${explorer.url}&module=contract&action=getabi&address=${contractAddress}&apikey=${explorer.key}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (data.status !== "1" || !data.result) return null;

    const abi = JSON.parse(data.result);
    log(`✅ Fetched real ABI from ${chain} explorer (${abi.length} functions)`);
    return abi;
  } catch (e) {
    return null;
  }
}

/**
 * Finds all write (non-view, non-pure) functions whose name contains
 * mint/claim/free/drop keywords — these are the candidate mint functions.
 */
function findMintFunctions(abi) {
  if (!Array.isArray(abi)) return [];

  return abi.filter((item) => {
    if (item.type !== "function") return false;
    if (item.stateMutability === "view" || item.stateMutability === "pure") return false;
    const name = (item.name || "").toLowerCase();
    return MINT_KEYWORDS.some((kw) => name.includes(kw));
  });
}

/**
 * Builds the list of mint call attempts from the real ABI.
 * Sorts: no-args first (likely free claim), then quantity, then address+quantity.
 */
function buildMintAttempts(mintFunctions, contract, wallet, opts) {
  const attempts = [];

  for (const fn of mintFunctions) {
    const inputs = fn.inputs || [];
    const name   = fn.name;

    // No args — e.g. claim(), freeMint()
    if (inputs.length === 0) {
      attempts.push({ label: `${name}()`, call: () => contract[name](opts) });
      continue;
    }

    // Single uint256 — e.g. mint(quantity)
    if (inputs.length === 1 && inputs[0].type === "uint256") {
      attempts.push({ label: `${name}(qty)`, call: () => contract[name](CONFIG.mintAmount, opts) });
      continue;
    }

    // Single address — e.g. claim(to), safeMint(to)
    if (inputs.length === 1 && inputs[0].type === "address") {
      attempts.push({ label: `${name}(addr)`, call: () => contract[name](wallet.address, opts) });
      continue;
    }

    // address + uint256 — e.g. mint(to, qty), mintTo(to, qty)
    if (inputs.length === 2 &&
        inputs[0].type === "address" && inputs[1].type === "uint256") {
      attempts.push({ label: `${name}(addr,qty)`, call: () => contract[name](wallet.address, CONFIG.mintAmount, opts) });
      continue;
    }

    // uint256 + address — e.g. mint(qty, to)
    if (inputs.length === 2 &&
        inputs[0].type === "uint256" && inputs[1].type === "address") {
      attempts.push({ label: `${name}(qty,addr)`, call: () => contract[name](CONFIG.mintAmount, wallet.address, opts) });
      continue;
    }
  }

  return attempts;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function tryRead(contract, fn, ...args) {
  try { return await contract[fn](...args); } catch { return null; }
}

async function getMintPrice(contract, abi) {
  // Try named price functions from real ABI first
  if (Array.isArray(abi)) {
    const priceFns = abi.filter(
      (f) => f.type === "function" &&
             (f.stateMutability === "view" || f.stateMutability === "pure") &&
             (f.outputs || []).length === 1 &&
             /price|cost|fee/i.test(f.name || "")
    );
    for (const fn of priceFns) {
      const p = await tryRead(contract, fn.name);
      if (p !== null && p >= 0n) return p;
    }
  }
  // Fallback generic names
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
  const s   = Math.floor(ms / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ─── MINT TIME ────────────────────────────────────────────────────────────────

async function resolveMintTime(collection, contract) {
  if (collection.mintStartTime) {
    const t = new Date(collection.mintStartTime);
    log(`⏰ Mint time (OpenSea API): ${t.toUTCString()}`);
    if (collection.mintStage) log(`   Stage: ${collection.mintStage}`);
    return t;
  }
  if (CONFIG.mintStartTime) {
    const t = new Date(CONFIG.mintStartTime);
    if (!isNaN(t.getTime())) {
      log(`⏰ Mint time (.env override): ${t.toUTCString()}`);
      return t;
    }
  }
  for (const fn of ["mintStartTime", "startTime", "publicSaleStartTime", "saleStartTime"]) {
    const ts = await tryRead(contract, fn);
    if (ts !== null && ts > 0n) {
      const t = new Date(Number(ts) * 1000);
      log(`⏰ Mint time (contract ${fn}()): ${t.toUTCString()}`);
      return t;
    }
  }
  log(`⏰ No scheduled time found — minting as soon as eligible.`);
  return null;
}

async function waitForMintTime(mintTime) {
  if (!mintTime) return;
  const target = mintTime.getTime();
  if (Date.now() >= target) { log(`✅ Mint time already passed — proceeding.`); return; }

  const diff = target - Date.now();
  log(`\n⏳ Bot armed. Mint opens in ${formatCountdown(diff)}`);
  log(`   Target: ${mintTime.toUTCString()}`);
  log(`   Leave this running — it will fire automatically.\n`);

  while (Date.now() < target) {
    const rem = target - Date.now();
    if (rem > 3_600_000)      { process.stdout.write(`\r⏳  ${formatCountdown(rem)} until mint...   `); await sleep(60_000); }
    else if (rem > 60_000)    { process.stdout.write(`\r⏳  ${formatCountdown(rem)} until mint...   `); await sleep(10_000); }
    else if (rem > 5_000)     { process.stdout.write(`\r🔥  MINTING IN ${formatCountdown(rem)}...   `); await sleep(1_000); }
    else                      { process.stdout.write(`\r🚨  FIRING IN ${Math.ceil(rem / 1000)}s...   `); await sleep(500); }
  }
  process.stdout.write("\n");
  log(`🟢 Mint time reached! Firing...`);
}

// ─── BALANCE ──────────────────────────────────────────────────────────────────

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

// ─── ELIGIBILITY ──────────────────────────────────────────────────────────────

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
    if (whitelisted === false) { log(`❌ Not on allowlist.`); return false; }
    log(`   Allowlist: ✅`);
  }
  return true;
}

// ─── GAS ──────────────────────────────────────────────────────────────────────

async function gasPriceOk(provider) {
  const feeData     = await provider.getFeeData();
  const current     = feeData.gasPrice;
  const maxGwei     = ethers.parseUnits(CONFIG.maxGasGwei, "gwei");
  const currentGwei = parseFloat(ethers.formatUnits(current, "gwei")).toFixed(3);
  if (current > maxGwei) { log(`⛽ Gas too high: ${currentGwei} Gwei (max: ${CONFIG.maxGasGwei})`); return false; }
  log(`   Gas: ${currentGwei} Gwei ✅`);
  return true;
}

// ─── MINT ─────────────────────────────────────────────────────────────────────

async function attemptMint(contract, wallet, provider, abi) {
  const gasPrice     = (await provider.getFeeData()).gasPrice;
  const pricePerUnit = await getMintPrice(contract, abi);
  const totalValue   = pricePerUnit * BigInt(CONFIG.mintAmount);

  log(`   Mint price: ${ethers.formatEther(pricePerUnit)} ETH x ${CONFIG.mintAmount}`);
  log(`   Total cost: ${ethers.formatEther(totalValue)} ETH`);

  const opts = { gasPrice, value: totalValue };

  // Build attempts from real ABI mint functions
  const mintFns  = findMintFunctions(abi);
  let attempts   = buildMintAttempts(mintFns, contract, wallet, opts);

  if (attempts.length === 0) {
    log(`⚠️  No mint functions found in real ABI — using fallback signatures.`);
    // Fallback hardcoded attempts
    attempts = [
      { label: "mint(uint256)",        call: () => contract["mint(uint256)"](CONFIG.mintAmount, opts) },
      { label: "mint(address,uint256)",call: () => contract["mint(address,uint256)"](wallet.address, CONFIG.mintAmount, opts) },
      { label: "claim()",              call: () => contract["claim()"](opts) },
      { label: "claim(uint256)",       call: () => contract["claim(uint256)"](CONFIG.mintAmount, opts) },
      { label: "publicMint(uint256)",  call: () => contract.publicMint(CONFIG.mintAmount, opts) },
      { label: "mintTo(address,uint256)", call: () => contract.mintTo(wallet.address, CONFIG.mintAmount, opts) },
      { label: "freeMint()",           call: () => contract.freeMint(opts) },
      { label: "safeMint(address)",    call: () => contract.safeMint(wallet.address, opts) },
      { label: "mintTo(address)",        call: () => contract.mintTo(wallet.address, opts) },
      { label: "collectiveMint()",       call: () => contract.collectiveMint(opts) },
      { label: "openMint(uint256)",      call: () => contract.openMint(CONFIG.mintAmount, opts) },
      { label: "drop()",                 call: () => contract.drop(opts) },
      { label: "claimFree()",            call: () => contract.claimFree(opts) },
      { label: "airdrop(address)",       call: () => contract.airdrop(wallet.address, opts) },
      { label: "purchase(uint256)",      call: () => contract.purchase(CONFIG.mintAmount, opts) },
    ];
  } else {
    log(`   Found ${attempts.length} mint function(s): ${attempts.map(a => a.label).join(", ")}`);
  }

  // Check if this is a SeaDrop contract — mintSeaDrop() means OpenSea controls minting
  const isSeaDrop = Array.isArray(abi) && abi.some(f => f.name === 'mintSeaDrop');
  if (isSeaDrop) {
    return await trySeaDrop(contract.target, wallet, provider, { gasPrice, value: totalValue, quantity: CONFIG.mintAmount });
  }

  for (const { label, call } of attempts) {
    try {
      log(`🚀 Trying ${label}...`);
      const tx      = await call();
      log(`   Tx hash: ${tx.hash}`);
      const receipt = await tx.wait();
      log(`✅ Minted! Block #${receipt.blockNumber} | Gas: ${receipt.gasUsed}`);
      return receipt;
    } catch (err) {
      if (err.code === "INSUFFICIENT_FUNDS" || err.message?.includes("insufficient funds")) {
        log(`💸 Insufficient funds. Top up and restart.`, "ERROR");
        process.exit(1);
      }
      if (
        err.code === "CALL_EXCEPTION" ||
        err.message?.includes("is not a function") ||
        err.message?.includes("no matching function") ||
        err.message?.includes("ambiguous function") ||
        err.message?.includes("unknown function")
      ) {
        log(`   ↳ ${label} not compatible, trying next...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error("No compatible mint function found. Check contract on block explorer.");
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

async function startMintBot(collection) {
  const { contractAddress, chain, rpcUrl, name } = collection;

  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");
  if (!rpcUrl) throw new Error(`No RPC URL for chain: ${chain}`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  // Step 1 — Fetch real ABI from block explorer
  log(`🔎 Fetching contract ABI from ${chain} explorer...`);
  let abi = await fetchABIFromExplorer(contractAddress, chain);
  if (!abi) {
    log(`⚠️  Could not fetch ABI from explorer — using fallback ABI.`);
    abi = FALLBACK_ABI;
  }

  const contract = new ethers.Contract(contractAddress, abi, wallet);
  const balance  = await provider.getBalance(wallet.address);

  console.log("\n─────────────────────────────────────────");
  log(`Wallet:     ${wallet.address}`);
  log(`Balance:    ${ethers.formatEther(balance)} ETH`);
  log(`Collection: ${name}`);
  log(`Contract:   ${contractAddress}`);
  log(`Chain:      ${chain}`);
  log(`Mint amt:   ${CONFIG.mintAmount}`);
  log(`Max gas:    ${CONFIG.maxGasGwei} Gwei`);

  // Show detected mint functions
  const mintFns = findMintFunctions(abi);
  if (mintFns.length > 0) {
    log(`Mint fns:   ${mintFns.map(f => f.name + "()").join(", ")}`);
  }
  console.log("─────────────────────────────────────────\n");

  // Step 2 — Balance check
  if (!(await checkBalance(provider, wallet.address))) process.exit(1);

  // Step 3 — Resolve & wait for mint time
  const mintTime = await resolveMintTime(collection, contract);
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
      if (!(await gasPriceOk(provider))) {
        await sleep(CONFIG.retryDelayMs);
        continue;
      }

      await attemptMint(contract, wallet, provider, abi);
      failures = 0;
      minted   = true;

      console.log("\n🎉 ══════════════════════════════════════");
      log(`Mint successful!`);
      log(`View on OpenSea: https://opensea.io/${wallet.address}`);
      console.log("══════════════════════════════════════\n");

      if (CONFIG.mintOnce) { log("MINT_ONCE=true — stopping."); process.exit(0); }

    } catch (err) {
      failures++;
      log(`Error (${failures}/${CONFIG.maxRetries}): ${err.message}`, "ERROR");
      if (failures >= CONFIG.maxRetries) { log("Max retries reached. Stopping.", "ERROR"); process.exit(1); }
      await sleep(CONFIG.retryDelayMs);
    }
    await sleep(CONFIG.checkIntervalMs);
  }
}

module.exports = { startMintBot };
