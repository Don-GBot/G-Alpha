require("./env");
const https = require('https');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const OUTPUT_PATH = path.join(DATA_DIR, 'multi-tf-latest.json');

// --- Config ---
const TIMEFRAMES = ['1h', '4h', '1d'];
const EMA_PERIODS = [20, 50, 200];
const RSI_PERIOD = 14;
const CANDLE_COUNTS = { '1h': 210, '4h': 210, '1d': 210 };

// --- Args ---
const { values: args } = parseArgs({
  options: {
    'coins': { type: 'string', default: '' },
    'top': { type: 'string', default: '50' },
    'aligned': { type: 'boolean', default: false },  // only show trend-aligned coins
    'json': { type: 'boolean', default: false },
  },
  strict: false,
});

// --- HTTP ---
function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.hyperliquid.xyz', path: '/info', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// --- Math ---
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function trendDirection(ema20, ema50, ema200) {
  if (!ema20 || !ema50 || !ema200) return 'unknown';
  if (ema20 > ema50 && ema50 > ema200) return 'bullish';
  if (ema20 < ema50 && ema50 < ema200) return 'bearish';
  return 'mixed';
}

function emaDistance(price, ema200) {
  if (!ema200 || !price) return null;
  return ((price - ema200) / ema200 * 100);
}

// --- Main ---
async function main() {
  // Get top coins by volume
  const [meta, allMids] = await Promise.all([
    post({ type: 'meta' }),
    post({ type: 'allMids' }),
  ]);

  const midPrices = {};
  Object.entries(allMids).forEach(([coin, px]) => { midPrices[coin] = parseFloat(px); });

  let coins;
  if (args.coins) {
    coins = args.coins.split(',').map(c => c.trim().toUpperCase());
  } else {
    // Get volume to sort by
    const ctxs = await post({ type: 'metaAndAssetCtxs' });
    const assetCtxs = ctxs[1] || ctxs.assetCtxs || [];
    const withVolume = meta.universe.map((u, i) => ({
      coin: u.name,
      volume: assetCtxs[i] ? parseFloat(assetCtxs[i].dayNtlVlm || '0') : 0,
    }));
    withVolume.sort((a, b) => b.volume - a.volume);
    coins = withVolume.slice(0, parseInt(args.top)).map(c => c.coin);
  }

  console.error(`Analyzing ${coins.length} coins across ${TIMEFRAMES.join(', ')} timeframes...`);

  const results = [];
  const batchSize = 5;

  for (let i = 0; i < coins.length; i += batchSize) {
    const batch = coins.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (coin) => {
      const tfData = {};
      let allAligned = null;

      for (const tf of TIMEFRAMES) {
        const msPerCandle = tf === '1h' ? 3600000 : tf === '4h' ? 14400000 : 86400000;
        const startTime = Date.now() - msPerCandle * CANDLE_COUNTS[tf];

        try {
          const candles = await post({
            type: 'candleSnapshot',
            req: { coin, interval: tf, startTime, endTime: Date.now() }
          });

          if (!candles || candles.length < 50) {
            tfData[tf] = { error: 'insufficient data' };
            continue;
          }

          const closes = candles.map(c => parseFloat(c.c));
          const volumes = candles.map(c => parseFloat(c.v));
          const price = closes[closes.length - 1];

          const ema20 = calcEMA(closes, 20);
          const ema50 = calcEMA(closes, 50);
          const ema200 = calcEMA(closes, 200);
          const rsi = calcRSI(closes, RSI_PERIOD);
          const trend = trendDirection(ema20, ema50, ema200);
          const distFrom200 = emaDistance(price, ema200);

          // Volume analysis: current vs 20-period average
          const recentVol = volumes.slice(-1)[0];
          const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
          const volRatio = avgVol > 0 ? recentVol / avgVol : 0;

          tfData[tf] = {
            price: Math.round(price * 10000) / 10000,
            ema20: ema20 ? Math.round(ema20 * 10000) / 10000 : null,
            ema50: ema50 ? Math.round(ema50 * 10000) / 10000 : null,
            ema200: ema200 ? Math.round(ema200 * 10000) / 10000 : null,
            rsi: rsi ? Math.round(rsi * 10) / 10 : null,
            trend,
            distFrom200: distFrom200 ? Math.round(distFrom200 * 100) / 100 : null,
            volRatio: Math.round(volRatio * 100) / 100,
            candles: candles.length,
          };
        } catch (e) {
          tfData[tf] = { error: e.message };
        }
      }

      // Check alignment across timeframes
      const trends = TIMEFRAMES.map(tf => tfData[tf]?.trend).filter(t => t && t !== 'unknown');
      const allBullish = trends.length >= 2 && trends.every(t => t === 'bullish');
      const allBearish = trends.length >= 2 && trends.every(t => t === 'bearish');
      const alignment = allBullish ? 'BULLISH_ALIGNED' : allBearish ? 'BEARISH_ALIGNED' : 'MIXED';

      // RSI divergence: short TF overbought/oversold while longer TF diverges
      const rsi1h = tfData['1h']?.rsi;
      const rsi4h = tfData['4h']?.rsi;
      const rsi1d = tfData['1d']?.rsi;
      let rsiDivergence = null;
      if (rsi1h && rsi1d) {
        if (rsi1h <= 30 && rsi1d >= 50) rsiDivergence = 'SHORT_TF_OVERSOLD';
        if (rsi1h >= 70 && rsi1d <= 50) rsiDivergence = 'SHORT_TF_OVERBOUGHT';
      }

      // Volume spike detection across any timeframe
      const volSpikes = TIMEFRAMES.filter(tf => tfData[tf]?.volRatio >= 2.0);

      return {
        coin,
        price: midPrices[coin] || tfData['1h']?.price,
        alignment,
        rsiDivergence,
        volSpikes: volSpikes.length > 0 ? volSpikes : null,
        timeframes: tfData,
      };
    }));

    results.push(...batchResults);
    if (i + batchSize < coins.length) await new Promise(r => setTimeout(r, 200));
  }

  // Filter if --aligned
  let output = results;
  if (args.aligned) {
    output = results.filter(r => r.alignment !== 'MIXED');
  }

  // Sort: aligned first, then by volume spikes
  output.sort((a, b) => {
    if (a.alignment !== 'MIXED' && b.alignment === 'MIXED') return -1;
    if (a.alignment === 'MIXED' && b.alignment !== 'MIXED') return 1;
    if (a.rsiDivergence && !b.rsiDivergence) return -1;
    return 0;
  });

  // Save JSON
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ ts: new Date().toISOString(), count: output.length, results: output }, null, 2));

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Human output
  console.log(`\n⏱️ MULTI-TIMEFRAME ANALYSIS — ${output.length} coins\n`);

  const aligned = output.filter(r => r.alignment !== 'MIXED');
  const divergent = output.filter(r => r.rsiDivergence);
  const spiking = output.filter(r => r.volSpikes);

  if (aligned.length > 0) {
    console.log(`🎯 TREND-ALIGNED (${aligned.length}):`);
    for (const r of aligned) {
      const dir = r.alignment === 'BULLISH_ALIGNED' ? '🟢' : '🔴';
      const d200 = r.timeframes['1d']?.distFrom200;
      const rsi = r.timeframes['4h']?.rsi || r.timeframes['1h']?.rsi;
      console.log(`  ${dir} ${r.coin} — ${r.alignment.replace('_', ' ')} | RSI(4h): ${rsi || '?'} | Dist 200d: ${d200 ? d200 + '%' : '?'}`);
    }
    console.log();
  }

  if (divergent.length > 0) {
    console.log(`⚡ RSI DIVERGENCE (${divergent.length}):`);
    for (const r of divergent) {
      const rsi1h = r.timeframes['1h']?.rsi;
      const rsi1d = r.timeframes['1d']?.rsi;
      console.log(`  ${r.coin} — ${r.rsiDivergence} | RSI 1h: ${rsi1h} | RSI 1d: ${rsi1d}`);
    }
    console.log();
  }

  if (spiking.length > 0) {
    console.log(`📊 VOLUME SPIKES (${spiking.length}):`);
    for (const r of spiking) {
      const spikes = r.volSpikes.map(tf => `${tf}: ${r.timeframes[tf].volRatio}x`).join(', ');
      console.log(`  ${r.coin} — ${spikes}`);
    }
    console.log();
  }

  // Summary of all coins
  console.log(`📋 FULL BREAKDOWN:`);
  for (const r of output) {
    const flags = [];
    if (r.alignment !== 'MIXED') flags.push(r.alignment === 'BULLISH_ALIGNED' ? '🟢aligned' : '🔴aligned');
    if (r.rsiDivergence) flags.push('⚡rsi-div');
    if (r.volSpikes) flags.push('📊vol-spike');
    const tf4h = r.timeframes['4h'];
    const tf1d = r.timeframes['1d'];
    console.log(`  ${r.coin.padEnd(8)} | 1h:${r.timeframes['1h']?.trend?.slice(0,4) || '?'} 4h:${tf4h?.trend?.slice(0,4) || '?'} 1d:${tf1d?.trend?.slice(0,4) || '?'} | RSI 4h:${tf4h?.rsi || '?'} 1d:${tf1d?.rsi || '?'} ${flags.length ? '| ' + flags.join(' ') : ''}`);
  }

  console.error(`\nSaved to ${OUTPUT_PATH}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
