#!/usr/bin/env node
/**
 * EMA Checker — calculates EMA 20/50/200 using Hyperliquid candle data
 * No API key needed, no rate limits
 * 
 * Signals:
 *   - BULLISH_STACK / BEARISH_STACK: EMA 20/50/200 perfectly aligned
 *   - CROSS_ABOVE_200 / CROSS_BELOW_200: Price just crossed the 200 EMA
 *   - GOLDEN_CROSS_ZONE / DEATH_CROSS_ZONE: EMA 50 near EMA 200
 *   - NEAR_EMA200: Price within 2% of 200 EMA (battle zone)
 *   - PULLBACK_EMA20/50: Pullback to support in trend
 * 
 * Usage:
 *   node ema-checker.js BTC ETH SOL           — check specific coins
 *   node ema-checker.js --funding              — check coins with extreme funding
 *   node ema-checker.js --majors               — check major coins
 *   node ema-checker.js --all                  — all HL coins with >$1M OI
 */

const fs = require('fs');
const https = require('https');

const FUNDING_PATH = '/home/ubuntu/clawd/data/funding-unified-latest.json';
const OUTPUT_PATH = '/home/ubuntu/clawd/data/ema-latest.json';

const MAJORS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'SUI', 'LINK', 'AVAX', 'PEPE', 'WIF', 'ARB', 'OP', 'APT', 'ONDO', 'AAVE', 'HBAR', 'NEAR', 'RENDER', 'INJ', 'SEI'];

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname, path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Parse error: ${body.substring(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function detectSignals(closes, ema20, ema50, ema200, currentPrice) {
  const signals = [];
  if (!ema20 || !ema50 || !ema200) return signals;
  
  const priceDistFromEMA200 = ((currentPrice - ema200) / ema200 * 100);
  const bullishStack = ema20 > ema50 && ema50 > ema200;
  const bearishStack = ema20 < ema50 && ema50 < ema200;
  
  if (bullishStack) signals.push({ type: 'BULLISH_STACK', desc: 'EMA 20>50>200 — strong uptrend', weight: 2 });
  if (bearishStack) signals.push({ type: 'BEARISH_STACK', desc: 'EMA 20<50<200 — strong downtrend', weight: 2 });
  
  // Price near EMA 200 (within 2%)
  if (Math.abs(priceDistFromEMA200) < 2) {
    signals.push({ type: 'NEAR_EMA200', desc: `Price ${priceDistFromEMA200.toFixed(2)}% from EMA 200 — trend battle zone`, weight: 3 });
  }
  
  // Price just crossed EMA 200
  if (closes.length >= 2) {
    const prev = closes[closes.length - 2];
    if (prev < ema200 && currentPrice > ema200)
      signals.push({ type: 'CROSS_ABOVE_200', desc: 'Price crossed ABOVE EMA 200 — bullish flip', weight: 5 });
    if (prev > ema200 && currentPrice < ema200)
      signals.push({ type: 'CROSS_BELOW_200', desc: 'Price crossed BELOW EMA 200 — bearish flip', weight: 5 });
  }
  
  // Golden/Death cross zone (EMA 50 within 1% of EMA 200)
  const ema50_200_dist = ((ema50 - ema200) / ema200 * 100);
  if (Math.abs(ema50_200_dist) < 1) {
    if (ema50 > ema200) signals.push({ type: 'GOLDEN_CROSS_ZONE', desc: `EMA 50 just above EMA 200 (${ema50_200_dist.toFixed(2)}%) — fresh golden cross`, weight: 4 });
    else signals.push({ type: 'DEATH_CROSS_ZONE', desc: `EMA 50 just below EMA 200 (${ema50_200_dist.toFixed(2)}%) — fresh death cross`, weight: 4 });
  }
  
  // Pullback to EMA 20 in uptrend
  const distFromEMA20 = ((currentPrice - ema20) / ema20 * 100);
  if (currentPrice > ema200 && ema20 > ema50 && Math.abs(distFromEMA20) < 1.5)
    signals.push({ type: 'PULLBACK_EMA20', desc: `Pullback to EMA 20 in uptrend (${distFromEMA20.toFixed(1)}%)`, weight: 2 });
  
  // Pullback to EMA 50 in uptrend
  const distFromEMA50 = ((currentPrice - ema50) / ema50 * 100);
  if (currentPrice > ema200 && Math.abs(distFromEMA50) < 1.5 && currentPrice < ema20)
    signals.push({ type: 'PULLBACK_EMA50', desc: `Deeper pullback to EMA 50 (${distFromEMA50.toFixed(1)}%)`, weight: 3 });
  
  return signals;
}

async function getHLCandles(coin, days = 250) {
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  
  try {
    const candles = await post('https://api.hyperliquid.xyz/info', {
      type: 'candleSnapshot',
      req: { coin, interval: '1d', startTime: start, endTime: now }
    });
    if (!Array.isArray(candles) || candles.length < 50) return null;
    return candles.map(c => parseFloat(c.c)); // close prices
  } catch (e) {
    return null;
  }
}

async function getHLCoins() {
  const data = await post('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' });
  const universe = data[0].universe;
  const ctxs = data[1];
  return universe.map((u, i) => ({
    coin: u.name,
    oiUsd: parseFloat(ctxs[i].openInterest) * parseFloat(ctxs[i].markPx),
  }));
}

async function checkCoin(ticker) {
  const closes = await getHLCandles(ticker);
  if (!closes || closes.length < 201) {
    // Try with fewer candles — still useful for 20/50
    if (closes && closes.length >= 50) {
      const currentPrice = closes[closes.length - 1];
      const ema20 = calculateEMA(closes, 20);
      const ema50 = calculateEMA(closes, 50);
      return {
        ticker, price: currentPrice,
        ema20: ema20 ? Math.round(ema20 * 10000) / 10000 : null,
        ema50: ema50 ? Math.round(ema50 * 10000) / 10000 : null,
        ema200: null,
        note: `Only ${closes.length} candles available, no EMA 200`,
        signals: [], signalWeight: 0,
      };
    }
    return { ticker, error: `Insufficient data (${closes ? closes.length : 0} candles)`, signals: [] };
  }
  
  const currentPrice = closes[closes.length - 1];
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  
  const signals = detectSignals(closes, ema20, ema50, ema200, currentPrice);
  
  return {
    ticker,
    price: Math.round(currentPrice * 10000) / 10000,
    ema20: Math.round(ema20 * 10000) / 10000,
    ema50: Math.round(ema50 * 10000) / 10000,
    ema200: Math.round(ema200 * 10000) / 10000,
    priceVsEMA200: Math.round((currentPrice - ema200) / ema200 * 10000) / 100,
    trend: currentPrice > ema200 ? 'ABOVE_200' : 'BELOW_200',
    alignment: ema20 > ema50 && ema50 > ema200 ? 'BULLISH' :
               ema20 < ema50 && ema50 < ema200 ? 'BEARISH' : 'MIXED',
    signals,
    signalWeight: signals.reduce((sum, s) => sum + s.weight, 0),
  };
}

async function main() {
  const args = process.argv.slice(2);
  let tickers = [];
  
  if (args.includes('--funding')) {
    try {
      const funding = JSON.parse(fs.readFileSync(FUNDING_PATH, 'utf8'));
      tickers = funding.coins.filter(c => c.isExtreme || c.isNoteworthy).map(c => c.coin);
    } catch (e) { console.error('Could not load funding data:', e.message); }
  } else if (args.includes('--all')) {
    const coins = await getHLCoins();
    tickers = coins.filter(c => c.oiUsd > 1000000).map(c => c.coin);
  } else if (args.includes('--majors')) {
    tickers = MAJORS;
  } else if (args.length > 0) {
    tickers = args.filter(a => !a.startsWith('--'));
  } else {
    tickers = MAJORS;
  }
  
  tickers = [...new Set(tickers)];
  console.log(`📊 EMA Check: ${tickers.length} coins (daily, Hyperliquid data)\n`);
  
  const results = [];
  for (let i = 0; i < tickers.length; i++) {
    const result = await checkCoin(tickers[i]);
    results.push(result);
    
    if (result.error) {
      console.log(`  ✗ ${result.ticker}: ${result.error}`);
    } else if (result.note) {
      console.log(`  ⚠ ${result.ticker}: $${result.price} | ${result.note}`);
    } else {
      const sigStr = result.signals.length > 0 ? result.signals.map(s => s.type).join(', ') : '—';
      console.log(`  ${result.ticker}: $${result.price} | ${result.trend} ${result.alignment} | ${result.priceVsEMA200}% from 200 | ${sigStr}`);
    }
    
    // Small delay to be nice
    if (i < tickers.length - 1) await new Promise(r => setTimeout(r, 200));
  }
  
  const withSignals = results.filter(r => r.signals && r.signals.length > 0);
  const highWeight = withSignals.filter(r => r.signalWeight >= 3).sort((a, b) => b.signalWeight - a.signalWeight);
  
  const output = {
    timestamp: new Date().toISOString(),
    timeframe: 'daily',
    source: 'hyperliquid',
    totalChecked: results.length,
    withSignals: withSignals.length,
    highPriority: highWeight.length,
    coins: results,
    actionable: highWeight,
  };
  
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  
  console.log(`\n✅ ${results.length} checked | ${withSignals.length} with signals | ${highWeight.length} high priority`);
  
  if (highWeight.length > 0) {
    console.log('\n🔥 High Priority EMA Signals:');
    for (const r of highWeight) {
      console.log(`\n  ${r.ticker} ($${r.price}) — ${r.trend}, ${r.alignment}`);
      for (const s of r.signals) console.log(`    → ${s.desc}`);
    }
  }
  
  console.log(`\nSaved: ${OUTPUT_PATH}`);
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
