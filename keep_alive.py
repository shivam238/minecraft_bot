"""
keep_alive.py — lightweight Flask ping server for Replit uptime.
Run via UptimeRobot (every 5 min) to prevent the free-tier repl from sleeping.
"""

import os
import threading
from flask import Flask

app = Flask(__name__)


@app.route("/")
def home():
    return "Bot is alive!"


@app.route("/ping")
def ping():
    return "pong"


def run():
    app.run(host="0.0.0.0", port=8080, threaded=True)


def keep_alive():
    t = threading.Thread(target=run, daemon=True)
    t.start()

    slug = os.environ.get("REPL_SLUG", "")
    owner = os.environ.get("REPL_OWNER", "")
    dev_domain = os.environ.get("REPLIT_DEV_DOMAIN", "")

    if dev_domain:
        url = f"https://{dev_domain}"
    elif slug and owner:
        url = f"https://{slug}.{owner}.repl.co"
    else:
        url = "http://0.0.0.0:8080"

    print(f"[keep_alive] Web server running at: {url}")
    print(f"[keep_alive] Add this URL to UptimeRobot with a 5-minute HTTP(S) monitor.")
    return url


if __name__ == "__main__":
    keep_alive()
    # Block main thread so the server keeps running when run standalone
    threading.Event().wait()
