# G's Alpha ⚡

Open-source trading intelligence pipeline built on [OpenClaw](https://github.com/openclaw/openclaw). Market alerts, squeeze detection, funding rate monitoring — all running from a Telegram channel.

**[@GsDailyAlpha](https://t.me/GsDailyAlpha)** — live alerts, morning briefings, market recaps.

## What's Inside

### Scripts

- `scripts/funding-rates.js` — CEX funding rates (OKX, Bitget, Gate.io)
- `scripts/hyperliquid-funding.sh` — Hyperliquid perps funding + OI + volume
- `scripts/funding-unified.sh` — Merges CEX + Hyperliquid (700+ coins)
- `scripts/rsi-checker.js` — RSI calculations via CryptoCompare
- `scripts/ema-checker.js` — EMA 20/50/200 using Hyperliquid candles
- `scripts/ema-breakout-scanner.js` — Tier 2 EMA crossover/breakout scanner
- `scripts/squeeze-monitor.js` — Triple confluence alerts (funding + RSI + EMA)
- `scripts/multi-tf-analyzer.js` — Multi-timeframe EMA/RSI (1h, 4h, 1d) with trend alignment
- `scripts/orderbook-depth.js` — L2 orderbook depth, bid/ask imbalance, wall detection
- `scripts/volume-scanner.js` — Volume spike/dry-up detection, OI/volume ratio analysis
- `scripts/polymarket-tracker.js` — Polymarket odds monitoring
- `scripts/reddit-scanner.js` — Reddit RSS sentiment scanner

### Alert Pipeline

```
Tier 1 (every 15min): funding-unified → rsi-checker → ema-checker → squeeze-monitor
Tier 2 (standalone):  ema-breakout-scanner (EMA crossovers + breakout signals)
```

## Quick Start

```bash
git clone https://github.com/Don-GBot/G-Alpha.git
cd G-Alpha
cp config/example.env .env
# Edit .env with your API keys

# Run any script
npm run funding          # CEX funding rates
npm run funding:hl       # Hyperliquid funding + OI
npm run funding:all      # Merged CEX + Hyperliquid
npm run rsi:extreme      # RSI extremes only
npm run ema:funding      # EMA for funding watchlist
npm run ema:scan         # EMA breakout scanner
npm run squeeze          # Triple confluence alerts
npm run polymarket       # Polymarket odds
npm run reddit           # Reddit sentiment scan
npm run multi-tf         # Multi-timeframe analysis (1h/4h/1d)
npm run orderbook        # Orderbook depth + imbalance
npm run volume           # Volume spike scanner
```

No `npm install` needed — all scripts use Node.js built-ins only.

## Stack

- **Runtime:** [OpenClaw](https://github.com/openclaw/openclaw) on Ubuntu VPS
- **Model:** Claude Opus 4.6 (market agent + content agent)
- **Data:** Hyperliquid public API, CryptoCompare, OKX/Bitget/Gate.io
- **Delivery:** Telegram via OpenClaw channel plugin

See [docs/setup.md](docs/setup.md) for detailed setup and pipeline walkthrough.

## License

MIT
