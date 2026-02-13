require("./env");
#!/usr/bin/env node
/**
 * Squeeze Monitor v2 — reads funding-rates-latest.json and flags squeeze candidates
 * 
 * Criteria:
 *   1. Extreme funding (shorts_crowded or longs_crowded) + OI > $5M
 *   2. Big exchange divergence (max-min spread > 0.002)
 * 
 * Output: data/squeeze-latest.json
 */

const fs = require('fs');
const path = require('path');

const INPUT_FILE = path.join(__dirname, '../data/funding-rates-latest.json');
const STATE_FILE = path.join(__dirname, '../data/squeeze-state.json');
const OUTPUT_FILE = path.join(__dirname, '../data/squeeze-latest.json');

const OI_THRESHOLD = 1_000_000; // $1M
const DIVERGENCE_THRESHOLD = 0.002;
const COOLDOWN = 4 * 60 * 60 * 1000; // 4h cooldown per coin
const RSI_FILE = path.join(__dirname, '../data/rsi-latest.json');
const EMA_FILE = path.join(__dirname, '../data/ema-latest.json');
const MULTI_TF_FILE = path.join(__dirname, '../data/multi-tf-latest.json');
const ORDERBOOK_FILE = path.join(__dirname, '../data/orderbook-depth-latest.json');
const VOLUME_FILE = path.join(__dirname, '../data/volume-scanner-latest.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastAlerted: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function main() {
  console.log('🔍 Squeeze Monitor v2\n');

  if (!fs.existsSync(INPUT_FILE)) {
    console.error('❌ No funding-rates-latest.json found. Run funding-rates.js first.');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const coins = data.coins || [];
  const state = loadState();
  const now = Date.now();
  const alerts = [];

  // Load RSI data if available
  let rsiData = {};
  try {
    const rsiRaw = JSON.parse(fs.readFileSync(RSI_FILE, 'utf8'));
    for (const c of (rsiRaw.coins || [])) {
      rsiData[c.ticker] = c.rsi;
    }
    console.log(`📊 RSI data loaded for ${Object.keys(rsiData).length} coins`);
  } catch {
    console.log('⚠️ No RSI data available — run rsi-checker.js first');
  }

  // Load EMA data if available
  let emaData = {};
  try {
    const emaRaw = JSON.parse(fs.readFileSync(EMA_FILE, 'utf8'));
    for (const c of (emaRaw.coins || [])) {
      if (!c.error) emaData[c.ticker] = c;
    }
    console.log(`📊 EMA data loaded for ${Object.keys(emaData).length} coins`);
  } catch {
    console.log('⚠️ No EMA data available — run ema-checker.js first');
  }

  // Load multi-timeframe data if available
  let mtfData = {};
  try {
    const mtfRaw = JSON.parse(fs.readFileSync(MULTI_TF_FILE, 'utf8'));
    for (const r of (mtfRaw.results || [])) {
      mtfData[r.coin] = r;
    }
    console.log(`📊 Multi-TF data loaded for ${Object.keys(mtfData).length} coins`);
  } catch {
    console.log('⚠️ No multi-TF data — run multi-tf-analyzer.js first');
  }

  // Load orderbook data if available
  let obData = {};
  try {
    const obRaw = JSON.parse(fs.readFileSync(ORDERBOOK_FILE, 'utf8'));
    for (const r of (obRaw.results || [])) {
      if (!r.error) obData[r.coin] = r;
    }
    console.log(`📊 Orderbook data loaded for ${Object.keys(obData).length} coins`);
  } catch {
    console.log('⚠️ No orderbook data — run orderbook-depth.js first');
  }

  // Load volume data if available
  let volData = {};
  try {
    const volRaw = JSON.parse(fs.readFileSync(VOLUME_FILE, 'utf8'));
    for (const r of (volRaw.results || [])) {
      volData[r.coin] = r;
    }
    console.log(`📊 Volume data loaded for ${Object.keys(volData).length} coins`);
  } catch {
    console.log('⚠️ No volume data — run volume-scanner.js first');
  }

  for (const coin of coins) {
    const reasons = [];

    // Check extreme funding + high OI
    const isCrowded = coin.sentiment === 'shorts_crowded' || coin.sentiment === 'longs_crowded';
    const hasHighOI = coin.oiUsd && coin.oiUsd > OI_THRESHOLD;

    if (isCrowded && hasHighOI) {
      reasons.push(`${coin.sentiment} with $${Math.round(coin.oiUsd / 1_000_000)}M OI`);
    }

    // Check exchange divergence (requires OI > $5M AND funding at least noteworthy ±0.3%)
    const spread = coin.maxRate - coin.minRate;
    const absRate = Math.abs(coin.avgRate);
    if (spread > DIVERGENCE_THRESHOLD && coin.oiUsd && coin.oiUsd > OI_THRESHOLD && absRate >= 0.006) {
      reasons.push(`exchange divergence ${(spread * 100).toFixed(3)}% spread`);
    }

    if (reasons.length === 0) continue;

    // RSI GATE: Only alert if RSI confirms the reversal thesis
    const rsi = rsiData[coin.coin];
    let rsiValid = false;
    let rsiNote = '';
    
    if (rsi !== undefined) {
      // Shorts crowded → only alert if RSI ≤ 35 (oversold, bounce likely = LONG setup)
      if (coin.sentiment === 'shorts_crowded' && rsi <= 35) {
        rsiValid = true;
        rsiNote = `RSI ${rsi} (oversold) — long setup`;
      }
      // Longs crowded → only alert if RSI ≥ 65 (overbought, dump likely = SHORT setup)
      else if (coin.sentiment === 'longs_crowded' && rsi >= 65) {
        rsiValid = true;
        rsiNote = `RSI ${rsi} (overbought) — short setup`;
      }
      else {
        // RSI doesn't confirm — NO ALERT. Confluence required.
        console.log(`  ${coin.coin}: ${coin.sentiment} but RSI ${rsi} doesn't confirm — skipped (confluence required)`);
        continue;
      }
    } else {
      // No RSI data = no confluence = no alert. Period.
      console.log(`  ${coin.coin}: No RSI data — skipped (confluence required)`);
      continue;
    }

    const setupDirection = coin.sentiment === 'shorts_crowded' ? 'LONG' : 'SHORT';
    
    // EMA confluence check
    const ema = emaData[coin.coin];
    let emaNote = '';
    let emaConfirms = false;
    let conviction = 'MEDIUM'; // base: funding + RSI
    
    if (ema) {
      const { trend, alignment, priceVsEMA200, signals: emaSigs } = ema;
      
      // For LONG setup (shorts crowded): EMA confirms if price near support or oversold at EMA level
      if (setupDirection === 'LONG') {
        // Best: bearish stack BUT near EMA support (200 nearby) = max squeeze potential
        if (emaSigs && emaSigs.some(s => s.type === 'NEAR_EMA200' || s.type === 'CROSS_ABOVE_200')) {
          emaConfirms = true;
          emaNote = `EMA 200 battle zone (${priceVsEMA200}% away) — squeeze has structure`;
          conviction = 'HIGH';
        }
        // Good: deeply below 200 + extreme funding = capitulation bounce
        else if (priceVsEMA200 < -30) {
          emaNote = `${priceVsEMA200}% below EMA 200 — extended, capitulation bounce possible`;
          conviction = 'MEDIUM-HIGH';
        }
        // Caution: bearish stack, far from support
        else {
          emaNote = `${trend} ${alignment} (${priceVsEMA200}% from 200)`;
        }
      }
      
      // For SHORT setup (longs crowded): EMA confirms if price at resistance
      if (setupDirection === 'SHORT') {
        if (emaSigs && emaSigs.some(s => s.type === 'NEAR_EMA200' || s.type === 'CROSS_BELOW_200')) {
          emaConfirms = true;
          emaNote = `Rejected at EMA 200 — short has structure`;
          conviction = 'HIGH';
        }
        else if (alignment === 'BEARISH') {
          emaNote = `Bearish EMA stack confirms short bias`;
          emaConfirms = true;
          conviction = 'MEDIUM-HIGH';
        }
        else {
          emaNote = `${trend} ${alignment} (${priceVsEMA200}% from 200)`;
        }
      }
    } else {
      emaNote = 'No EMA data';
    }
    
    // Triple confluence: funding + RSI + EMA all confirm
    const tripleConfluence = rsiValid && emaConfirms;
    if (tripleConfluence) conviction = 'HIGH';

    // --- NEW: Multi-timeframe alignment boost ---
    const mtf = mtfData[coin.coin];
    let mtfNote = '';
    if (mtf) {
      if (setupDirection === 'LONG' && mtf.alignment === 'BEARISH_ALIGNED') {
        mtfNote = 'All TFs bearish — max squeeze potential if reversal triggers';
        if (tripleConfluence) conviction = 'VERY HIGH';
      } else if (setupDirection === 'SHORT' && mtf.alignment === 'BULLISH_ALIGNED') {
        mtfNote = 'All TFs bullish — max squeeze potential if reversal triggers';
        if (tripleConfluence) conviction = 'VERY HIGH';
      } else if (mtf.rsiDivergence) {
        mtfNote = `RSI divergence: ${mtf.rsiDivergence}`;
      } else {
        mtfNote = `TF alignment: ${mtf.alignment}`;
      }
    }

    // --- NEW: Orderbook pressure ---
    const ob = obData[coin.coin];
    let obNote = '';
    if (ob) {
      if (setupDirection === 'LONG' && ob.pressure === 'buy_pressure') {
        obNote = `Book supports long — ${ob.imbalance}x bid/ask ratio`;
        if (conviction === 'HIGH') conviction = 'VERY HIGH';
      } else if (setupDirection === 'SHORT' && ob.pressure === 'sell_pressure') {
        obNote = `Book supports short — ${ob.imbalance}x ask/bid ratio`;
        if (conviction === 'HIGH') conviction = 'VERY HIGH';
      } else if (ob.pressure !== 'neutral') {
        obNote = `Book ${ob.pressure} (${ob.imbalance}x) — conflicts with setup`;
      }
      if (ob.bidWalls || ob.askWalls) {
        const wallCount = (ob.bidWalls?.length || 0) + (ob.askWalls?.length || 0);
        obNote += ` | ${wallCount} wall(s) detected`;
      }
    }

    // --- NEW: Volume context ---
    const vol = volData[coin.coin];
    let volNote = '';
    if (vol) {
      if (vol.isSpike) {
        volNote = `Volume spike: ${vol.spike24h}x vs 24h avg`;
      } else if (vol.isDryUp) {
        volNote = `Volume dry-up (${vol.spike24h}x avg) — thin liquidity = sharper moves`;
      }
      if (vol.oiToVolRatio >= 3) {
        volNote += (volNote ? ' | ' : '') + `High OI/Vol: ${vol.oiToVolRatio}x — crowded`;
      }
    }
    
    alerts.push({
      coin: coin.coin,
      avgRate: coin.avgRate,
      oiUsd: coin.oiUsd,
      sentiment: coin.sentiment,
      setupDirection,
      exchangeCount: coin.exchangeCount,
      rsi: rsi || null,
      rsiNote,
      emaNote,
      emaConfirms,
      mtfNote,
      obNote,
      volNote,
      tripleConfluence,
      conviction,
      reason: reasons.join('; ')
    });
  }

  // Filter by cooldown for "new" alerts
  const newAlerts = alerts.filter(a => {
    const key = `${a.sentiment}_${a.coin}`;
    const last = state.lastAlerted[key] || 0;
    return (now - last) > COOLDOWN;
  });

  // Mark new alerts
  for (const a of newAlerts) {
    state.lastAlerted[`${a.sentiment}_${a.coin}`] = now;
  }

  const output = {
    hasNewAlerts: newAlerts.length > 0,
    alerts: newAlerts,
    allCandidates: alerts,
    timestamp: new Date().toISOString()
  };

  // Log
  if (alerts.length > 0) {
    console.log(`⚡ ${alerts.length} squeeze candidates found (${newAlerts.length} new):\n`);
    for (const a of alerts) {
      const rate = (a.avgRate * 100).toFixed(4);
      const oi = a.oiUsd ? `$${Math.round(a.oiUsd / 1_000_000)}M` : 'N/A';
      const isNew = newAlerts.includes(a) ? ' [NEW]' : ' [cooldown]';
      const rsiStr = a.rsi ? ` | RSI ${a.rsi}` : '';
      const emaStr = a.emaNote ? ` | EMA: ${a.emaNote}` : '';
      const confStr = a.tripleConfluence ? ' ⚡TRIPLE CONFLUENCE' : '';
      const mtfStr = a.mtfNote ? ` | MTF: ${a.mtfNote}` : '';
      const obStr = a.obNote ? ` | OB: ${a.obNote}` : '';
      const volStr = a.volNote ? ` | Vol: ${a.volNote}` : '';
      console.log(`  ${a.coin} [${a.conviction}]: ${rate}% funding, ${oi} OI${rsiStr}${emaStr}${mtfStr}${obStr}${volStr} — ${a.setupDirection}${confStr}${isNew}`);
    }
  } else {
    console.log('No squeeze candidates detected.');
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  saveState(state);
  console.log(`\nSaved to ${OUTPUT_FILE}`);
}

main();
