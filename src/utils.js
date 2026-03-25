/**
 * src/utils.js
 * Shared helpers: logging, sleep, and env validation.
 */

function log(msg, level = "INFO") {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const icon = { INFO: "·", WARN: "⚠", ERROR: "✖", FATAL: "💀", ACTION: "→" }[level] || "·";
  console.log(`[${ts}] ${icon}  ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function validateEnv() {
  const required = [{ key: "PRIVATE_KEY", hint: "Your wallet private key (no 0x prefix needed)" }];
  const warnings = [];

  for (const { key, hint } of required) {
    if (!process.env[key]) {
      console.error(`\n✖  Missing required env var: ${key}`);
      console.error(`   Hint: ${hint}`);
      console.error(`   Set it in your .env file.\n`);
      process.exit(1);
    }
  }

  if (!process.env.OPENSEA_API_KEY) {
    warnings.push("OPENSEA_API_KEY not set — collection lookup may be rate-limited by OpenSea.");
  }

  if (!process.env.RPC_URL && !process.env.RPC_URL_ETHEREUM) {
    warnings.push("RPC_URL not set — will use public fallback RPCs (may be slow/unreliable).");
  }

  if (warnings.length) {
    console.log("\n⚠  Warnings:");
    warnings.forEach((w) => console.log(`   - ${w}`));
    console.log();
  }
}

module.exports = { log, sleep, validateEnv };
