# Setup Guide

## Prerequisites
- Node.js 20+ (no external dependencies needed)
- Bash (for unified funding script)

## Installation

```bash
git clone https://github.com/Don-GBot/G-Alpha.git
cd G-Alpha
cp config/example.env .env
# Edit .env with your API keys
```

No `npm install` needed — all scripts use Node.js built-ins only.

## Quick Start

```bash
# Run any script directly
npm run funding          # CEX funding rates
npm run funding:hl       # Hyperliquid funding + OI
npm run funding:all      # Merged CEX + Hyperliquid
npm run rsi:extreme      # RSI extremes only
npm run ema:funding      # EMA for funding watchlist
npm run ema:scan         # EMA breakout scanner
npm run squeeze          # Triple confluence alerts
npm run polymarket       # Polymarket odds
npm run reddit           # Reddit sentiment scan
```

## Full Pipeline (what the alert system runs)

```bash
# Tier 1: Triple confluence (every 15min)
npm run funding:all
npm run rsi:extreme
npm run ema:funding
npm run squeeze

# Tier 2: Breakout scanner (standalone)
npm run ema:scan
```

Output goes to `data/` as JSON files that downstream scripts consume.

## Environment Variables

| Variable | Required | Used by |
|----------|----------|---------|
| `CRYPTOCOMPARE_API_KEY` | For RSI | rsi-checker |
| `HELIUS_API_KEY` | Optional | (future use) |

Hyperliquid, Polymarket, and CEX funding endpoints are all public — no keys needed.

## How the Pipeline Works

```
funding-unified.sh
  ├── funding-rates.js (OKX, Bitget, Gate.io)
  └── hyperliquid-funding.sh (Hyperliquid)
        ↓ merged JSON
rsi-checker.js --extreme
        ↓ RSI overlay
ema-checker.js --funding
        ↓ EMA overlay
squeeze-monitor.js
        ↓ ALERT (funding + RSI + EMA confluence)
```

Each script reads the previous script's output from `data/` and enriches it.

## Automating

Use cron, PM2, or [OpenClaw](https://github.com/openclaw/openclaw) to schedule the pipeline. Example cron:

```bash
*/15 * * * * cd /path/to/G-Alpha && npm run funding:all && npm run rsi:extreme && npm run ema:funding && npm run squeeze
```
