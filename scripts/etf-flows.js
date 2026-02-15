require("./env");
#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

const dataDir = '' + path.resolve(__dirname, '..', 'data') + '';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// BTC spot ETFs
const BTC_ETFS = [
  { ticker: 'IBIT', name: 'BlackRock', key: 'blackrock' },
  { ticker: 'FBTC', name: 'Fidelity', key: 'fidelity' },
  { ticker: 'GBTC', name: 'Grayscale', key: 'grayscale' },
  { ticker: 'ARKB', name: 'ARK/21Shares', key: 'ark' },
  { ticker: 'BITB', name: 'Bitwise', key: 'bitwise' },
];

// ETH spot ETFs
const ETH_ETFS = [
  { ticker: 'ETHA', name: 'BlackRock ETH', key: 'blackrock_eth' },
  { ticker: 'FETH', name: 'Fidelity ETH', key: 'fidelity_eth' },
  { ticker: 'ETHE', name: 'Grayscale ETH', key: 'grayscale_eth' },
];

function fetchYahoo(ticker) {
  return new Promise((resolve, reject) => {
    const url = `/v8/finance/chart/${ticker}?range=10d&interval=1d`;
    const req = https.request({
      hostname: 'query1.finance.yahoo.com',
      path: url,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const r = j.chart?.result?.[0];
          if (!r) return reject(new Error(`No data for ${ticker}`));
          const ts = r.timestamp || [];
          const q = r.indicators?.quote?.[0] || {};
          const days = ts.map((t, i) => ({
            date: new Date(t * 1000).toISOString().slice(0, 10),
            close: q.close?.[i] || 0,
            volume: q.volume?.[i] || 0,
            open: q.open?.[i] || 0,
          }));
          resolve(days);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Estimate dollar flow from volume and price direction
// Positive volume on up days = inflow estimate, negative on down days
function estimateFlow(days) {
  if (days.length < 2) return { flow: 0, streak: 0 };
  const latest = days[days.length - 1];
  const prev = days[days.length - 2];
  const priceChange = latest.close - prev.close;
  // Volume in shares * avg price = dollar volume, direction from price change
  const avgPrice = (latest.open + latest.close) / 2;
  const dollarVol = latest.volume * avgPrice;
  // Use price direction as flow direction (simplified — real flows need NAV data)
  const flow = priceChange >= 0 ? dollarVol * 0.05 : -dollarVol * 0.03;
  
  // Calculate streak
  let streak = 0;
  const direction = priceChange >= 0 ? 1 : -1;
  for (let i = days.length - 1; i >= 1; i--) {
    const d = days[i].close - days[i-1].close >= 0 ? 1 : -1;
    if (d === direction) streak++;
    else break;
  }
  
  return { flow: Math.round(flow), streak: streak * direction, latest, prev };
}

async function main() {
  console.log('🏦 Fetching ETF flow data from Yahoo Finance...\n');
  
  const results = { btc: {}, eth: {} };
  let btcTotalFlow = 0;
  let ethTotalFlow = 0;
  const topFunds = {};
  
  // Fetch BTC ETFs
  for (const etf of BTC_ETFS) {
    try {
      const days = await fetchYahoo(etf.ticker);
      const { flow, streak, latest } = estimateFlow(days);
      results.btc[etf.ticker] = { name: etf.name, flow, streak, price: latest?.close, volume: latest?.volume };
      topFunds[`${etf.key}_btc`] = flow;
      btcTotalFlow += flow;
      console.log(`  ${etf.ticker} (${etf.name}): $${(flow/1e6).toFixed(1)}M flow, ${streak}d streak, price $${latest?.close?.toFixed(2)}`);
    } catch (e) {
      console.log(`  ${etf.ticker}: error - ${e.message}`);
    }
  }
  
  console.log('');
  
  // Fetch ETH ETFs
  for (const etf of ETH_ETFS) {
    try {
      const days = await fetchYahoo(etf.ticker);
      const { flow, streak, latest } = estimateFlow(days);
      results.eth[etf.ticker] = { name: etf.name, flow, streak, price: latest?.close, volume: latest?.volume };
      topFunds[`${etf.key}`] = flow;
      ethTotalFlow += flow;
      console.log(`  ${etf.ticker} (${etf.name}): $${(flow/1e6).toFixed(1)}M flow, ${streak}d streak, price $${latest?.close?.toFixed(2)}`);
    } catch (e) {
      console.log(`  ${etf.ticker}: error - ${e.message}`);
    }
  }
  
  // Build output
  const latestDate = Object.values(results.btc)[0]?.price ? new Date().toISOString().slice(0, 10) : 'unknown';
  
  const output = {
    date: latestDate,
    source: 'yahoo_finance_etf_tickers',
    note: 'Flow estimates based on volume * price direction. For exact flows, use CoinGlass API with key.',
    btc_etf_flow_usd: btcTotalFlow,
    eth_etf_flow_usd: ethTotalFlow,
    top_funds: topFunds,
    btc_streak: results.btc.IBIT?.streak || 0,
    eth_streak: results.eth.ETHA?.streak || 0,
    btc_etfs: results.btc,
    eth_etfs: results.eth,
    timestamp: new Date().toISOString()
  };
  
  console.log('\n' + JSON.stringify(output, null, 2));
  
  // Save to file
  const outPath = path.join(dataDir, 'etf-flows.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n💾 Saved to ${outPath}`);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
