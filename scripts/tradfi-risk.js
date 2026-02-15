require("./env");
#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

// Create data directory if it doesn't exist
const dataDir = '' + path.resolve(__dirname, '..', 'data') + '';
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Helper to make HTTP GET requests with headers
function makeHttpRequest(url, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ETF-Bot/1.0)',
        ...headers
      },
      timeout
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        resolve({ data, statusCode: res.statusCode, headers: res.headers });
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.end();
  });
}

// Fetch from Yahoo Finance API
async function fetchYahooFinanceData(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
    const response = await makeHttpRequest(url);
    
    if (response.statusCode === 200) {
      const data = JSON.parse(response.data);
      const result = data.chart?.result?.[0];
      
      if (result && result.indicators?.quote?.[0]) {
        const quote = result.indicators.quote[0];
        const closes = quote.close;
        const timestamps = result.timestamp;
        
        if (closes && closes.length >= 2) {
          const current = closes[closes.length - 1];
          const previous = closes[closes.length - 2];
          const dailyChange = ((current - previous) / previous) * 100;
          
          return {
            current,
            previous,
            dailyChange,
            timestamp: timestamps[timestamps.length - 1]
          };
        }
      }
    }
    
    throw new Error(`Failed to parse Yahoo Finance data for ${symbol}`);
    
  } catch (error) {
    console.error(`✗ Failed to fetch ${symbol}:`, error.message);
    return null;
  }
}

// Fetch VIX
async function fetchVIX() {
  console.log('📊 Fetching VIX...');
  return await fetchYahooFinanceData('^VIX');
}

// Fetch DXY (US Dollar Index)
async function fetchDXY() {
  console.log('💵 Fetching DXY...');
  return await fetchYahooFinanceData('DX-Y.NYB');
}

// Fetch US 10Y Treasury Yield
async function fetchUS10Y() {
  console.log('📈 Fetching US 10Y Yield...');
  return await fetchYahooFinanceData('^TNX');
}

// Fetch S&P 500
async function fetchSP500() {
  console.log('🏛️ Fetching S&P 500...');
  return await fetchYahooFinanceData('^GSPC');
}

// Calculate High Yield Spread (HYG vs LQD approximation)
async function fetchHighYieldSpread() {
  try {
    console.log('📊 Calculating High Yield Spread (HYG vs LQD)...');
    
    const [hygData, lqdData] = await Promise.all([
      fetchYahooFinanceData('HYG'),  // High Yield ETF
      fetchYahooFinanceData('LQD')   // Investment Grade ETF
    ]);
    
    if (hygData && lqdData) {
      // Approximate spread calculation
      const hygYield = hygData.dailyChange;
      const lqdYield = lqdData.dailyChange;
      const spread = hygYield - lqdYield;
      
      return {
        current: spread,
        dailyChange: spread,
        hyg_change: hygYield,
        lqd_change: lqdYield
      };
    }
    
    return null;
    
  } catch (error) {
    console.error('✗ Failed to calculate High Yield Spread:', error.message);
    return null;
  }
}

// Alternative: try FRED API for high yield spread
async function fetchFREDSpread() {
  try {
    console.log('📊 Trying FRED API for HY spread...');
    
    // FRED sometimes allows no-key access for some series
    const url = 'https://api.stlouisfed.org/fred/series/observations?series_id=BAMLH0A0HYM2&api_key=demo&file_type=json&limit=2&sort_order=desc';
    const response = await makeHttpRequest(url);
    
    if (response.statusCode === 200) {
      const data = JSON.parse(response.data);
      const obs = data.observations;
      
      if (obs && obs.length >= 2) {
        const current = parseFloat(obs[0].value);
        const previous = parseFloat(obs[1].value);
        const dailyChange = current - previous;
        
        return {
          current,
          dailyChange,
          source: 'FRED'
        };
      }
    }
    
    return null;
    
  } catch (error) {
    console.error('✗ FRED API failed:', error.message);
    return null;
  }
}

// Calculate overall risk sentiment
function calculateRiskSentiment(vix, dxy, us10y, sp500, hySpread) {
  let riskOnSignals = 0;
  let riskOffSignals = 0;
  
  // VIX analysis (lower = risk on)
  if (vix) {
    if (vix.current < 15) riskOnSignals += 2;
    else if (vix.current < 20) riskOnSignals += 1;
    else if (vix.current > 30) riskOffSignals += 2;
    else if (vix.current > 25) riskOffSignals += 1;
    
    if (vix.dailyChange < -5) riskOnSignals += 1;
    else if (vix.dailyChange > 5) riskOffSignals += 1;
  }
  
  // S&P 500 analysis (up = risk on)
  if (sp500) {
    if (sp500.dailyChange > 1) riskOnSignals += 1;
    else if (sp500.dailyChange < -1) riskOffSignals += 1;
  }
  
  // DXY analysis (down = risk on for assets)
  if (dxy) {
    if (dxy.dailyChange < -0.5) riskOnSignals += 1;
    else if (dxy.dailyChange > 0.5) riskOffSignals += 1;
  }
  
  // US 10Y yield analysis (moderate rise = risk on)
  if (us10y) {
    if (us10y.dailyChange > 0.1 && us10y.dailyChange < 0.2) riskOnSignals += 1;
    else if (us10y.dailyChange < -0.1) riskOffSignals += 1;
  }
  
  // High Yield spread analysis (narrowing = risk on)
  if (hySpread && typeof hySpread.dailyChange === 'number') {
    if (hySpread.dailyChange < -0.1) riskOnSignals += 1;
    else if (hySpread.dailyChange > 0.2) riskOffSignals += 1;
  }
  
  if (riskOnSignals > riskOffSignals + 1) return 'risk-on';
  if (riskOffSignals > riskOnSignals + 1) return 'risk-off';
  return 'neutral';
}

// Generate interpretation
function generateInterpretation(sentiment, vix, sp500) {
  const vixLevel = vix ? vix.current : null;
  const spChange = sp500 ? sp500.dailyChange : null;
  
  if (sentiment === 'risk-on') {
    return `Markets in risk-on mode with ${vixLevel ? `VIX at ${vixLevel.toFixed(1)}` : 'low volatility'}${spChange ? ` and S&P ${spChange > 0 ? 'up' : 'down'} ${Math.abs(spChange).toFixed(1)}%` : ''}`;
  } else if (sentiment === 'risk-off') {
    return `Risk-off sentiment prevailing with ${vixLevel ? `elevated VIX (${vixLevel.toFixed(1)})` : 'high volatility'}${spChange ? ` and S&P ${spChange > 0 ? 'up' : 'down'} ${Math.abs(spChange).toFixed(1)}%` : ''}`;
  } else {
    return `Mixed signals in traditional markets with ${vixLevel ? `VIX at ${vixLevel.toFixed(1)}` : 'moderate volatility'}`;
  }
}

async function main() {
  console.log('📊 Fetching TradFi risk indicators...\n');
  
  // Fetch all indicators in parallel
  const [vixData, dxyData, us10yData, sp500Data] = await Promise.all([
    fetchVIX(),
    fetchDXY(),
    fetchUS10Y(),
    fetchSP500()
  ]);
  
  // Try to get high yield spread
  let hySpreadData = await fetchFREDSpread();
  if (!hySpreadData) {
    hySpreadData = await fetchHighYieldSpread();
  }
  
  // Calculate risk sentiment
  const sentiment = calculateRiskSentiment(vixData, dxyData, us10yData, sp500Data, hySpreadData);
  const interpretation = generateInterpretation(sentiment, vixData, sp500Data);
  
  // Build result
  const result = {
    timestamp: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0],
    indicators: {
      vix: vixData ? {
        current: vixData.current,
        daily_change: vixData.dailyChange,
        previous: vixData.previous
      } : null,
      dxy: dxyData ? {
        current: dxyData.current,
        daily_change: dxyData.dailyChange,
        previous: dxyData.previous
      } : null,
      us_10y_yield: us10yData ? {
        current: us10yData.current,
        daily_change: us10yData.dailyChange,
        previous: us10yData.previous
      } : null,
      sp500: sp500Data ? {
        current: sp500Data.current,
        daily_change: sp500Data.dailyChange,
        previous: sp500Data.previous
      } : null,
      high_yield_spread: hySpreadData ? {
        current: hySpreadData.current,
        daily_change: hySpreadData.dailyChange,
        source: hySpreadData.source || 'ETF_approximation'
      } : null
    },
    risk_sentiment: sentiment,
    interpretation: interpretation,
    source: 'yahoo_finance'
  };
  
  // Save to file
  const outputPath = path.join(dataDir, 'tradfi-risk.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  
  // Output to stdout
  console.log(JSON.stringify(result, null, 2));
  
  console.error(`\n✅ TradFi risk data saved to: ${outputPath}`);
  console.error(`📊 Risk Sentiment: ${sentiment.toUpperCase()}`);
  console.error(`💡 ${interpretation}`);
  console.error(`📈 VIX: ${vixData ? vixData.current.toFixed(1) : 'N/A'} | S&P: ${sp500Data ? `${sp500Data.dailyChange > 0 ? '+' : ''}${sp500Data.dailyChange.toFixed(2)}%` : 'N/A'}`);
}

// Run the script
main().catch(error => {
  console.error('❌ TradFi risk script failed:', error);
  process.exit(1);
});