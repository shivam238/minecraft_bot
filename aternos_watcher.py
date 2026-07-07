"""
Aternos Watcher — auto-starts the server if it goes offline.
Credentials: ATERNOS_USERNAME and ATERNOS_PASSWORD env vars (Replit Secrets).
"""

import os
import sys
import time
import random
from datetime import datetime

# ── Config ──────────────────────────────────────────────────────────────
SERVER_ADDRESS  = "SHIBU2.aternos.me"
CHECK_MIN       = 60    # seconds between checks (min)
CHECK_MAX       = 120   # seconds between checks (max)
# ────────────────────────────────────────────────────────────────────────


def ts():
    return datetime.now().strftime("%H:%M:%S")


def log(msg):
    print(f"[{ts()}] {msg}", flush=True)


def random_delay(lo=3, hi=10):
    time.sleep(random.uniform(lo, hi))


def main():
    # Load environment variables from .env
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

    global SERVER_ADDRESS
    # Dynamically read host from config.json if possible
    try:
        import json
        if os.path.exists("config.json"):
            with open("config.json", "r") as f:
                cfg = json.load(f)
                if "host" in cfg and cfg["host"]:
                    SERVER_ADDRESS = cfg["host"]
    except Exception as e:
        log(f"⚠️  Could not read config.json: {e}")

    username = os.environ.get("ATERNOS_USERNAME", "").strip()
    password = os.environ.get("ATERNOS_PASSWORD", "").strip()

    if not username or not password:
        log("❌  ATERNOS_USERNAME / ATERNOS_PASSWORD secrets/env not set — exiting.")
        sys.exit(1)

    log("🔄  Aternos Watcher starting…")

    # ── Login ──────────────────────────────────────────────────────────
    try:
        from python_aternos import Client
    except ImportError:
        log("❌  python_aternos not installed — run:  pip install python-aternos")
        sys.exit(1)

    session = os.environ.get("ATERNOS_SESSION", "").strip()

    try:
        client = Client()
        if session:
            # Session cookie from browser — bypasses Cloudflare login block
            client.login_with_session(session)
            log("✅  Logged in via session cookie")
        else:
            client.login(username, password)
            log("✅  Logged in with username/password")
    except Exception as e:
        log(f"❌  Login failed: {e}")
        if not session:
            log("    💡 Tip: Set ATERNOS_SESSION secret (browser cookie) to bypass Cloudflare block")
        sys.exit(1)

    # ── Find server ────────────────────────────────────────────────────
    try:
        servers = client.account.list_servers()
    except Exception as e:
        log(f"❌  Could not list servers: {e}")
        sys.exit(1)

    # Fetch info for each server (not fetched by default)
    for s in servers:
        try:
            s.fetch()
        except Exception:
            pass

    server = None
    for s in servers:
        try:
            addr = s.address.lower()
            dom  = s.domain.lower()
            if SERVER_ADDRESS.lower() in addr or dom in SERVER_ADDRESS.lower():
                server = s
                break
        except Exception:
            pass

    if not server:
        # Fall back to first server if only one exists
        if len(servers) == 1:
            server = servers[0]
            log(f"⚠️   Address match failed — using only available server (id={server.servid})")
        else:
            log(f"❌  Server '{SERVER_ADDRESS}' not found among {len(servers)} servers.")
            sys.exit(1)

    try:
        log(f"✅  Monitoring: {server.address}")
    except Exception:
        log(f"✅  Monitoring server id={server.servid}")

    # ── Watch loop ─────────────────────────────────────────────────────
    while True:
        interval = random.randint(CHECK_MIN, CHECK_MAX)
        try:
            server.fetch()                  # refresh status from Aternos
            status = server.status.lower()  # "online", "offline", "starting", etc.
            log(f"Status: {status!r}  |  next check in {interval}s")

            if status in ("offline", "stopped"):
                log("🔄  Server offline — sending start request…")
                random_delay(4, 10)          # human-like pause before clicking start
                server.start()
                log("🚀  Start request sent — waiting for server to come up…")
                random_delay(30, 60)         # give it time before next check

        except Exception as e:
            log(f"⚠️   Error: {e}")
            random_delay(10, 20)

        time.sleep(interval)


if __name__ == "__main__":
    main()
