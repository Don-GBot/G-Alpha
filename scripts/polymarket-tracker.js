require("./env");
#!/usr/bin/env node
/**
 * Polymarket Alert Bot — monitors markets + news for entry opportunities
 * 
 * Tracks odds on crypto/macro/politics/commodities markets.
 * Detects: sharp odds shifts, news-driven mispricings, high-value entries.
 * 
 * Usage: 
 *   node polymarket-tracker.js scan          — full scan, save state, detect shifts
 *   node polymarket-tracker.js markets       — list tracked markets
 *   node polymarket-tracker.js alerts        — show recent alerts
 *   node polymarket-tracker.js --category crypto_price,fed_macro
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATE_PATH = '' + path.resolve(__dirname, '..', 'data') + '/polymarket-state.json';
const ALERTS_PATH = '' + path.resolve(__dirname, '..', 'data') + '/polymarket-alerts.json';
const OUTPUT_PATH = '' + path.resolve(__dirname, '..', 'data') + '/polymarket-latest.json';

// Categories to track
const TRACKED_CATEGORIES = {
  crypto_price: {
    keywords: ['bitcoin', 'ethereum', 'solana', 'xrp', 'crypto', 'btc', 'eth', 'sol'],
    titleMust: ['price', 'above', 'hit', 'up or down'],
    minLiquidity: 500
  },
  fed_macro: {
    keywords: ['fed ', 'fed,', 'rate cut', 'rate hike', 'cpi', 'inflation', 'gdp', 'unemployment', 'jobs', 'fomc', 'interest rate', 'treasury', 'yield'],
    titleMust: null,
    minLiquidity: 200
  },
  politics_geo: {
    keywords: ['trump', 'iran', 'war', 'strike', 'ukraine', 'china', 'tariff', 'trade war', 'sanction', 'nato', 'russia', 'korea', 'nuclear'],
    titleMust: null,
    minLiquidity: 500
  },
  commodities: {
    keywords: ['gold', 'oil', 'silver', 'copper', 'commodit', 'crude', 'natural gas'],
    titleMust: null,
    minLiquidity: 200
  },
  regulation: {
    keywords: ['sec ', 'sec,', 'regulat', 'congress', 'bill', 'stablecoin', 'etf', 'crypto ban', 'crypto bill', 'gensler', 'atkins'],
    titleMust: null,
    minLiquidity: 100
  }
};

// Alert thresholds
const SHIFT_THRESHOLD_FAST = 0.10;    // 10% odds shift in one scan = alert
const SHIFT_THRESHOLD_SLOW = 0.15;    // 15% shift over 1 hour = alert
const MISPRICING_THRESHOLD = 0.20;    // 20%+ gap between news-implied and market odds
const MIN_LIQUIDITY_ALERT = 5000;     // Only alert on markets with $5k+ liquidity
const MIN_UPSIDE = 0.25;             // Only alert if potential return is 25%+ (skip 90¢+ or 10¢- outcomes)
const MARKET_COOLDOWN = 6 * 60 * 60 * 1000;  // 6h cooldown per market before re-alerting
const FLIP_THRESHOLD = 0.50;         // Only alert if outcome crosses 50¢ line (yes→no or no→yes)

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { markets: {}, lastScan: null, scanCount: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadAlerts() {
  try {
    return JSON.parse(fs.readFileSync(ALERTS_PATH, 'utf8'));
  } catch {
    return { alerts: [], lastAlert: null, cooldowns: {} };
  }
}

function saveAlerts(alerts) {
  fs.writeFileSync(ALERTS_PATH, JSON.stringify(alerts, null, 2));
}

async function fetchMarkets() {
  try {
    const resp = await fetch('https://gamma-api.polymarket.com/events?closed=false&limit=200&order=liquidityClob&ascending=false');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) {
    console.error('Failed to fetch Polymarket events:', e.message);
    return [];
  }
}

function categorizeEvent(event) {
  const tags = (event.tags || []).map(t => t.label.toLowerCase()).join(' ');
  const title = event.title.toLowerCase();
  const searchText = title + ' ' + tags;
  
  for (const [cat, config] of Object.entries(TRACKED_CATEGORIES)) {
    const hasKeyword = config.keywords.some(kw => searchText.includes(kw));
    const hasTitleWord = !config.titleMust || config.titleMust.some(tw => title.includes(tw));
    
    if (hasKeyword && hasTitleWord) return cat;
  }
  return null;
}

function parseOutcomePrices(market) {
  try {
    const outcomes = JSON.parse(market.outcomes || '[]');
    const prices = JSON.parse(market.outcomePrices || '[]');
    const result = {};
    for (let i = 0; i < outcomes.length; i++) {
      result[outcomes[i]] = parseFloat(prices[i]) || 0;
    }
    return result;
  } catch {
    return {};
  }
}

function detectShifts(currentMarkets, state) {
  const alerts = [];
  const now = Date.now();
  
  for (const [marketId, current] of Object.entries(currentMarkets)) {
    const prev = state.markets[marketId];
    if (!prev) continue;
    
    // Check each outcome for price shifts
    for (const [outcome, price] of Object.entries(current.prices)) {
      const prevPrice = prev.prices?.[outcome];
      if (prevPrice === undefined) continue;
      
      const shift = price - prevPrice;
      const absShift = Math.abs(shift);
      
      // Fast shift (since last scan)
      if (absShift >= SHIFT_THRESHOLD_FAST && current.liquidity >= MIN_LIQUIDITY_ALERT) {
        alerts.push({
          type: 'ODDS_SHIFT',
          severity: absShift >= 0.20 ? 'HIGH' : 'MEDIUM',
          market: current.title,
          marketId,
          category: current.category,
          outcome,
          prevPrice: Math.round(prevPrice * 100),
          currentPrice: Math.round(price * 100),
          shift: Math.round(shift * 100),
          liquidity: current.liquidity,
          timestamp: new Date().toISOString(),
          message: `${current.title}\n"${outcome}" moved ${shift > 0 ? '+' : ''}${Math.round(shift * 100)}% (${Math.round(prevPrice * 100)}¢ → ${Math.round(price * 100)}¢)\nLiquidity: $${Math.round(current.liquidity / 1000)}k`
        });
      }
    }
    
    // Check 1-hour history for slow drift
    if (prev.history && prev.history.length > 0) {
      const oneHourAgo = now - (60 * 60 * 1000);
      const oldSnapshot = prev.history.find(h => h.time <= oneHourAgo);
      if (oldSnapshot) {
        for (const [outcome, price] of Object.entries(current.prices)) {
          const oldPrice = oldSnapshot.prices?.[outcome];
          if (oldPrice === undefined) continue;
          
          const drift = price - oldPrice;
          if (Math.abs(drift) >= SHIFT_THRESHOLD_SLOW && current.liquidity >= MIN_LIQUIDITY_ALERT) {
            // Avoid duplicate if fast shift already caught it
            if (!alerts.find(a => a.marketId === marketId && a.outcome === outcome)) {
              alerts.push({
                type: 'SLOW_DRIFT',
                severity: 'MEDIUM',
                market: current.title,
                marketId,
                category: current.category,
                outcome,
                oldPrice: Math.round(oldPrice * 100),
                currentPrice: Math.round(price * 100),
                drift: Math.round(drift * 100),
                period: '1 hour',
                liquidity: current.liquidity,
                timestamp: new Date().toISOString(),
                message: `${current.title}\n"${outcome}" drifted ${drift > 0 ? '+' : ''}${Math.round(drift * 100)}% over 1hr (${Math.round(oldPrice * 100)}¢ → ${Math.round(price * 100)}¢)\nLiquidity: $${Math.round(current.liquidity / 1000)}k`
              });
            }
          }
        }
      }
    }
  }
  
  // Filter 1: only alert if there's 25%+ upside
  // Filter 2: only alert if outcome FLIPPED (crossed 50¢ line) — not incremental moves
  const filtered = alerts.filter(a => {
    const price = (a.currentPrice || 0) / 100;
    const cheapSide = Math.min(price, 1 - price);
    if (cheapSide < MIN_UPSIDE) {
      console.log(`  Filtered: ${a.market} "${a.outcome}" at ${a.currentPrice}¢ — not enough upside`);
      return false;
    }
    
    // Must cross the 50¢ line (flip from yes to no or vice versa)
    const prev = (a.prevPrice || a.oldPrice || 0) / 100;
    const crossed50 = (prev >= FLIP_THRESHOLD && price < FLIP_THRESHOLD) || 
                       (prev < FLIP_THRESHOLD && price >= FLIP_THRESHOLD);
    if (!crossed50) {
      console.log(`  Filtered: ${a.market} "${a.outcome}" ${Math.round(prev*100)}¢→${Math.round(price*100)}¢ — no flip (both same side of 50¢)`);
      return false;
    }
    
    return true;
  });
  
  return filtered;
}

async function scan() {
  console.log('🔍 Scanning Polymarket...\n');
  
  const state = loadState();
  const alertsData = loadAlerts();
  const events = await fetchMarkets();
  
  if (!events.length) {
    console.log('No events fetched');
    return;
  }
  
  const currentMarkets = {};
  const categoryCounts = {};
  
  for (const event of events) {
    const category = categorizeEvent(event);
    if (!category) continue;
    
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    
    const markets = event.markets || [];
    for (const market of markets) {
      if (market.closed) continue;
      
      const prices = parseOutcomePrices(market);
      if (Object.keys(prices).length === 0) continue;
      
      const liquidity = parseFloat(market.liquidityClob || market.volume || 0);
      
      currentMarkets[market.id] = {
        title: event.title,
        question: market.question,
        category,
        prices,
        liquidity,
        volume: parseFloat(market.volume || 0),
        endDate: market.endDate,
        slug: event.slug
      };
    }
  }
  
  // Detect shifts
  const newAlerts = detectShifts(currentMarkets, state);
  
  // Update state with history
  const now = Date.now();
  for (const [id, market] of Object.entries(currentMarkets)) {
    const prev = state.markets[id];
    const history = prev?.history || [];
    
    // Keep 6 hours of history (one snapshot per scan)
    history.push({ time: now, prices: { ...market.prices } });
    const sixHoursAgo = now - (6 * 60 * 60 * 1000);
    const trimmed = history.filter(h => h.time >= sixHoursAgo);
    
    state.markets[id] = {
      ...market,
      history: trimmed.slice(-24), // max 24 snapshots
      firstSeen: prev?.firstSeen || now
    };
  }
  
  // Clean up closed/removed markets
  for (const id of Object.keys(state.markets)) {
    if (!currentMarkets[id]) {
      delete state.markets[id];
    }
  }
  
  state.lastScan = new Date().toISOString();
  state.scanCount = (state.scanCount || 0) + 1;
  saveState(state);
  
  // Apply per-market cooldown
  if (!state.cooldowns) state.cooldowns = {};
  const cooldownFiltered = newAlerts.filter(a => {
    const lastAlerted = state.cooldowns[a.marketId] || 0;
    if ((now - lastAlerted) < MARKET_COOLDOWN) {
      console.log(`  Cooldown: ${a.market} — alerted ${Math.round((now - lastAlerted) / 60000)}min ago, need ${MARKET_COOLDOWN / 3600000}h`);
      return false;
    }
    return true;
  });
  
  // Mark cooldowns for alerts that pass
  for (const a of cooldownFiltered) {
    state.cooldowns[a.marketId] = now;
  }
  // Clean old cooldowns
  for (const [id, time] of Object.entries(state.cooldowns)) {
    if (now - time > MARKET_COOLDOWN * 2) delete state.cooldowns[id];
  }
  
  // Save alerts
  if (cooldownFiltered.length > 0) {
    alertsData.alerts.unshift(...cooldownFiltered);
    alertsData.alerts = alertsData.alerts.slice(0, 100);
    alertsData.lastAlert = new Date().toISOString();
    saveAlerts(alertsData);
  }
  
  // Replace newAlerts with filtered version for output
  newAlerts.length = 0;
  newAlerts.push(...cooldownFiltered);
  
  // Output summary
  const trackedCount = Object.keys(currentMarkets).length;
  console.log(`📊 Tracking ${trackedCount} markets across ${Object.keys(categoryCounts).length} categories`);
  for (const [cat, count] of Object.entries(categoryCounts)) {
    console.log(`  ${cat}: ${count} events`);
  }
  
  if (newAlerts.length > 0) {
    console.log(`\n🚨 ${newAlerts.length} NEW ALERTS:`);
    for (const alert of newAlerts) {
      console.log(`\n[${alert.severity}] ${alert.type}`);
      console.log(alert.message);
    }
  } else {
    console.log('\n✅ No significant shifts detected');
  }
  
  // Save latest snapshot for briefing use
  const snapshot = {
    generated: new Date().toISOString(),
    marketCount: trackedCount,
    categories: categoryCounts,
    alerts: newAlerts,
    topMarkets: Object.entries(currentMarkets)
      .sort((a, b) => b[1].liquidity - a[1].liquidity)
      .slice(0, 30)
      .map(([id, m]) => ({
        id,
        title: m.title,
        question: m.question,
        category: m.category,
        prices: m.prices,
        liquidity: Math.round(m.liquidity),
        endDate: m.endDate
      }))
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot, null, 2));
  
  return { alerts: newAlerts, tracked: trackedCount };
}

function showMarkets() {
  const state = loadState();
  const markets = Object.entries(state.markets)
    .sort((a, b) => b[1].liquidity - a[1].liquidity);
  
  const byCategory = {};
  for (const [id, m] of markets) {
    if (!byCategory[m.category]) byCategory[m.category] = [];
    byCategory[m.category].push(m);
  }
  
  for (const [cat, ms] of Object.entries(byCategory)) {
    console.log(`\n=== ${cat.toUpperCase()} (${ms.length} markets) ===`);
    for (const m of ms.slice(0, 10)) {
      const priceStr = Object.entries(m.prices)
        .map(([k, v]) => `${k}: ${Math.round(v * 100)}¢`)
        .join(' | ');
      console.log(`  ${m.title} | $${Math.round(m.liquidity / 1000)}k liq`);
      console.log(`    ${priceStr}`);
    }
  }
}

function showAlerts() {
  const alertsData = loadAlerts();
  if (alertsData.alerts.length === 0) {
    console.log('No alerts yet. Run a scan first.');
    return;
  }
  
  console.log(`📋 Last ${Math.min(20, alertsData.alerts.length)} alerts:\n`);
  for (const alert of alertsData.alerts.slice(0, 20)) {
    console.log(`[${alert.severity}] ${alert.type} — ${alert.timestamp}`);
    console.log(alert.message);
    console.log('');
  }
}

// Main
const cmd = process.argv[2] || 'scan';

switch (cmd) {
  case 'scan':
    scan().catch(console.error);
    break;
  case 'markets':
    showMarkets();
    break;
  case 'alerts':
    showAlerts();
    break;
  default:
    console.log('Usage: node polymarket-tracker.js [scan|markets|alerts]');
}
