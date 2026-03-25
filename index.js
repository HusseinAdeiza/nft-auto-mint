#!/usr/bin/env node
/**
 * NFT Auto-Mint Bot
 * Enter any OpenSea collection URL and this bot will monitor
 * eligibility and mint automatically when conditions are met.
 */

require("dotenv").config();
const { ethers } = require("ethers");
const readline = require("readline");
const { resolveCollectionFromUrl } = require("./src/opensea");
const { startMintBot } = require("./src/minter");
const { validateEnv, log, sleep } = require("./src/utils");

async function promptUrl() {
  // If URL passed as CLI argument, use it
  if (process.argv[2]) return process.argv[2].trim();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("\n🔗 Paste your OpenSea collection URL: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║        NFT Auto-Mint Bot 🤖          ║");
  console.log("╚══════════════════════════════════════╝\n");

  // 1. Validate environment variables
  validateEnv();

  // 2. Get OpenSea URL from user
  const url = await promptUrl();
  if (!url || !url.includes("opensea.io")) {
    log("Invalid URL. Must be an OpenSea collection URL.", "ERROR");
    log('Example: https://opensea.io/collection/my-collection-slug', "ERROR");
    process.exit(1);
  }

  log(`Resolving collection from: ${url}`);

  // 3. Resolve contract address + chain from OpenSea URL
  const collection = await resolveCollectionFromUrl(url);
  if (!collection) {
    log("Could not resolve contract from this OpenSea URL.", "ERROR");
    log("Make sure the collection exists and the URL is correct.", "ERROR");
    process.exit(1);
  }

  log(`✅ Collection: ${collection.name}`);
  log(`✅ Contract:   ${collection.contractAddress}`);
  log(`✅ Chain:      ${collection.chain}`);

  // 4. Start the mint bot
  await startMintBot(collection);
}

main().catch((err) => {
  log(err.message, "FATAL");
  process.exit(1);
});
