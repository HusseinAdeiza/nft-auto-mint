/**
 * src/opensea.js
 * Parses OpenSea URLs and resolves collection/contract metadata
 * using the OpenSea API v2.
 */

const { log } = require("./utils");

// Supported networks and their RPC env vars
const CHAIN_RPC_MAP = {
  ethereum:  process.env.RPC_URL_ETHEREUM  || process.env.RPC_URL,
  polygon:   process.env.RPC_URL_POLYGON   || "https://polygon-rpc.com",
  base:      process.env.RPC_URL_BASE      || "https://mainnet.base.org",
  arbitrum:  process.env.RPC_URL_ARBITRUM  || "https://arb1.arbitrum.io/rpc",
  optimism:  process.env.RPC_URL_OPTIMISM  || "https://mainnet.optimism.io",
  avalanche: process.env.RPC_URL_AVALANCHE || "https://api.avax.network/ext/bc/C/rpc",
  solana:    null, // not EVM — unsupported
  klaytn:    null,
};

/**
 * Parses an OpenSea URL and extracts the collection slug or contract info.
 *
 * Supported URL formats:
 *  - https://opensea.io/collection/{slug}
 *  - https://opensea.io/assets/{chain}/{contractAddress}/{tokenId}
 *  - https://opensea.io/assets/ethereum/{contractAddress}/{tokenId}
 */
function parseOpenSeaUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);

    // Format: /collection/{slug}
    if (parts[0] === "collection" && parts[1]) {
      return { type: "slug", slug: parts[1] };
    }

    // Format: /assets/{chain}/{contractAddress}/{tokenId}
    if (parts[0] === "assets" && parts.length >= 3) {
      const chain = parts[1];
      const contractAddress = parts[2];
      return { type: "asset", chain, contractAddress };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetches collection metadata from the OpenSea API v2.
 * Requires OPENSEA_API_KEY in .env (free tier available at opensea.io/developers).
 */
async function fetchCollectionBySlug(slug) {
  const apiKey = process.env.OPENSEA_API_KEY;
  const headers = { "accept": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  // 1. Get collection info
  const collectionRes = await fetch(
    `https://api.opensea.io/api/v2/collections/${slug}`,
    { headers }
  );

  if (!collectionRes.ok) {
    const err = await collectionRes.text();
    throw new Error(`OpenSea API error (${collectionRes.status}): ${err}`);
  }

  const collectionData = await collectionRes.json();

  // 2. Get contract address from the collection's contracts list
  const contracts = collectionData.contracts || [];
  if (!contracts.length) {
    throw new Error("No contracts found for this collection.");
  }

  // Prefer Ethereum; otherwise take first supported EVM chain
  const preferred = contracts.find((c) => c.chain === "ethereum") || contracts[0];
  const chain = preferred.chain;

  if (!CHAIN_RPC_MAP[chain]) {
    throw new Error(
      `Chain "${chain}" is not supported (Solana/Klaytn are non-EVM). ` +
      `Supported chains: ${Object.keys(CHAIN_RPC_MAP).filter((k) => CHAIN_RPC_MAP[k]).join(", ")}`
    );
  }

  return {
    name: collectionData.name || slug,
    slug,
    contractAddress: preferred.address,
    chain,
    rpcUrl: CHAIN_RPC_MAP[chain],
    openseaUrl: `https://opensea.io/collection/${slug}`,
  };
}

/**
 * Resolves a full OpenSea URL into a collection object:
 * { name, slug, contractAddress, chain, rpcUrl, openseaUrl }
 */
async function resolveCollectionFromUrl(url) {
  const parsed = parseOpenSeaUrl(url);
  if (!parsed) {
    throw new Error("Could not parse OpenSea URL. Supported formats:\n" +
      "  https://opensea.io/collection/{slug}\n" +
      "  https://opensea.io/assets/{chain}/{contractAddress}/{tokenId}");
  }

  if (parsed.type === "slug") {
    log(`Fetching collection data for slug: ${parsed.slug}`);
    return await fetchCollectionBySlug(parsed.slug);
  }

  if (parsed.type === "asset") {
    const chain = parsed.chain;
    if (!CHAIN_RPC_MAP[chain]) {
      throw new Error(`Chain "${chain}" is not a supported EVM chain.`);
    }
    log(`Resolved contract directly from URL.`);
    return {
      name: parsed.contractAddress,
      slug: null,
      contractAddress: parsed.contractAddress,
      chain,
      rpcUrl: CHAIN_RPC_MAP[chain],
      openseaUrl: url,
    };
  }

  return null;
}

module.exports = { resolveCollectionFromUrl, parseOpenSeaUrl, CHAIN_RPC_MAP };
