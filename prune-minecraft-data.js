// Runs automatically after `npm install`.
// mineflayer pulls in "minecraft-data", which bundles full Bedrock-edition
// data (~280 MB) that a Java-edition AFK bot never uses. This deletes it,
// keeping only "common" and "latest" (required by the library internals),
// so the whole node_modules folder stays tiny (~130 MB instead of ~410 MB).

// Runs automatically after `npm install`.
// mineflayer pulls in "minecraft-data", which bundles full Bedrock-edition
// data (~280 MB) that a Java-edition AFK bot never uses. This deletes it,
// keeping only "common" and "latest" (required by the library internals),
// so the whole node_modules folder stays tiny (~130 MB instead of ~410 MB).
//
// This script is defensive on purpose: if anything goes wrong (module not
// found, permission issue, different folder layout, etc.) it just logs a
// warning and exits 0, so it can NEVER break `npm install`.

const fs = require('fs');
const path = require('path');

function findBedrockDir() {
  // Ask Node directly where minecraft-data's package.json lives — this
  // works regardless of nesting/hoisting differences between hosts.
  const pkgJsonPath = require.resolve('minecraft-data/package.json', {
    paths: [process.cwd()],
  });
  const moduleRoot = path.dirname(pkgJsonPath);
  return path.join(moduleRoot, 'minecraft-data', 'data', 'bedrock');
}

try {
  const bedrockDir = findBedrockDir();

  if (!fs.existsSync(bedrockDir)) {
    console.log('[prune] Bedrock data folder not found, nothing to prune.');
    process.exit(0);
  }

  const keep = new Set(['common', 'latest']);
  let freedEntries = 0;

  for (const entry of fs.readdirSync(bedrockDir)) {
    if (!keep.has(entry)) {
      fs.rmSync(path.join(bedrockDir, entry), { recursive: true, force: true });
      freedEntries++;
    }
  }

  console.log(`[prune] Removed ${freedEntries} unused Bedrock version folders (Java-only bot doesn't need them).`);
} catch (err) {
  console.warn('[prune] Skipped (non-fatal):', err.message);
}

process.exit(0);
