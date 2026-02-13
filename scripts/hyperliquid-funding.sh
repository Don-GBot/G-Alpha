#!/bin/bash
# Hyperliquid Perps: Funding Rates + OI + Volume
# Public API, no key needed
# Output: JSON array sorted by abs(funding), filtered by OI threshold

OI_MIN_USD=${1:-1000000}  # Min OI in USD (default $1M)

curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type": "metaAndAssetCtxs"}' | python3 -c "
import json, sys

OI_MIN = float(sys.argv[1]) if len(sys.argv) > 1 else 1000000

data = json.load(sys.stdin)
universe = data[0]['universe']
ctxs = data[1]

results = []
for u, c in zip(universe, ctxs):
    mark = float(c['markPx'])
    oi = float(c['openInterest'])
    oi_usd = oi * mark
    funding = float(c['funding'])
    funding_pct = funding * 100
    funding_ann = funding * 3 * 365 * 100
    vol24h = float(c['dayNtlVlm'])
    
    if oi_usd < OI_MIN:
        continue
    
    results.append({
        'coin': u['name'],
        'exchange': 'hyperliquid',
        'fundingRate': round(funding_pct, 6),
        'fundingAnnualized': round(funding_ann, 2),
        'openInterestUsd': round(oi_usd, 2),
        'markPrice': round(mark, 4),
        'volume24h': round(vol24h, 2),
        'maxLeverage': u.get('maxLeverage', 0),
        'isExtreme': abs(funding_pct) >= 0.06,
        'isNoteworthy': abs(funding_pct) >= 0.03,
        'direction': 'shorts_crowded' if funding < 0 else 'longs_crowded' if funding > 0 else 'neutral'
    })

results.sort(key=lambda x: abs(x['fundingRate']), reverse=True)
print(json.dumps(results, indent=2))
" "$OI_MIN_USD"
