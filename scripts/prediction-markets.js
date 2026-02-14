require("./env");
#!/usr/bin/env node
/**
 * Unified Prediction Market Tracker — Polymarket + Kalshi
 * Pulls odds from both platforms for briefings and alerts
 * 
 * Usage:
 *   node prediction-markets.js                  # All markets
 *   node prediction-markets.js --crypto         # BTC/ETH price markets only
 *   node prediction-markets.js --macro          # Fed, CPI, GDP only
 *   node prediction-markets.js --politics       # Political markets only
 *   node prediction-markets.js --json           # JSON output
 *   node prediction-markets.js --alert          # Only show big moves / high conviction
 */

const https = require('https');

const args = new Set(process.argv.slice(2));
const wantCrypto = args.has('--crypto');
const wantMacro = args.has('--macro');
const wantPolitics = args.has('--politics');
const wantJson = args.has('--json');
const wantAlert = args.has('--alert');
const wantAll = !wantCrypto && !wantMacro && !wantPolitics;

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': 'prediction-tracker/1.0' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- Polymarket ---
async function fetchPolymarket() {
  const markets = [];
  try {
    // Polymarket gamma API — top active markets
    const data = await get('https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=50&order=volume24hr&ascending=false');
    if (!Array.isArray(data)) return markets;

    for (const m of data) {
      if (!m.outcomePrices) continue;
      let prices;
      try { prices = JSON.parse(m.outcomePrices); } catch { continue; }
      const outcomes = m.outcomes ? JSON.parse(m.outcomes) : ['Yes', 'No'];
      
      const yesPrice = Math.round(parseFloat(prices[0]) * 100);
      const noPrice = Math.round(parseFloat(prices[1]) * 100);
      const volume = parseFloat(m.volume24hr) || 0;
      const liquidity = parseFloat(m.liquidityNum) || 0;

      // Categorize
      let category = 'other';
      const q = (m.question || '').toLowerCase();
      if (/bitcoin|btc|ethereum|eth|crypto|solana|sol\b/i.test(q)) category = 'crypto';
      else if (/fed|cpi|gdp|inflation|rate|recession|tariff|jobs|employment|economic/i.test(q)) category = 'macro';
      else if (/trump|biden|president|election|congress|senate|governor|democrat|republican|political/i.test(q)) category = 'politics';

      markets.push({
        source: 'Polymarket',
        category,
        question: m.question,
        yes: yesPrice,
        no: noPrice,
        volume24h: Math.round(volume),
        liquidity: Math.round(liquidity),
        url: `https://polymarket.com/event/${m.conditionId}`,
      });
    }
  } catch (e) {
    if (!wantJson) console.error('Polymarket fetch error:', e.message);
  }
  return markets;
}

// --- Kalshi ---
async function fetchKalshi() {
  const markets = [];
  const seriesList = [
    { ticker: 'KXBTC', category: 'crypto' },
    { ticker: 'KXETH', category: 'crypto' },
    { ticker: 'KXSOL', category: 'crypto' },
    { ticker: 'KXFED', category: 'macro' },
    { ticker: 'KXCPI', category: 'macro' },
    { ticker: 'KXGDP', category: 'macro' },
    { ticker: 'KXTARIFF', category: 'macro' },
    { ticker: 'KXRECESSION', category: 'macro' },
    { ticker: 'KXINAUGURAL', category: 'politics' },
    { ticker: 'KXTRUMP', category: 'politics' },
  ];

  for (const { ticker, category } of seriesList) {
    try {
      const data = await get(`https://api.elections.kalshi.com/trade-api/v2/events?limit=3&with_nested_markets=true&status=open&series_ticker=${ticker}`);
      if (!data?.events) continue;

      for (const event of data.events) {
        // Get top markets by volume
        const topMarkets = (event.markets || [])
          .filter(m => m.volume > 0)
          .sort((a, b) => b.volume - a.volume)
          .slice(0, 3);

        if (topMarkets.length === 0) continue;

        // Find the highest-probability outcome
        const best = topMarkets[0];
        const yesPrice = best.yes_bid || 0;
        const noPrice = best.no_bid || 0;

        markets.push({
          source: 'Kalshi',
          category,
          question: event.title,
          topOutcome: best.title,
          yes: yesPrice,
          no: noPrice,
          volume: best.volume,
          totalVolume: topMarkets.reduce((s, m) => s + m.volume, 0),
          url: `https://kalshi.com/events/${event.event_ticker}`,
        });
      }
    } catch {}
  }
  return markets;
}

// --- Format output ---
function formatMarkets(allMarkets) {
  // Filter by category
  let filtered = allMarkets;
  if (wantCrypto) filtered = allMarkets.filter(m => m.category === 'crypto');
  if (wantMacro) filtered = allMarkets.filter(m => m.category === 'macro');
  if (wantPolitics) filtered = allMarkets.filter(m => m.category === 'politics');

  // Alert mode: only high-conviction (>80% or <20%) or high-volume
  if (wantAlert) {
    filtered = filtered.filter(m => m.yes >= 80 || m.yes <= 20 || (m.volume24h || m.totalVolume || 0) > 50000);
  }

  if (wantJson) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  // Group by category
  const groups = {};
  for (const m of filtered) {
    groups[m.category] = groups[m.category] || [];
    groups[m.category].push(m);
  }

  const catLabels = { crypto: 'CRYPTO', macro: 'MACRO/ECON', politics: 'POLITICS', other: 'OTHER' };
  const catOrder = ['crypto', 'macro', 'politics', 'other'];

  console.log('═══ PREDICTION MARKETS ═══\n');

  for (const cat of catOrder) {
    const items = groups[cat];
    if (!items || items.length === 0) continue;

    console.log(`▸ ${catLabels[cat]}`);
    for (const m of items) {
      const conviction = m.yes >= 70 ? '🟢' : m.yes <= 30 ? '🔴' : '🟡';
      const vol = m.volume24h ? `$${(m.volume24h/1000).toFixed(0)}K vol` : m.totalVolume ? `${m.totalVolume} contracts` : '';
      
      if (m.topOutcome) {
        // Kalshi style — show the event + top outcome
        console.log(`  ${conviction} ${m.question}`);
        console.log(`     ${m.topOutcome}: ${m.yes}¢ yes | ${vol} [${m.source}]`);
      } else {
        // Polymarket style
        console.log(`  ${conviction} ${m.question}`);
        console.log(`     Yes: ${m.yes}¢ No: ${m.no}¢ | ${vol} [${m.source}]`);
      }
    }
    console.log();
  }
}

async function main() {
  const [polymarkets, kalshiMarkets] = await Promise.all([
    fetchPolymarket(),
    fetchKalshi(),
  ]);

  const all = [...polymarkets, ...kalshiMarkets];
  
  if (!wantJson) {
    console.error(`Fetched ${polymarkets.length} Polymarket + ${kalshiMarkets.length} Kalshi markets\n`);
  }

  formatMarkets(all);

  // Save latest data for briefings
  const fs = require('fs');
  const dataDir = require('path').join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    require('path').join(dataDir, 'prediction-markets-latest.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), polymarket: polymarkets.length, kalshi: kalshiMarkets.length, markets: all }, null, 2)
  );
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
