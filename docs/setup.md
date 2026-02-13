# Setup Guide

## Prerequisites
- Node.js 22+ or Bun 1.3+
- OpenClaw installed and configured
- Telegram bot token (via @BotFather)

## Installation

```bash
git clone https://github.com/Don-GBot/G-Alpha.git
cd G-Alpha
cp config/example.env .env
# Edit .env with your API keys
```

## Running Scripts Standalone

```bash
# Funding rates (CEX)
node scripts/funding-rates.js

# Hyperliquid funding + OI
bash scripts/hyperliquid-funding.sh

# Unified funding (CEX + HL merged)
bash scripts/funding-unified.sh

# RSI check (extreme only)
node scripts/rsi-checker.js --extreme

# EMA analysis (for funding watchlist)
node scripts/ema-checker.js --funding

# Squeeze monitor (triple confluence)
node scripts/squeeze-monitor.js

# EMA breakout scanner
node scripts/ema-breakout-scanner.js
```

## Wiring into OpenClaw

Add cron jobs in your OpenClaw config to run the alert pipeline on schedule. See the OpenClaw docs for cron configuration.

## Data Sources
- **Hyperliquid**: Public API, no auth, no rate limits. 228+ coins.
- **CryptoCompare**: Free tier works. Used for RSI calculations.
- **CEX APIs**: OKX, Bitget, Gate.io public endpoints. No auth needed for funding rates.
- **Polymarket**: Public API for odds. Trading geo-blocked in some regions.
