require("./env");
#!/usr/bin/env node
/**
 * EMA Breakout Scanner — finds coins crossing EMA 200 on 1h/4h timeframes
 * Uses Hyperliquid candle data (free, no rate limits)
 * 
 * Scans ALL HL perps with OI > threshold for:
 *   - Price crossing above EMA 200 on 1h (freshest signal)
 *   - Price crossing above EMA 200 on 4h (stronger confirmation)
 *   - Price crossing below EMA 200 (breakdown)
 *   - Price reclaiming EMA 50 while below 200 (early reversal)
 * 
 * Designed to catch breakouts like TAKE before they rip.
 * 
 * Usage:
 *   node ema-breakout-scanner.js                — scan all HL coins >$500K OI
 *   node ema-breakout-scanner.js --oi 2000000   — custom OI threshold ($2M)
 */

const fs = require('fs');
const https = require('https');

const OUTPUT_PATH = '' + path.resolve(__dirname, '..', 'data') + '/ema-breakouts-latest.json';
const STATE_PATH = '' + path.resolve(__dirname, '..', 'data') + '/ema-breakout-state.json';
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h cooldown per coin per signal

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
        catch (e) { reject(new Error(`Parse: ${body.substring(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

function calculateEMA(prices, period) {
  if (prices.length < period + 5) return { current: null, prev: null }; // need a few extra for prev
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let prevEma = ema;
  for (let i = period; i < prices.length; i++) {
    prevEma = ema;
    ema = prices[i] * k + ema * (1 - k);
  }
  return { current: ema, prev: prevEma };
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

async function getCandles(coin, interval, count) {
  // Calculate time range based on interval and count
  const intervalMs = {
    '1h': 3600000,
    '4h': 14400000,
    '1d': 86400000,
  }[interval] || 3600000;
  
  const now = Date.now();
  const start = now - (count * intervalMs);
  
  try {
    const candles = await post('https://api.hyperliquid.xyz/info', {
      type: 'candleSnapshot',
      req: { coin, interval, startTime: start, endTime: now }
    });
    if (!Array.isArray(candles) || candles.length < 50) return null;
    return candles;
  } catch (e) {
    return null;
  }
}

async function getCoinsWithOI(minOI) {
  const data = await post('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' });
  if (!data || !Array.isArray(data) || data.length < 2) {
    console.log('Warning: Hyperliquid API returned unexpected format');
    return [];
  }
  const universe = data[0].universe;
  const ctxs = data[1];
  
  return universe.map((u, i) => {
    const mark = parseFloat(ctxs[i].markPx);
    const oi = parseFloat(ctxs[i].openInterest) * mark;
    const funding = parseFloat(ctxs[i].funding);
    const vol = parseFloat(ctxs[i].dayNtlVlm);
    return { coin: u.name, markPx: mark, oiUsd: oi, funding, volume24h: vol };
  }).filter(c => c.oiUsd >= minOI);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { lastAlerted: {} }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function scanCoin(coin, meta) {
  const signals = [];
  
  // Check both 1h and 4h timeframes
  for (const tf of ['1h', '4h']) {
    const candles = await getCandles(coin, tf, 250);
    if (!candles) continue;
    
    const closes = candles.map(c => parseFloat(c.c));
    const currentPrice = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    
    const ema200 = calculateEMA(closes, 200);
    const ema50 = calculateEMA(closes, 50);
    const ema20 = calculateEMA(closes, 20);
    
    if (!ema200.current) continue;
    
    const rsi = calculateRSI(closes);
    const distFrom200 = ((currentPrice - ema200.current) / ema200.current * 100);
    
    // SIGNAL 1: Price crosses ABOVE EMA 200 (bullish breakout)
    if (prevClose < ema200.prev && currentPrice > ema200.current) {
      signals.push({
        type: 'CROSS_ABOVE_200',
        timeframe: tf,
        desc: `Crossed ABOVE ${tf} EMA 200 — bullish breakout`,
        price: currentPrice,
        ema200: ema200.current,
        rsi,
        weight: tf === '4h' ? 5 : 4,
      });
    }
    
    // SIGNAL 2: Price crosses BELOW EMA 200 (bearish breakdown)
    if (prevClose > ema200.prev && currentPrice < ema200.current) {
      signals.push({
        type: 'CROSS_BELOW_200',
        timeframe: tf,
        desc: `Crossed BELOW ${tf} EMA 200 — bearish breakdown`,
        price: currentPrice,
        ema200: ema200.current,
        rsi,
        weight: tf === '4h' ? 5 : 4,
      });
    }
    
    // SIGNAL 3: Price reclaims EMA 50 while below 200 (early reversal sign)
    if (ema50.current && prevClose < ema50.prev && currentPrice > ema50.current && currentPrice < ema200.current) {
      signals.push({
        type: 'RECLAIM_50_BELOW_200',
        timeframe: tf,
        desc: `Reclaimed ${tf} EMA 50 (still below 200) — early reversal building`,
        price: currentPrice,
        ema50: ema50.current,
        ema200: ema200.current,
        distFrom200: Math.round(distFrom200 * 100) / 100,
        rsi,
        weight: tf === '4h' ? 3 : 2,
      });
    }
    
    // SIGNAL 4: Price testing EMA 200 from below (within 1%)
    if (currentPrice < ema200.current && Math.abs(distFrom200) < 1.0 && prevClose < currentPrice) {
      signals.push({
        type: 'TESTING_200_FROM_BELOW',
        timeframe: tf,
        desc: `Testing ${tf} EMA 200 from below (${distFrom200.toFixed(2)}%) — breakout imminent?`,
        price: currentPrice,
        ema200: ema200.current,
        rsi,
        weight: tf === '4h' ? 4 : 3,
      });
    }
    
    // SIGNAL 5: Bullish EMA stack just formed on this timeframe (20>50>200)
    if (ema20.current && ema50.current) {
      const stackNow = ema20.current > ema50.current && ema50.current > ema200.current;
      const stackPrev = ema20.prev > ema50.prev && ema50.prev > ema200.prev;
      if (stackNow && !stackPrev) {
        signals.push({
          type: 'BULLISH_STACK_FORMED',
          timeframe: tf,
          desc: `Bullish EMA stack just formed on ${tf} (20>50>200)`,
          weight: tf === '4h' ? 4 : 3,
        });
      }
    }
    
    // Small delay between timeframe checks
    await new Promise(r => setTimeout(r, 100));
  }
  
  if (signals.length === 0) return null;
  
  return {
    coin,
    price: meta.markPx,
    oiUsd: meta.oiUsd,
    funding: meta.funding,
    volume24h: meta.volume24h,
    signals,
    maxWeight: Math.max(...signals.map(s => s.weight)),
  };
}

async function main() {
  const args = process.argv.slice(2);
  let minOI = 500000; // $500K default
  
  const oiIdx = args.indexOf('--oi');
  if (oiIdx !== -1 && args[oiIdx + 1]) minOI = parseInt(args[oiIdx + 1]);
  
  console.log(`🔍 EMA Breakout Scanner — Hyperliquid (OI > $${(minOI/1e6).toFixed(1)}M)\n`);
  
  let coins = await getCoinsWithOI(minOI);
  // Cap at top 30 by OI to avoid timeouts
  coins.sort((a, b) => b.oiUsd - a.oiUsd);
  if (coins.length > 30) {
    console.log(`  Capping from ${coins.length} to top 30 by OI`);
    coins = coins.slice(0, 30);
  }
  console.log(`📊 Scanning ${coins.length} coins...\n`);
  
  const state = loadState();
  const now = Date.now();
  const results = [];
  
  // Process in batches of 5 with concurrency
  for (let i = 0; i < coins.length; i += 5) {
    const batch = coins.slice(i, i + 5);
    const batchResults = await Promise.allSettled(
      batch.map(meta => scanCoin(meta.coin, meta).catch(() => null))
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
        for (const s of r.value.signals) {
          console.log(`  ⚡ ${r.value.coin}: ${s.desc} | OI $${(r.value.oiUsd/1e6).toFixed(1)}M${s.rsi ? ` | RSI ${s.rsi}` : ''}`);
        }
      }
    }
    // Brief pause between batches
    if (i + 5 < coins.length) await new Promise(r => setTimeout(r, 200));
  }
  
  // Filter by cooldown
  const newAlerts = [];
  for (const r of results) {
    const freshSignals = r.signals.filter(s => {
      const key = `${r.coin}_${s.type}_${s.timeframe}`;
      const last = state.lastAlerted[key] || 0;
      if (now - last > COOLDOWN_MS) {
        state.lastAlerted[key] = now;
        return true;
      }
      return false;
    });
    if (freshSignals.length > 0) {
      newAlerts.push({ ...r, signals: freshSignals });
    }
  }
  
  const output = {
    timestamp: new Date().toISOString(),
    source: 'hyperliquid',
    minOI,
    scanned: coins.length,
    totalWithSignals: results.length,
    newAlerts: newAlerts.length,
    alerts: newAlerts,
    allSignals: results,
  };
  
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  saveState(state);
  
  console.log(`\n✅ ${coins.length} scanned | ${results.length} with signals | ${newAlerts.length} new alerts`);
  
  if (newAlerts.length > 0) {
    console.log('\n🔥 NEW Breakout Alerts:');
    for (const a of newAlerts) {
      console.log(`\n  ${a.coin} ($${a.price}) | OI $${(a.oiUsd/1e6).toFixed(1)}M | funding ${(a.funding*100).toFixed(4)}%`);
      for (const s of a.signals) {
        console.log(`    → ${s.desc}`);
      }
    }
  }
  
  console.log(`\nSaved: ${OUTPUT_PATH}`);
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
