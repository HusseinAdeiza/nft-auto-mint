/**
 * src/opensea.js
 * Parses OpenSea URLs, resolves collection/contract metadata,
 * and AUTO-DETECTS mint schedule from OpenSea API v2.
 */

const { log } = require("./utils");

const CHAIN_RPC_MAP = {
  ethereum:  process.env.RPC_URL_ETHEREUM  || process.env.RPC_URL,
  polygon:   process.env.RPC_URL_POLYGON   || "https://polygon-rpc.com",
  base:      process.env.RPC_URL_BASE      || "https://mainnet.base.org",
  arbitrum:  process.env.RPC_URL_ARBITRUM  || "https://arb1.arbitrum.io/rpc",
  optimism:  process.env.RPC_URL_OPTIMISM  || "https://mainnet.optimism.io",
  avalanche: process.env.RPC_URL_AVALANCHE || "https://api.avax.network/ext/bc/C/rpc",
  solana:    null,
  klaytn:    null,
};

// ─── URL PARSER ───────────────────────────────────────────────────────────────

function parseOpenSeaUrl(url) {
  try {
    const parsed = new URL(url);
    const parts  = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "collection" && parts[1]) {
      return { type: "slug", slug: parts[1] };
    }
    if (parts[0] === "assets" && parts.length >= 3) {
      return { type: "asset", chain: parts[1], contractAddress: parts[2] };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── OPENSEA API HELPERS ──────────────────────────────────────────────────────

function getHeaders() {
  const headers = { accept: "application/json" };
  if (process.env.OPENSEA_API_KEY) headers["x-api-key"] = process.env.OPENSEA_API_KEY;
  return headers;
}

async function osGet(path) {
  const res = await fetch(`https://api.opensea.io/api/v2${path}`, { headers: getHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenSea API ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

// ─── MINT SCHEDULE AUTO-DETECTION ────────────────────────────────────────────

async function fetchMintSchedule(slug) {

  // Method 1: /drops endpoint
  try {
    const data  = await osGet(`/collections/${slug}/drops`);
    const drops = data.drops || data.results || [];
    for (const drop of drops) {
      const stages = drop.stages || drop.mint_stages || [];
      for (const stage of stages) {
        const startIso =
          stage.start_time || stage.startTime || stage.starts_at ||
          stage.start_date || drop.start_date || drop.starts_at || null;
        if (startIso) {
          const t = new Date(startIso);
          if (!isNaN(t.getTime())) {
            log(`📅 Schedule detected via /drops: ${t.toUTCString()}`);
            log(`   Stage: ${stage.stage || stage.name || "Public"}`);
            return { startTime: t, stage: stage.stage || stage.name || "Public", source: "drops" };
          }
        }
      }
      const dropStart = drop.start_date || drop.starts_at || drop.start_time;
      if (dropStart) {
        const t = new Date(dropStart);
        if (!isNaN(t.getTime())) {
          log(`📅 Schedule detected via /drops: ${t.toUTCString()}`);
          return { startTime: t, stage: "Public", source: "drops" };
        }
      }
    }
  } catch (_) {}

  // Method 2: Collection detail fields
  try {
    const data = await osGet(`/collections/${slug}`);
    const candidates = [
      data.drop_date, data.launch_date, data.mint_date, data?.stats?.drop_date
    ].filter(Boolean);
    for (const c of candidates) {
      const t = new Date(c);
      if (!isNaN(t.getTime()) && t.getTime() > Date.now() - 86_400_000) {
        log(`📅 Schedule detected via collection detail: ${t.toUTCString()}`);
        return { startTime: t, stage: "Public", source: "collection" };
      }
    }
  } catch (_) {}

  return null;
}

// ─── COLLECTION RESOLVER ──────────────────────────────────────────────────────

async function fetchCollectionBySlug(slug) {
  const data      = await osGet(`/collections/${slug}`);
  const contracts = data.contracts || [];
  if (!contracts.length) throw new Error("No contracts found for this collection.");

  const preferred = contracts.find((c) => c.chain === "ethereum") || contracts[0];
  const chain     = preferred.chain;
  if (!CHAIN_RPC_MAP[chain]) {
    throw new Error(`Chain "${chain}" is not a supported EVM chain.`);
  }

  log(`🔍 Auto-detecting mint schedule...`);
  const schedule = await fetchMintSchedule(slug);

  return {
    name:           data.name || slug,
    slug,
    contractAddress: preferred.address,
    chain,
    rpcUrl:          CHAIN_RPC_MAP[chain],
    openseaUrl:      `https://opensea.io/collection/${slug}`,
    mintStartTime:   schedule?.startTime || null,
    mintStage:       schedule?.stage     || null,
    scheduleSource:  schedule?.source    || null,
  };
}

async function resolveCollectionFromUrl(url) {
  const parsed = parseOpenSeaUrl(url);
  if (!parsed) throw new Error("Could not parse OpenSea URL.");

  if (parsed.type === "slug") {
    log(`Fetching collection data for slug: ${parsed.slug}`);
    return await fetchCollectionBySlug(parsed.slug);
  }

  if (parsed.type === "asset") {
    const { chain, contractAddress } = parsed;
    if (!CHAIN_RPC_MAP[chain]) throw new Error(`Chain "${chain}" not supported.`);
    return {
      name: contractAddress, slug: null, contractAddress, chain,
      rpcUrl: CHAIN_RPC_MAP[chain], openseaUrl: url,
      mintStartTime: null, mintStage: null, scheduleSource: null,
    };
  }
  return null;
}

module.exports = { resolveCollectionFromUrl, parseOpenSeaUrl, CHAIN_RPC_MAP };
