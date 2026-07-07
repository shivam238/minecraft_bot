# Minecraft Bot (mineflayer)

A Minecraft bot built with [mineflayer](https://github.com/PrismarineJS/mineflayer) that joins a server, behaves like a real player, and responds to owner commands via chat. Includes an optional AI copilot (OpenRouter / Gemini / OpenAI / Grok) for natural-language command parsing.

## Stack
- **Runtime**: Node.js
- **Bot**: `mineflayer` + `mineflayer-pathfinder` + `mineflayer-pvp` + `mineflayer-auto-eat`
- **AI**: OpenRouter (primary), Gemini / OpenAI / Grok (fallbacks), rule-engine (offline fallback)
- **Optional watcher**: Python (`aternos_watcher.py`) — keeps Aternos server alive

## How to run

```
node bot.js
```

The bot auto-starts on launch. Console commands: `start`, `stop`, `status`, `help`.

To run the Aternos watcher separately:
```
./venv310/bin/python main.py
```

## Configuration

Edit `config.json`:
- `host` / `port` — Minecraft server address
- `username` — bot's Minecraft username
- `owners` — list of players who can give the bot commands
- `autoDefense` — auto-fight hostile mobs
- `creeperAvoidDistance` — blocks to maintain from creepers
- `followMaxDistance` — max distance before follow mode aborts
- `ai.enabled` / `ai.apiKey` — OpenRouter AI copilot

## Secrets / Environment variables

See `.env.example` for all variables. Key ones:
- `OPENROUTER_API_KEY` — AI copilot (optional but recommended)
- `GEMINI_API_KEY` / `OPENAI_API_KEY` / `GROK_API_KEY` — AI fallback providers
- `PASSWORD` — for servers requiring `/login`
- `ATERNOS_USERNAME` / `ATERNOS_PASSWORD` — Aternos watcher

## Priority system (high → low)

| Priority | Name | Trigger |
|----------|------|---------|
| 0 | VOID_ESCAPE | Actively falling with nothing below |
| 1 | EMERGENCY_SURVIVAL | Health < 6 |
| 2 | CREEPER_ESCAPE | Creeper within range |
| 3 | COMBAT | Hostile mob / manual target |
| 4 | SLEEPING | Bot in bed |
| 5 | FOLLOWING | `!follow` command active |
| 6 | GUARDING | `!guard` command active |
| 7 | AFK | Default wandering mode |
| 8 | IDLE | Fallback |

## User preferences
- Keep existing project structure and file layout.
