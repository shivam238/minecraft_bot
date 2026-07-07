function ok(message) {
  console.log(`✅ ${message}`);
}

function fail(message, err) {
  if (err) {
    console.error(`❌ ${message}:`, err instanceof Error ? err.message : err);
  } else {
    console.error(`❌ ${message}`);
  }
}

function warn(message) {
  console.warn(`⚠️ ${message}`);
}

function info(message) {
  console.log(`ℹ️ ${message}`);
}

function action(label, message, success) {
  if (success) {
    console.log(`✅ [${label}] ${message}`);
  } else {
    console.error(`❌ [${label}] ${message}`);
  }
}

module.exports = { ok, fail, warn, info, action };
