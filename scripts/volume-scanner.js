require("./env");
const https = require('https');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const OUTPUT_PATH = path.join(DATA_DIR, 'volume-scanner-latest.json');

const { values: args } = parseArgs({
  options: {
    'top': { type: 'string', default: '100' },
    'threshold': { type: 'string', default: '2' },  // volume spike threshold (2x = 2x average)
    'json': { type: 'boolean', default: false },
  },
  strict: false,
});

const SPIKE_THRESHOLD = parseFloat(args.threshold);

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

async function main() {
  const [meta, ctxs] = await Promise.all([
    post({ type: 'meta' }),
    post({ type: 'metaAndAssetCtxs' }),
  ]);

  const assetCtxs = ctxs[1] || [];
  const allCoins = meta.universe.map((u, i) => ({
    coin: u.name,
    dayVol: assetCtxs[i] ? parseFloat(assetCtxs[i].dayNtlVlm || '0') : 0,
    openInterest: assetCtxs[i] ? parseFloat(assetCtxs[i].openInterest || '0') : 0,
    funding: assetCtxs[i] ? parseFloat(assetCtxs[i].funding || '0') : 0,
    markPx: assetCtxs[i] ? parseFloat(assetCtxs[i].markPx || '0') : 0,
    prevDayPx: assetCtxs[i] ? parseFloat(assetCtxs[i].prevDayPx || '0') : 0,
  }));

  allCoins.sort((a, b) => b.dayVol - a.dayVol);
  const coins = allCoins.slice(0, parseInt(args.top));

  console.error(`Scanning volume for ${coins.length} coins (${SPIKE_THRESHOLD}x threshold)...`);

  const results = [];
  const batchSize = 10;

  for (let i = 0; i < coins.length; i += batchSize) {
    const batch = coins.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (c) => {
      try {
        // Get hourly candles for volume history (7 days)
        const candles = await post({
          type: 'candleSnapshot',
          req: { coin: c.coin, interval: '1h', startTime: Date.now() - 7 * 86400000, endTime: Date.now() }
        });

        if (!candles || candles.length < 24) return null;

        const hourlyVols = candles.map(x => parseFloat(x.v) * parseFloat(x.c)); // notional volume
        const currentHourVol = hourlyVols[hourlyVols.length - 1];
        const last24h = hourlyVols.slice(-25, -1);
        const last7d = hourlyVols.slice(0, -1);

        const avg24h = last24h.reduce((a, b) => a + b, 0) / last24h.length;
        const avg7d = last7d.reduce((a, b) => a + b, 0) / last7d.length;

        const spike24h = avg24h > 0 ? currentHourVol / avg24h : 0;
        const spike7d = avg7d > 0 ? currentHourVol / avg7d : 0;

        // Price change
        const priceChange = c.prevDayPx > 0 ? ((c.markPx - c.prevDayPx) / c.prevDayPx * 100) : 0;

        // OI relative to volume (high OI + low volume = potential squeeze)
        const oiMark = c.openInterest * c.markPx;
        const oiToVol = c.dayVol > 0 ? oiMark / c.dayVol : 0;

        return {
          coin: c.coin,
          price: Math.round(c.markPx * 10000) / 10000,
          priceChange24h: Math.round(priceChange * 100) / 100,
          dayVol: Math.round(c.dayVol),
          currentHourVol: Math.round(currentHourVol),
          avg24hHourVol: Math.round(avg24h),
          spike24h: Math.round(spike24h * 100) / 100,
          spike7d: Math.round(spike7d * 100) / 100,
          openInterest: Math.round(oiMark),
          oiToVolRatio: Math.round(oiToVol * 100) / 100,
          funding: Math.round(c.funding * 10000) / 10000,
          isSpike: spike24h >= SPIKE_THRESHOLD || spike7d >= SPIKE_THRESHOLD,
          isDryUp: spike24h <= 0.3 && c.dayVol > 100000, // volume dry-up on liquid coins
        };
      } catch (e) {
        return null;
      }
    }));

    results.push(...batchResults.filter(Boolean));
    if (i + batchSize < coins.length) await new Promise(r => setTimeout(r, 300));
  }

  // Sort by spike magnitude
  results.sort((a, b) => Math.max(b.spike24h, b.spike7d) - Math.max(a.spike24h, a.spike7d));

  // Save
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ ts: new Date().toISOString(), count: results.length, results }, null, 2));

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Human output
  const spikes = results.filter(r => r.isSpike);
  const dryups = results.filter(r => r.isDryUp);
  const highOI = results.filter(r => r.oiToVolRatio >= 3).sort((a, b) => b.oiToVolRatio - a.oiToVolRatio);

  console.log(`\n📊 VOLUME SCANNER — ${results.length} coins\n`);

  if (spikes.length > 0) {
    console.log(`🔥 VOLUME SPIKES (${spikes.length}):`);
    for (const r of spikes) {
      const dir = r.priceChange24h >= 0 ? '🟢' : '🔴';
      console.log(`  ${dir} ${r.coin.padEnd(8)} | ${r.spike24h}x vs 24h avg, ${r.spike7d}x vs 7d | Price: ${r.priceChange24h > 0 ? '+' : ''}${r.priceChange24h}% | Vol: $${(r.dayVol/1e6).toFixed(1)}M`);
    }
    console.log();
  }

  if (dryups.length > 0) {
    console.log(`🏜️ VOLUME DRY-UPS (${dryups.length}):`);
    for (const r of dryups) {
      console.log(`  ${r.coin.padEnd(8)} | ${r.spike24h}x vs avg | Vol: $${(r.dayVol/1e6).toFixed(1)}M | OI: $${(r.openInterest/1e6).toFixed(1)}M`);
    }
    console.log();
  }

  if (highOI.length > 0) {
    console.log(`⚠️ HIGH OI/VOLUME RATIO (potential squeeze, ${highOI.length}):`);
    for (const r of highOI.slice(0, 15)) {
      const fDir = r.funding > 0 ? '📈' : '📉';
      console.log(`  ${r.coin.padEnd(8)} | OI/Vol: ${r.oiToVolRatio}x | OI: $${(r.openInterest/1e6).toFixed(1)}M | Funding: ${fDir} ${(r.funding * 100).toFixed(4)}%`);
    }
    console.log();
  }

  console.error(`\nSaved to ${OUTPUT_PATH}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
