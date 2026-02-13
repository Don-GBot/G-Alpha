#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

// Exchanges to fetch from
const EXCHANGES = ['okx', 'bitget', 'gate'];

// Majors — always fetch OI for these regardless of funding rate
const MAJORS = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'SUI', 'LINK', 'AVAX', 'PEPE', 'WIF', 'BONK', 'ARB', 'OP', 'APT', 'ONDO', 'AAVE', 'UNI', 'TIA', 'SEI', 'INJ', 'NEAR', 'RENDER', 'FIL', 'STX', 'HBAR'];
const API_URL = 'https://hiveintelligence.xyz/mcp';

// Create data directory if it doesn't exist
const dataDir = '/home/ubuntu/clawd/data';
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Helper to make HTTP POST requests
function makeApiCall(data, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: 'hiveintelligence.xyz',
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: timeout
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          // Parse SSE response
          const lines = responseData.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonData = JSON.parse(line.substring(6));
              if (jsonData.result && jsonData.result.content && jsonData.result.content[0]) {
                const content = JSON.parse(jsonData.result.content[0].text);
                resolve(content);
                return;
              }
            }
          }
          throw new Error('No valid data found in SSE response');
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

// Get funding rates for one exchange
async function getFundingRates(exchange) {
  const requestData = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'invoke_api_endpoint',
      arguments: {
        endpoint_name: 'get_funding_rates',
        args: { exchange }
      }
    },
    id: 1
  };

  try {
    const data = await makeApiCall(requestData, 30000);
    console.log(`✓ Fetched funding rates from ${exchange.toUpperCase()}: ${Object.keys(data).length} symbols`);
    return { exchange, data };
  } catch (error) {
    console.error(`✗ Failed to fetch funding rates from ${exchange.toUpperCase()}:`, error.message);
    return { exchange, data: null, error: error.message };
  }
}

// Get open interest for one symbol
async function getOpenInterest(symbol) {
  const requestData = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'invoke_api_endpoint',
      arguments: {
        endpoint_name: 'get_open_interest',
        args: { 
          exchange: 'okx',
          symbol 
        }
      }
    },
    id: 1
  };

  try {
    const data = await makeApiCall(requestData, 10000);
    return data.openInterestValue || data.oiUsd || null;
  } catch (error) {
    console.error(`✗ Failed to fetch OI for ${symbol}:`, error.message);
    return null;
  }
}

// Normalize symbol to base ticker (e.g., "BTC/USDT:USDT" → "BTC")
function normalizeTicker(symbol) {
  return symbol.split('/')[0];
}

// Thresholds (raw decimals, NOT percentages)
const EXTREME_THRESHOLD = 0.006;    // 0.6% — fires alerts
const BRIEFING_THRESHOLD = 0.01;    // 1.0% — mentioned in briefing/recap
const NOTEWORTHY_THRESHOLD = 0.003; // 0.3% — tracked in data, not surfaced

// Calculate sentiment based on funding rate
function calculateSentiment(avgRate) {
  if (avgRate > 0.006) return 'longs_crowded';
  if (avgRate > 0.001) return 'bullish';
  if (avgRate < -0.006) return 'shorts_crowded';
  if (avgRate < -0.001) return 'bearish';
  return 'neutral';
}

// Check if coin is noteworthy
function isNoteworthy(coinData) {
  const { avgRate, minRate, maxRate, oiUsd } = coinData;
  
  // Meaningful funding rate
  if (Math.abs(avgRate) > NOTEWORTHY_THRESHOLD) return true;
  
  // High divergence across exchanges (arbitrage opportunity)
  if (maxRate - minRate > 0.003) return true;
  
  // High OI with elevated rate
  if (oiUsd && oiUsd > 500000000 && Math.abs(avgRate) > 0.001) return true;
  
  return false;
}

async function main() {
  console.log('🚀 Fetching funding rates from all exchanges...\n');
  
  // 1. Fetch funding rates from all exchanges in parallel
  const exchangePromises = EXCHANGES.map(exchange => getFundingRates(exchange));
  const exchangeResults = await Promise.all(exchangePromises);
  
  // 2. Process and aggregate data
  const coinMap = new Map();
  
  for (const result of exchangeResults) {
    if (!result.data) continue;
    
    for (const [symbol, fundingData] of Object.entries(result.data)) {
      const coin = normalizeTicker(symbol);
      const rate = fundingData.fundingRate;
      
      if (typeof rate !== 'number' || isNaN(rate)) continue;
      
      if (!coinMap.has(coin)) {
        coinMap.set(coin, {
          coin,
          rates: [],
          exchanges: [],
          symbols: new Set()
        });
      }
      
      const coinData = coinMap.get(coin);
      coinData.rates.push(rate);
      coinData.exchanges.push({ exchange: result.exchange, rate });
      coinData.symbols.add(symbol);
    }
  }
  
  // 3. Calculate aggregated metrics
  const coins = [];
  for (const [coin, data] of coinMap) {
    const rates = data.rates;
    if (rates.length === 0) continue;
    
    const avgRate = rates.reduce((sum, r) => sum + r, 0) / rates.length;
    const minRate = Math.min(...rates);
    const maxRate = Math.max(...rates);
    
    const coinObj = {
      coin,
      avgRate,
      minRate,
      maxRate,
      exchangeCount: rates.length,
      exchanges: data.exchanges,
      oiUsd: null,
      sentiment: calculateSentiment(avgRate),
      isExtreme: false, // recalculated after OI fetch
      isNoteworthy: false
    };
    
    coinObj.isNoteworthy = isNoteworthy(coinObj);
    coinObj.isBriefingWorthy = Math.abs(avgRate) > BRIEFING_THRESHOLD;
    coins.push(coinObj);
  }
  
  // 4. Sort by absolute funding rate (most extreme first)
  coins.sort((a, b) => Math.abs(b.avgRate) - Math.abs(a.avgRate));
  
  // 5. Fetch open interest for top 30 most extreme + majors (deduplicated)
  const top30Coins = new Set(coins.slice(0, 30).map(c => c.coin));
  for (const m of MAJORS) top30Coins.add(m);
  const oiTargets = coins.filter(c => top30Coins.has(c.coin));
  
  console.log(`\n📊 Fetching open interest for ${oiTargets.length} coins (top 30 extreme + majors)...`);
  
  for (let i = 0; i < oiTargets.length; i++) {
    const coin = oiTargets[i];
    
    // Find a good symbol to use for OI (prefer USDT pairs)
    const symbols = Array.from(coinMap.get(coin.coin).symbols);
    const usdtSymbol = symbols.find(s => s.includes('USDT:USDT'));
    const targetSymbol = usdtSymbol || symbols[0];
    
    if (targetSymbol) {
      console.log(`  ${i + 1}/${oiTargets.length}: ${coin.coin} (${targetSymbol})`);
      coin.oiUsd = await getOpenInterest(targetSymbol);
      
      // Rate limiting
      if (i < oiTargets.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  
  // Recalculate isNoteworthy after getting OI data
  for (const coin of coins) {
    coin.isNoteworthy = isNoteworthy(coin);
    coin.isExtreme = Math.abs(coin.avgRate) > EXTREME_THRESHOLD && coin.oiUsd && coin.oiUsd > 1000000;
    coin.isBriefingWorthy = Math.abs(coin.avgRate) > BRIEFING_THRESHOLD && coin.oiUsd && coin.oiUsd > 1000000;
  }
  
  // 6. Generate output
  const result = {
    timestamp: new Date().toISOString(),
    source: 'hive-intelligence',
    exchanges: EXCHANGES,
    totalCoins: coins.length,
    coins: coins
  };
  
  // 7. Save to file
  const outputPath = path.join(dataDir, 'funding-rates-latest.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  
  // 8. Print summary
  const noteworthyCount = coins.filter(c => c.isNoteworthy).length;
  const extremeCount = coins.filter(c => c.isExtreme).length;
  
  console.log(`\n✅ Summary:`);
  console.log(`   Total coins: ${coins.length}`);
  console.log(`   Noteworthy: ${noteworthyCount}`);
  console.log(`   Extreme: ${extremeCount}`);
  console.log(`   Data saved to: ${outputPath}`);
  
  console.log(`\n🔥 Top 10 Most Extreme Funding Rates:`);
  console.log('   Rank | Coin     | Avg Rate    | OI (USD)        | Sentiment');
  console.log('   -----|----------|-------------|-----------------|----------------');
  
  for (let i = 0; i < Math.min(10, coins.length); i++) {
    const coin = coins[i];
    const rateStr = (coin.avgRate * 100).toFixed(4) + '%';
    const oiStr = coin.oiUsd ? `$${(coin.oiUsd / 1000000).toFixed(0)}M` : 'N/A';
    
    console.log(`   ${String(i + 1).padStart(4)} | ${coin.coin.padEnd(8)} | ${rateStr.padStart(11)} | ${oiStr.padStart(15)} | ${coin.sentiment}`);
  }
  
  console.log('\n🎯 Done!');
}

// Run the script
main().catch(error => {
  console.error('❌ Script failed:', error);
  process.exit(1);
});