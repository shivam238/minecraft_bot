# Minecraft Bot

A Mineflayer-based Minecraft bot with AI chat (OpenRouter/Gemini/OpenAI) and a Flask keep-alive server for Replit free-plan uptime.

## How to run

The workflow **Start application** runs `node bot.js`, which:
1. Spawns `keep_alive.py` — a Flask server on port 8080 (`/` and `/ping`)
2. Connects to the Minecraft server defined in `config.json`

## Configuration

### `config.json` (committed, safe to edit)
| Key | Default | Notes |
|---|---|---|
| `host` | `SHIBU2.aternos.me` | Minecraft server hostname |
| `port` | `48595` | Minecraft server port |
| `username` | `LazyBoy` | Bot's in-game name |
| `owners` | `["darkeeidea"]` | IGNs who can run owner commands |
| `ai.enabled` | `true` | Toggle AI chat on/off |
| `ai.primaryModel` | `google/gemini-2.5-flash` | Via OpenRouter |

### Environment secrets (set in Replit Secrets)
| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | AI chat (primary) |
| `GEMINI_API_KEY` | AI chat (fallback) |
| `OPENAI_API_KEY` | AI chat (fallback) |
| `PASSWORD` | Server `/login` or `/register` password |

## Keep-alive & UptimeRobot

`keep_alive.py` runs a Flask server (port 8080) with two routes:
- `GET /` → `"Bot is alive!"`
- `GET /ping` → `"pong"`

**To set up UptimeRobot (free):**
1. Copy the public Replit URL printed in the console at startup (e.g. `https://<slug>.repl.co`)
2. Go to [uptimerobot.com](https://uptimerobot.com) → Add New Monitor
3. Type: **HTTP(S)** | URL: your Replit URL | Interval: **5 minutes**
4. Save — UptimeRobot will ping your repl every 5 minutes, keeping it awake

## Console commands (when TTY is available)
| Command | Action |
|---|---|
| `start` | Connect/reconnect the bot |
| `stop` | Fully stop (no reconnect) |
| `status` | Show lifecycle state |
| `help` | Print command list |

In-game owner command: `!shutdown`

## User preferences
- Keep-alive via Flask (`keep_alive.py`) on port 8080, spawned from `bot.js` using `child_process.spawn`
- Minimize resource usage; daemon thread for Flask server
