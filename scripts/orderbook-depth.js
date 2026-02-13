require("./env");
const https = require('https');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const OUTPUT_PATH = path.join(DATA_DIR, 'orderbook-depth-latest.json');

// --- Args ---
const { values: args } = parseArgs({
  options: {
    'coins': { type: 'string', default: '' },
    'top': { type: 'string', default: '50' },
    'depth': { type: 'string', default: '1' },  // % depth to analyze (1% = bids/asks within 1% of mid)
    'imbalance': { type: 'string', default: '1.5' }, // min bid/ask ratio to flag
    'json': { type: 'boolean', default: false },
  },
  strict: false,
});

const DEPTH_PCT = parseFloat(args.depth);
const MIN_IMBALANCE = parseFloat(args.imbalance);

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

function findWalls(levels, midPrice, side) {
  // Find large orders (walls) — orders 5x the median size
  if (levels.length < 5) return [];
  const sizes = levels.map(l => parseFloat(l.sz));
  const sorted = [...sizes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = median * 5;

  return levels
    .filter(l => parseFloat(l.sz) >= threshold)
    .map(l => ({
      price: parseFloat(l.px),
      size: parseFloat(l.sz),
      notional: parseFloat(l.px) * parseFloat(l.sz),
      distFromMid: ((parseFloat(l.px) - midPrice) / midPrice * 100),
      orders: l.n,
    }))
    .slice(0, 5); // top 5 walls
}

async function main() {
  // Get coins
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
    const ctxs = await post({ type: 'metaAndAssetCtxs' });
    const assetCtxs = ctxs[1] || ctxs.assetCtxs || [];
    const withVolume = meta.universe.map((u, i) => ({
      coin: u.name,
      volume: assetCtxs[i] ? parseFloat(assetCtxs[i].dayNtlVlm || '0') : 0,
    }));
    withVolume.sort((a, b) => b.volume - a.volume);
    coins = withVolume.slice(0, parseInt(args.top)).map(c => c.coin);
  }

  console.error(`Scanning orderbooks for ${coins.length} coins (${DEPTH_PCT}% depth, ${MIN_IMBALANCE}x imbalance threshold)...`);

  const results = [];
  const batchSize = 5;

  for (let i = 0; i < coins.length; i += batchSize) {
    const batch = coins.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (coin) => {
      try {
        const book = await post({ type: 'l2Book', coin, nSigFigs: 5 });
        const bids = book.levels[0] || [];
        const asks = book.levels[1] || [];
        const mid = midPrices[coin];
        if (!mid) return null;

        const depthRange = mid * (DEPTH_PCT / 100);

        // Sum liquidity within depth range
        const bidDepth = bids
          .filter(l => mid - parseFloat(l.px) <= depthRange)
          .reduce((sum, l) => sum + parseFloat(l.sz) * parseFloat(l.px), 0);
        const askDepth = asks
          .filter(l => parseFloat(l.px) - mid <= depthRange)
          .reduce((sum, l) => sum + parseFloat(l.sz) * parseFloat(l.px), 0);

        const totalDepth = bidDepth + askDepth;
        const imbalance = askDepth > 0 ? bidDepth / askDepth : bidDepth > 0 ? 999 : 1;

        // Spread
        const bestBid = bids.length > 0 ? parseFloat(bids[0].px) : 0;
        const bestAsk = asks.length > 0 ? parseFloat(asks[0].px) : 0;
        const spread = bestAsk > 0 && bestBid > 0 ? (bestAsk - bestBid) / mid * 100 : null;

        // Find walls
        const bidWalls = findWalls(bids.slice(0, 50), mid, 'bid');
        const askWalls = findWalls(asks.slice(0, 50), mid, 'ask');

        // Pressure assessment
        let pressure = 'neutral';
        if (imbalance >= MIN_IMBALANCE) pressure = 'buy_pressure';
        else if (imbalance <= 1 / MIN_IMBALANCE) pressure = 'sell_pressure';

        return {
          coin,
          mid: Math.round(mid * 10000) / 10000,
          spread: spread ? Math.round(spread * 10000) / 10000 : null,
          bidDepth: Math.round(bidDepth),
          askDepth: Math.round(askDepth),
          totalDepth: Math.round(totalDepth),
          imbalance: Math.round(imbalance * 100) / 100,
          pressure,
          bidWalls: bidWalls.length > 0 ? bidWalls : null,
          askWalls: askWalls.length > 0 ? askWalls : null,
        };
      } catch (e) {
        return { coin, error: e.message };
      }
    }));

    results.push(...batchResults.filter(Boolean));
    if (i + batchSize < coins.length) await new Promise(r => setTimeout(r, 200));
  }

  // Sort by imbalance strength
  results.sort((a, b) => {
    if (a.error) return 1;
    if (b.error) return -1;
    return Math.abs(b.imbalance - 1) - Math.abs(a.imbalance - 1);
  });

  // Save
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ ts: new Date().toISOString(), depthPct: DEPTH_PCT, count: results.length, results }, null, 2));

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Human output
  const imbalanced = results.filter(r => r.pressure !== 'neutral' && !r.error);
  const walled = results.filter(r => (r.bidWalls || r.askWalls) && !r.error);

  console.log(`\n📊 ORDERBOOK DEPTH ANALYSIS — ${results.length} coins (${DEPTH_PCT}% from mid)\n`);

  if (imbalanced.length > 0) {
    console.log(`⚖️ IMBALANCED BOOKS (${imbalanced.length}):`);
    for (const r of imbalanced) {
      const dir = r.pressure === 'buy_pressure' ? '🟢 BUY' : '🔴 SELL';
      console.log(`  ${dir} ${r.coin.padEnd(8)} | Bid: $${(r.bidDepth/1000).toFixed(0)}K | Ask: $${(r.askDepth/1000).toFixed(0)}K | Ratio: ${r.imbalance}x | Spread: ${r.spread}%`);
    }
    console.log();
  }

  if (walled.length > 0) {
    console.log(`🧱 WALLS DETECTED (${walled.length}):`);
    for (const r of walled) {
      const walls = [];
      if (r.bidWalls) r.bidWalls.forEach(w => walls.push(`BID $${(w.notional/1000).toFixed(0)}K @ ${w.price} (${w.distFromMid.toFixed(2)}%)`));
      if (r.askWalls) r.askWalls.forEach(w => walls.push(`ASK $${(w.notional/1000).toFixed(0)}K @ ${w.price} (${w.distFromMid.toFixed(2)}%)`));
      console.log(`  ${r.coin}: ${walls.join(' | ')}`);
    }
    console.log();
  }

  // Top 10 most liquid
  const byLiquidity = [...results].filter(r => !r.error).sort((a, b) => b.totalDepth - a.totalDepth);
  console.log(`💧 TOP 10 MOST LIQUID:`);
  for (const r of byLiquidity.slice(0, 10)) {
    const dir = r.pressure === 'buy_pressure' ? '🟢' : r.pressure === 'sell_pressure' ? '🔴' : '⚪';
    console.log(`  ${dir} ${r.coin.padEnd(8)} | Total: $${(r.totalDepth/1000).toFixed(0)}K | Imbalance: ${r.imbalance}x | Spread: ${r.spread}%`);
  }

  // Thinnest books (easiest to move)
  const byThin = [...results].filter(r => !r.error && r.totalDepth > 0).sort((a, b) => a.totalDepth - b.totalDepth);
  console.log(`\n🎯 THINNEST BOOKS (easiest to move):`);
  for (const r of byThin.slice(0, 10)) {
    console.log(`  ${r.coin.padEnd(8)} | Total: $${(r.totalDepth/1000).toFixed(0)}K | Spread: ${r.spread}%`);
  }

  console.error(`\nSaved to ${OUTPUT_PATH}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
