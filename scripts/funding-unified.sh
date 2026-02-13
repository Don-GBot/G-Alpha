#!/bin/bash
# Unified Funding Rates: CEX (OKX/Bitget/Gate) + Hyperliquid
# Runs both sources, merges into data/funding-unified-latest.json

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="/home/ubuntu/clawd/data"

echo "📊 Fetching Hyperliquid funding rates..."
HL_DATA=$("$SCRIPT_DIR/hyperliquid-funding.sh" 1000000 2>/dev/null)

echo "📊 Fetching CEX funding rates..."
node "$SCRIPT_DIR/funding-rates.js" 2>/dev/null

echo "📊 Merging data..."
python3 -c "
import json, sys
from datetime import datetime

# Load CEX data
try:
    with open('$DATA_DIR/funding-rates-latest.json') as f:
        cex = json.load(f)
    cex_coins = cex.get('coins', [])
except:
    cex_coins = []

# Load Hyperliquid data
try:
    hl_coins = json.loads('''$HL_DATA''')
except:
    hl_coins = []

# Build unified view: for each coin, show all exchange data
unified = {}

# Add CEX data
for c in cex_coins:
    coin = c['coin']
    unified[coin] = {
        'coin': coin,
        'cex': {
            'avgRate': round(c.get('avgRate', 0) * 100, 4),  # convert to %
            'exchanges': c.get('exchanges', []),
            'oiUsd': c.get('oiUsd'),
        },
        'hyperliquid': None,
        'bestFunding': round(c.get('avgRate', 0) * 100, 4),
        'totalOiUsd': c.get('oiUsd') or 0,
    }

# Add/merge Hyperliquid data
for h in hl_coins:
    coin = h['coin']
    if coin in unified:
        unified[coin]['hyperliquid'] = {
            'fundingRate': h['fundingRate'],
            'oiUsd': h['openInterestUsd'],
            'volume24h': h['volume24h'],
        }
        hl_oi = h['openInterestUsd'] or 0
        unified[coin]['totalOiUsd'] = (unified[coin]['totalOiUsd'] or 0) + hl_oi
        # Use most extreme rate
        cex_rate = abs(unified[coin]['cex']['avgRate'])
        hl_rate = abs(h['fundingRate'])
        if hl_rate > cex_rate:
            unified[coin]['bestFunding'] = h['fundingRate']
    else:
        unified[coin] = {
            'coin': coin,
            'cex': None,
            'hyperliquid': {
                'fundingRate': h['fundingRate'],
                'oiUsd': h['openInterestUsd'],
                'volume24h': h['volume24h'],
            },
            'bestFunding': h['fundingRate'],
            'totalOiUsd': h['openInterestUsd'] or 0,
        }

# Sort by abs(bestFunding)
coins_list = sorted(unified.values(), key=lambda x: abs(x['bestFunding']), reverse=True)

# Add flags
for c in coins_list:
    rate = abs(c['bestFunding'])
    oi = c['totalOiUsd'] or 0
    c['isExtreme'] = rate >= 0.06 and oi > 1000000
    c['isNoteworthy'] = rate >= 0.03 and oi > 1000000
    c['isBriefingWorthy'] = rate >= 0.06 and oi > 1000000
    c['direction'] = 'shorts_crowded' if c['bestFunding'] < 0 else 'longs_crowded' if c['bestFunding'] > 0 else 'neutral'

result = {
    'timestamp': datetime.utcnow().isoformat() + 'Z',
    'sources': ['okx', 'bitget', 'gate', 'hyperliquid'],
    'totalCoins': len(coins_list),
    'extremeCount': sum(1 for c in coins_list if c['isExtreme']),
    'coins': coins_list,
}

with open('$DATA_DIR/funding-unified-latest.json', 'w') as f:
    json.dump(result, f, indent=2)

# Print summary
extreme = [c for c in coins_list if c['isExtreme']]
print(f'\\n✅ Unified: {len(coins_list)} coins ({len(cex_coins)} CEX, {len(hl_coins)} Hyperliquid)')
print(f'   Extreme (≥0.06% + >\$1M OI): {len(extreme)}')
if extreme:
    print('\\n🔥 Extreme funding:')
    for c in extreme[:10]:
        src = []
        if c['cex']: src.append(f\"CEX {c['cex']['avgRate']:+.4f}%\")
        if c['hyperliquid']: src.append(f\"HL {c['hyperliquid']['fundingRate']:+.4f}%\")
        print(f\"   {c['coin']:>8} | {c['bestFunding']:+.4f}% | OI \${c['totalOiUsd']/1e6:.1f}M | {' / '.join(src)}\")
print('\\n🎯 Done!')
"
