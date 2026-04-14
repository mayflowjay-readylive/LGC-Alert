# LG C4 Price Monitor

Monitors Danish retailers for LG C4 OLED TV prices and fires a Discord alert when a price drops below your threshold.

Uses Claude with web search to check live prices — no brittle scrapers.

## Setup

### 1. Clone / push to GitHub
Push this folder to a new GitHub repo.

### 2. Deploy on Railway
1. New Project → Deploy from GitHub repo → select this repo
2. Add the following environment variables in Railway's dashboard:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `DISCORD_WEBHOOK_URL` | Discord channel webhook URL |
| `PRICE_THRESHOLD_55` | Alert if 55" drops to/below this (DKK). Default: `7000` |
| `PRICE_THRESHOLD_65` | Alert if 65" drops to/below this (DKK). Default: `10000` |
| `CHECK_INTERVAL_HOURS` | How often to check. Default: `6` |

### 3. That's it
Railway will run `npm start`. The service checks immediately on startup, then every N hours.

## How it works

1. Calls Claude API with web search enabled
2. Claude searches Danish retailers and price comparison sites (PriceRunner, Prisjagt, Komplett, etc.)
3. Returns structured JSON with current prices
4. Compares against your thresholds
5. Sends a Discord embed alert if below threshold **and** it's a new low (no spam)
6. State persists to `/tmp/alert_state.json` — if the price rises back above threshold, the state resets so a future drop will alert again

## Discord alert example

> 🔥 **LG C4 65" – 9.267 kr.**
> Below your threshold of 10.000 kr. by 733 kr.
> 💰 9.267 kr. | 🏪 Power.dk | 📉 733 kr. under limit

## Tuning thresholds

Based on recent history:
- **55"** — C4 has been as low as ~6.900 kr. (Power clearance, July 2025). Threshold of 7.000–7.500 is reasonable.
- **65"** — C4 has been as low as ~9.267 kr. (Power clearance, July 2025). Threshold of 9.500–10.000 is reasonable.
