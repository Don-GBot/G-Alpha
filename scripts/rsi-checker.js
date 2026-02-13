require("./env");
#!/usr/bin/env node
/**
 * RSI Checker — calculates 14-period RSI for given coins
 * Uses CoinGecko OHLC data (free, no key)
 * 
 * Usage: 
 *   node rsi-checker.js BTC ETH SOL         — check specific coins
 *   node rsi-checker.js --extreme            — check coins with extreme funding rates
 *   node rsi-checker.js --all-notable        — check extreme + high OI coins
 */

const fs = require('fs');

const FUNDING_PATH = '' + path.resolve(__dirname, '..', 'data') + '/funding-rates-latest.json';
const OUTPUT_PATH = '' + path.resolve(__dirname, '..', 'data') + '/rsi-latest.json';

// Map common perp ticker symbols to CoinGecko IDs
const TICKER_TO_GECKO = {
  'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'XRP': 'ripple',
  'DOGE': 'dogecoin', 'ADA': 'cardano', 'AVAX': 'avalanche-2', 'DOT': 'polkadot',
  'LINK': 'chainlink', 'MATIC': 'matic-network', 'UNI': 'uniswap', 'ATOM': 'cosmos',
  'FIL': 'filecoin', 'APT': 'aptos', 'ARB': 'arbitrum', 'OP': 'optimism',
  'SUI': 'sui', 'SEI': 'sei-network', 'TIA': 'celestia', 'INJ': 'injective-protocol',
  'NEAR': 'near', 'FTM': 'fantom', 'ALGO': 'algorand', 'AAVE': 'aave',
  'MKR': 'maker', 'LDO': 'lido-dao', 'CRV': 'curve-dao-token', 'RUNE': 'thorchain',
  'STX': 'blockstack', 'IMX': 'immutable-x', 'PEPE': 'pepe', 'WIF': 'dogwifcoin',
  'BONK': 'bonk', 'FLOKI': 'floki', 'SHIB': 'shiba-inu', 'LTC': 'litecoin',
  'BCH': 'bitcoin-cash', 'ETC': 'ethereum-classic', 'RENDER': 'render-token',
  'FET': 'fetch-ai', 'RNDR': 'render-token', 'TAO': 'bittensor', 'GRT': 'the-graph',
  'BERA': 'berachain', 'JUP': 'jupiter-exchange-solana', 'WLD': 'worldcoin-wld',
  'PYTH': 'pyth-network', 'JTO': 'jito-governance-token', 'ONDO': 'ondo-finance',
  'PENDLE': 'pendle', 'ENA': 'ethena', 'W': 'wormhole', 'STRK': 'starknet',
  'ZK': 'zksync', 'BLAST': 'blast', 'MEME': 'memecoin-2', 'ORDI': 'ordinals',
  'SATS': '1000sats', 'TRX': 'tron', 'TON': 'the-open-network', 'NOT': 'notcoin',
  'BNB': 'binancecoin', 'VANA': 'vana', 'ZKP': 'panther',
  'TRUMP': 'official-trump', 'MELANIA': 'melania-meme', 'AI16Z': 'ai16z',
  'VIRTUAL': 'virtual-protocol', 'FARTCOIN': 'fartcoin', 'GRIFFAIN': 'griffain',
  'POPCAT': 'popcat', 'MEW': 'cat-in-a-dogs-world', 'PNUT': 'peanut-the-squirrel',
  'KAITO': 'kaito', 'IP': 'story-protocol', 'ANIME': 'animecoin',
  'LAYER': 'solayer', 'TST': 'the-standard-token', 'VINE': 'vine',
  'SPX': 'spx6900', 'AIXBT': 'aixbt',
};

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  
  let gains = 0;
  let losses = 0;
  
  // First average
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  // Smoothed RSI for remaining periods
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - (100 / (1 + rs))) * 100) / 100;
}

async function fetchCloses(ticker) {
  try {
    // Use CryptoCompare — free, no key needed, generous rate limits
    const resp = await fetch(
      `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${ticker}&tsym=USD&limit=20`
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.Response !== 'Success') return null;
    return data.Data.Data.map(d => d.close).filter(c => c > 0);
  } catch {
    return null;
  }
}

function getRSILabel(rsi) {
  if (rsi >= 80) return 'EXTREMELY OVERBOUGHT';
  if (rsi >= 70) return 'OVERBOUGHT';
  if (rsi >= 60) return 'BULLISH';
  if (rsi >= 40) return 'NEUTRAL';
  if (rsi >= 30) return 'BEARISH';
  if (rsi >= 20) return 'OVERSOLD';
  return 'EXTREMELY OVERSOLD';
}

function getConfluenceSignal(rsi, fundingRate) {
  // RSI oversold + negative funding (shorts crowded) = potential long squeeze
  if (rsi <= 30 && fundingRate < -0.003) {
    return '🔥 CONFLUENCE: Oversold RSI + shorts crowded = potential reversal UP';
  }
  // RSI overbought + positive funding (longs crowded) = potential short squeeze  
  if (rsi >= 70 && fundingRate > 0.003) {
    return '🔥 CONFLUENCE: Overbought RSI + longs crowded = potential reversal DOWN';
  }
  // RSI extreme + extreme funding = strongest signal
  if (rsi <= 20 && fundingRate < -0.006) {
    return '⚡ STRONG CONFLUENCE: Extremely oversold + extreme short crowding = high probability bounce';
  }
  if (rsi >= 80 && fundingRate > 0.006) {
    return '⚡ STRONG CONFLUENCE: Extremely overbought + extreme long crowding = high probability dump';
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  let coins = [];
  
  if (args.includes('--extreme') || args.includes('--all-notable')) {
    // Load from funding rates
    try {
      const funding = JSON.parse(fs.readFileSync(FUNDING_PATH, 'utf8'));
      
      if (args.includes('--extreme')) {
        coins = funding.coins
          .filter(c => c.isExtreme)
          .map(c => ({ ticker: c.coin, rate: c.avgRate, oi: c.oiUsd }));
      } else {
        // All notable: extreme + top OI
        const extreme = funding.coins.filter(c => c.isExtreme);
        const topOI = funding.coins
          .filter(c => c.oiUsd && c.oiUsd > 5000000)
          .sort((a, b) => b.oiUsd - a.oiUsd)
          .slice(0, 15);
        
        const seen = new Set();
        coins = [...extreme, ...topOI]
          .filter(c => { if (seen.has(c.coin)) return false; seen.add(c.coin); return true; })
          .map(c => ({ ticker: c.coin, rate: c.avgRate, oi: c.oiUsd }));
      }
    } catch (e) {
      console.error('Failed to load funding rates:', e.message);
      process.exit(1);
    }
  } else if (args.length > 0) {
    coins = args.map(t => ({ ticker: t.toUpperCase(), rate: null, oi: null }));
  } else {
    console.log('Usage:');
    console.log('  node rsi-checker.js BTC ETH SOL');
    console.log('  node rsi-checker.js --extreme        (coins with extreme funding)');
    console.log('  node rsi-checker.js --all-notable     (extreme + high OI coins)');
    process.exit(0);
  }
  
  console.log(`\n📊 RSI CHECK — ${coins.length} coins\n${'='.repeat(50)}\n`);
  
  const results = [];
  
  for (const coin of coins) {
    // Rate limit: CryptoCompare is generous but be polite
    await new Promise(r => setTimeout(r, 500));
    
    const closes = await fetchCloses(coin.ticker);
    if (!closes || closes.length < 15) {
      console.log(`  ${coin.ticker}: Insufficient data — skipped`);
      continue;
    }
    
    const rsi = calculateRSI(closes);
    if (rsi === null) continue;
    
    const label = getRSILabel(rsi);
    const confluence = coin.rate ? getConfluenceSignal(rsi, coin.rate) : null;
    
    const result = {
      ticker: coin.ticker,
      rsi,
      label,
      fundingRate: coin.rate ? Math.round(coin.rate * 10000) / 100 : null,
      oiUsd: coin.oi,
      confluence: confluence || null,
      price: closes[closes.length - 1]
    };
    results.push(result);
    
    // Print
    const rsiStr = rsi <= 30 || rsi >= 70 ? `⚠️ ${rsi}` : `${rsi}`;
    const fundStr = coin.rate ? ` | Funding: ${result.fundingRate}%` : '';
    const oiStr = coin.oi ? ` | OI: $${Math.round(coin.oi / 1000000)}M` : '';
    console.log(`  ${coin.ticker}: RSI ${rsiStr} (${label})${fundStr}${oiStr}`);
    if (confluence) console.log(`    ${confluence}`);
  }
  
  // Save output
  const output = {
    generated: new Date().toISOString(),
    period: 14,
    coins: results,
    confluenceAlerts: results.filter(r => r.confluence)
  };
  
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  
  // Summary
  const overbought = results.filter(r => r.rsi >= 70);
  const oversold = results.filter(r => r.rsi <= 30);
  const confluences = results.filter(r => r.confluence);
  
  console.log(`\n--- SUMMARY ---`);
  console.log(`Checked: ${results.length} coins`);
  if (overbought.length) console.log(`Overbought (RSI≥70): ${overbought.map(r => r.ticker).join(', ')}`);
  if (oversold.length) console.log(`Oversold (RSI≤30): ${oversold.map(r => r.ticker).join(', ')}`);
  if (confluences.length) console.log(`Confluence signals: ${confluences.map(r => r.ticker).join(', ')}`);
  if (!overbought.length && !oversold.length) console.log('No overbought/oversold coins detected');
}

main().catch(console.error);
