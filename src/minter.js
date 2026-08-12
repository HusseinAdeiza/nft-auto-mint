/**
 * src/minter.js - SPEED MODE
 * Fires mint transaction INSTANTLY at mint time. Zero checks after countdown.
 */

const { ethers } = require("ethers");
const { log, sleep } = require("./utils");

const CONFIG = {
  mintAmount:      parseInt(process.env.MINT_AMOUNT    || "1"),
  maxGasGwei:      process.env.MAX_GAS_GWEI            || "50",
  mintValueEth:    process.env.MINT_VALUE_ETH          || "0.0",
  retryDelayMs:    parseInt(process.env.RETRY_DELAY    || "2000"),
  maxRetries:      parseInt(process.env.MAX_RETRIES    || "30"),
  mintOnce:        process.env.MINT_ONCE !== "false",
  minBalanceEth:   process.env.MIN_BALANCE_ETH         || "0.0001",
  mintStartTime:   process.env.MINT_START_TIME         || null,
  checkIntervalMs: parseInt(process.env.CHECK_INTERVAL || "2000"),
};

const EXPLORER_API = {
  ethereum:  { url: "https://api.etherscan.io/v2/api?chainid=1",     key: process.env.ETHERSCAN_API_KEY   || "" },
  arbitrum:  { url: "https://api.etherscan.io/v2/api?chainid=42161", key: process.env.ARBISCAN_API_KEY    || "" },
  base:      { url: "https://api.etherscan.io/v2/api?chainid=8453",  key: process.env.BASESCAN_API_KEY    || "" },
  polygon:   { url: "https://api.etherscan.io/v2/api?chainid=137",   key: process.env.POLYGONSCAN_API_KEY || "" },
  optimism:  { url: "https://api.etherscan.io/v2/api?chainid=10",    key: process.env.OPTIMISM_API_KEY    || "" },
  avalanche: { url: "https://api.etherscan.io/v2/api?chainid=43114", key: process.env.SNOWTRACE_API_KEY   || "" },
  robinhood: { url: "https://robinhoodchain.blockscout.com/api",          key: "" },
};

const FALLBACK_ABI = [
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function paused() view returns (bool)",
  "function price() view returns (uint256)",
  "function mintPrice() view returns (uint256)",
  "function cost() view returns (uint256)",
  "function mint(uint256 quantity) payable",
  "function mint(address to, uint256 quantity) payable",
  "function publicMint(uint256 quantity) payable",
  "function claim() payable",
  "function claim(uint256 quantity) payable",
  "function freeMint() payable",
  "function safeMint(address to) payable",
  "function mintTo(address to, uint256 quantity) payable",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const MINT_KEYWORDS = ["mint", "claim", "free", "drop", "collect", "redeem", "purchase"];
const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const SEADROP_ABI = [
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
];

async function tryRead(contract, fn, ...args) {
  try { return await contract[fn](...args); } catch { return null; }
}

function formatCountdown(ms) {
  if (ms <= 0) return "NOW";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + "h " + m + "m " + sec + "s";
  if (m > 0) return m + "m " + sec + "s";
  return sec + "s";
}

async function fetchABIFromExplorer(contractAddress, chain) {
  const explorer = EXPLORER_API[chain];
  if (!explorer) return null;
  try {
    const url = explorer.url + "&module=contract&action=getabi&address=" + contractAddress + "&apikey=" + explorer.key;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.status !== "1" || !data.result) return null;
    const abi = JSON.parse(data.result);
    log("✅ Fetched real ABI from " + chain + " explorer (" + abi.length + " functions)");
    return abi;
  } catch { return null; }
}

function findMintFunctions(abi) {
  if (!Array.isArray(abi)) return [];
  return abi.filter((item) => {
    if (item.type !== "function") return false;
    if (item.stateMutability === "view" || item.stateMutability === "pure") return false;
    return MINT_KEYWORDS.some((kw) => (item.name || "").toLowerCase().includes(kw));
  });
}

async function resolveMintTime(collection, contract) {
  if (collection.mintStartTime) {
    const t = new Date(collection.mintStartTime);
    log("⏰ Mint time (OpenSea API): " + t.toUTCString());
    return t;
  }
  if (CONFIG.mintStartTime) {
    const t = new Date(CONFIG.mintStartTime);
    if (!isNaN(t.getTime())) {
      log("⏰ Mint time (.env): " + t.toUTCString());
      return t;
    }
  }
  for (const fn of ["mintStartTime", "startTime", "publicSaleStartTime", "saleStartTime"]) {
    const ts = await tryRead(contract, fn);
    if (ts !== null && ts > 0n) {
      const t = new Date(Number(ts) * 1000);
      log("⏰ Mint time (contract): " + t.toUTCString());
      return t;
    }
  }
  log("⏰ No scheduled time — firing immediately.");
  return null;
}

async function waitForMintTime(mintTime) {
  if (!mintTime) return;
  const target = mintTime.getTime();
  if (Date.now() >= target) { log("✅ Mint time passed — firing now."); return; }

  log("\n⏳ Bot armed — " + formatCountdown(target - Date.now()) + " until mint");
  log("   Target: " + mintTime.toUTCString());
  log("   Fires automatically — leave this running.\n");

  // Sleep until 10s before mint
  while (Date.now() < target - 10_000) {
    const rem = target - Date.now();
    if (rem > 3_600_000)   { process.stdout.write("\r⏳  " + formatCountdown(rem) + " until mint...   "); await sleep(30_000); }
    else if (rem > 60_000) { process.stdout.write("\r⏳  " + formatCountdown(rem) + " until mint...   "); await sleep(5_000);  }
    else                   { process.stdout.write("\r⏳  " + formatCountdown(rem) + " until mint...   "); await sleep(1_000);  }
  }

  // Final 10s — 10ms ultra precision spin
  process.stdout.write("\n");
  log("🔥 FINAL 10 SECONDS — ultra precision mode...");

  // Pre-fetch gas price NOW so its ready to fire instantly
  log("⚡ Pre-fetching gas price...");
  try {
    const provider0 = new (require("ethers").ethers.JsonRpcProvider)(rpcUrl || "https://mainnet.base.org");
    await provider0.getFeeData();
    log("⚡ Gas price cached and ready!");
  } catch(_) {}

  while (Date.now() < target - 10) {
    const rem = target - Date.now();
    process.stdout.write("\r🚨 FIRING IN " + (rem / 1000).toFixed(3) + "s   ");
    await new Promise(r => setTimeout(r, 10)); // 10ms precision
  }
  // Busy-wait the final 10ms — no async, no delays
  while (Date.now() < target) {}
  process.stdout.write("\n");
  log("🟢 " + new Date().toISOString() + " — FIRING NOW!");
}

async function checkBalance(provider, address) {
  const balance    = await provider.getBalance(address);
  const minBalance = ethers.parseEther(CONFIG.minBalanceEth);
  if (balance < minBalance) {
    log("💸 Balance too low! Have: " + ethers.formatEther(balance) + " ETH", "ERROR");
    return false;
  }
  return true;
}

async function trySeaDrop(nftAddress, wallet, provider, gasPrice, totalValue, quantity) {
  const feeRecipient = "0x0000a26b00c1F0DF003000390027140000fAa719";
  const seadrop = new ethers.Contract(SEADROP_ADDRESS, SEADROP_ABI, wallet);
  log("🌊 SeaDrop — mintPublic()...");
  const tx = await seadrop.mintPublic(nftAddress, feeRecipient, wallet.address, quantity, { gasPrice, value: totalValue });
  log("   Tx: " + tx.hash);
  const receipt = await tx.wait();
  log("✅ Minted via SeaDrop! Block #" + receipt.blockNumber);
  return receipt;
}

async function instantMint(contract, wallet, provider, abi, nftAddress) {
  const feeData    = await provider.getFeeData();
  // Boost gas 3x for priority inclusion — beats other minters
  const baseGas    = feeData.gasPrice || ethers.parseUnits("1", "gwei");
  const gasPrice   = baseGas * 3n;
  log("   Boosted gas: " + parseFloat(ethers.formatUnits(gasPrice, "gwei")).toFixed(4) + " Gwei (3x boost)");
  const totalValue = ethers.parseEther(CONFIG.mintValueEth) * BigInt(CONFIG.mintAmount);
  const opts       = { gasPrice, value: totalValue };

  log("💨 INSTANT MINT FIRING");
  log("   Value: " + ethers.formatEther(totalValue) + " ETH | Gas: " + parseFloat(ethers.formatUnits(gasPrice, "gwei")).toFixed(3) + " Gwei");

  const isSeaDrop = Array.isArray(abi) && abi.some(f => f.name === "mintSeaDrop");
  if (isSeaDrop) return await trySeaDrop(nftAddress, wallet, provider, gasPrice, totalValue, CONFIG.mintAmount);

  const mintFns = findMintFunctions(abi);
  const attempts = [];

  for (const fn of mintFns) {
    const inputs = fn.inputs || [];
    const name   = fn.name;
    if (inputs.length === 0)
      attempts.push({ label: name + "()", call: () => contract[name](opts) });
    else if (inputs.length === 1 && inputs[0].type === "uint256")
      attempts.push({ label: name + "(qty)", call: () => contract[name](CONFIG.mintAmount, opts) });
    else if (inputs.length === 1 && inputs[0].type === "address")
      attempts.push({ label: name + "(addr)", call: () => contract[name](wallet.address, opts) });
    else if (inputs.length === 2 && inputs[0].type === "address" && inputs[1].type === "uint256")
      attempts.push({ label: name + "(addr,qty)", call: () => contract[name](wallet.address, CONFIG.mintAmount, opts) });
    else if (inputs.length === 2 && inputs[0].type === "uint256" && inputs[1].type === "address")
      attempts.push({ label: name + "(qty,addr)", call: () => contract[name](CONFIG.mintAmount, wallet.address, opts) });
  }

  if (attempts.length === 0) {
    attempts.push(
      { label: "mint(uint256)",         call: () => contract["mint(uint256)"](CONFIG.mintAmount, opts) },
      { label: "mint(address,uint256)", call: () => contract["mint(address,uint256)"](wallet.address, CONFIG.mintAmount, opts) },
      { label: "claim()",               call: () => contract["claim()"](opts) },
      { label: "publicMint(uint256)",   call: () => contract.publicMint(CONFIG.mintAmount, opts) },
      { label: "freeMint()",            call: () => contract.freeMint(opts) },
    );
  }

  log("   Functions: " + attempts.map(a => a.label).join(", "));

  for (const { label, call } of attempts) {
    try {
      log("🚀 " + label + "...");
      const tx      = await call();
      log("   Tx: " + tx.hash);
      const receipt = await tx.wait();
      log("✅ Minted! Block #" + receipt.blockNumber + " | Gas: " + receipt.gasUsed);
      return receipt;
    } catch (err) {
      if (err.code === "INSUFFICIENT_FUNDS" || err.message?.includes("insufficient funds")) {
        log("💸 Insufficient funds.", "ERROR"); throw err;
      }
      if (err.code === "CALL_EXCEPTION" || err.message?.includes("no matching function") || err.message?.includes("ambiguous function")) {
        log("   ↳ " + label + " not compatible"); continue;
      }
      throw err;
    }
  }
  throw new Error("No compatible mint function found.");
}

async function startMintBotWallet(collection, privateKey, walletLabel, sharedAbi) {
  const { contractAddress, chain, rpcUrl, name } = collection;
  if (!rpcUrl) throw new Error("No RPC URL for chain: " + chain);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(privateKey, provider);

  log("[" + walletLabel + "] Wallet: " + wallet.address);

  let abi = sharedAbi || await fetchABIFromExplorer(contractAddress, chain);
  if (!abi) { abi = FALLBACK_ABI; }

  const contract  = new ethers.Contract(contractAddress, abi, wallet);
  const balance   = await provider.getBalance(wallet.address);
  const isSeaDrop = abi.some(f => f.name === "mintSeaDrop");

  log("[" + walletLabel + "] Balance: " + ethers.formatEther(balance) + " ETH");
  log("[" + walletLabel + "] Protocol: " + (isSeaDrop ? "SeaDrop" : "Standard"));

  if (balance < ethers.parseEther("0.0001")) {
    log("[" + walletLabel + "] ⚠️  Balance too low — skipping this wallet", "ERROR");
    return;
  }

  let failures = 0;
  let minted   = false;

  while (!minted) {
    try {
      await instantMint(contract, wallet, provider, abi, contractAddress);
      minted = true;
      log("[" + walletLabel + "] 🎉 MINT SUCCESS! https://opensea.io/" + wallet.address);
      return true;
    } catch (err) {
      failures++;
      log("[" + walletLabel + "] Attempt " + failures + "/" + CONFIG.maxRetries + ": " + err.message, "ERROR");
      if (failures >= CONFIG.maxRetries) {
        log("[" + walletLabel + "] Max retries reached.", "ERROR");
        return false;
      }
      await sleep(CONFIG.retryDelayMs);
    }
  }
}

async function startMintBot(collection) {
  const { contractAddress, chain, rpcUrl, name } = collection;
  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");
  if (!rpcUrl) throw new Error("No RPC URL for chain: " + chain);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  log("🔎 Fetching contract ABI from " + chain + " explorer...");
  let abi = await fetchABIFromExplorer(contractAddress, chain);
  if (!abi) { log("⚠️  Using fallback ABI."); abi = FALLBACK_ABI; }

  const contract  = new ethers.Contract(contractAddress, abi, wallet);
  const balance   = await provider.getBalance(wallet.address);
  const isSeaDrop = abi.some(f => f.name === "mintSeaDrop");
  const mintFns   = findMintFunctions(abi);

  console.log("\n─────────────────────────────────────────");
  log("Wallet:     " + wallet.address);
  log("Balance:    " + ethers.formatEther(balance) + " ETH");
  log("Collection: " + name);
  log("Contract:   " + contractAddress);
  log("Chain:      " + chain);
  log("Mint amt:   " + CONFIG.mintAmount);
  log("Protocol:   base/SeaDrop");
  console.log("─────────────────────────────────────────\n");

  // Collect all private keys — PRIVATE_KEY + PRIVATE_KEY_2 + PRIVATE_KEY_3
  const keys = [
    process.env.PRIVATE_KEY,
    process.env.PRIVATE_KEY_2,
    process.env.PRIVATE_KEY_3,
    process.env.PRIVATE_KEY_4,
    process.env.PRIVATE_KEY_5,
  ].filter(Boolean);

  log("👛 Wallets loaded: " + keys.length);

  // Fetch ABI once for display
  log("🔎 Fetching contract ABI from " + chain + " explorer...");
  let sharedAbi = await fetchABIFromExplorer(contractAddress, chain);
  if (!sharedAbi) { log("⚠️  Using fallback ABI."); sharedAbi = FALLBACK_ABI; }

  const isSeaDropProto = sharedAbi.some(f => f.name === "mintSeaDrop");
  const sharedMintFns = findMintFunctions(sharedAbi);

  console.log("\n─────────────────────────────────────────");
  log("Collection: " + name);
  log("Contract:   " + contractAddress);
  log("Chain:      " + chain);
  log("Mint amt:   " + CONFIG.mintAmount + " per wallet");
  log("Wallets:    " + keys.length);
  log("Protocol:   base/SeaDrop");
  console.log("─────────────────────────────────────────\n");

  // Use first wallet for time detection only
  const provider0 = new ethers.JsonRpcProvider(rpcUrl);
  const wallet0   = new ethers.Wallet(keys[0], provider0);
  const contract0 = new ethers.Contract(contractAddress, sharedAbi, wallet0);

  const mintTime = await resolveMintTime(collection, contract0);
  await waitForMintTime(mintTime);

  // 🚀 Fire ALL wallets simultaneously at mint time
  log("🚀 FIRING ALL " + keys.length + " WALLETS SIMULTANEOUSLY!");
  const results = await Promise.allSettled(
    keys.map((key, i) => startMintBotWallet(collection, key, "Wallet-" + (i + 1), sharedAbi))
  );

  const succeeded = results.filter(r => r.status === "fulfilled" && r.value === true).length;
  const failed    = results.length - succeeded;

  console.log("\n🎉 ══════════════════════════════════════");
  log("RESULTS: " + succeeded + " minted, " + failed + " failed");
  console.log("══════════════════════════════════════\n");
  process.exit(succeeded > 0 ? 0 : 1);
}

module.exports = { startMintBot };
