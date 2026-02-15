require("./env");
#!/usr/bin/env node
/**
 * Briefing Validator — programmatic quality checks on briefing/recap text
 * Catches rule violations before sending to Telegram
 * 
 * Usage: echo "briefing text" | node scripts/briefing-validator.js
 *   or:  node scripts/briefing-validator.js "briefing text"
 *   or:  node scripts/briefing-validator.js --file path/to/text.txt
 * 
 * Exit code 0 = pass, 1 = violations found
 * Output: JSON with pass/fail and list of violations
 */

const fs = require('fs');

// ── Rules from tasks/lessons.md ──

const RULES = [
  {
    id: 'no-green-checkmarks',
    desc: 'No green checkmarks (✅) — Don hates them',
    check: (text) => text.includes('✅'),
    severity: 'critical'
  },
  {
    id: 'no-tables',
    desc: 'No tables in Telegram — render as ugly code blocks',
    check: (text) => /\|[-:]+\|/.test(text) || (text.split('|').length > 6 && /\|.*\|.*\|/.test(text)),
    severity: 'critical'
  },
  {
    id: 'no-code-blocks',
    desc: 'No code blocks/backticks in Telegram — Don hates green highlighted areas',
    check: (text) => text.includes('```'),
    severity: 'critical'
  },
  {
    id: 'no-sub-threshold-funding',
    desc: 'No funding rates below 0.6% — minimum display threshold',
    check: (text) => {
      // Find patterns like "0.23%" or "-0.32%" that are below 0.6
      const ratePattern = /[-]?\d+\.\d+%/g;
      let match;
      while ((match = ratePattern.exec(text)) !== null) {
        const rate = Math.abs(parseFloat(match[0]));
        // Skip if it looks like a price change (24h change context)
        const context = text.slice(Math.max(0, match.index - 30), match.index);
        if (context.includes('24h') || context.includes('change') || context.includes('$')) continue;
        // Check if it's in a funding rate context
        const afterContext = text.slice(match.index, match.index + 50);
        if ((afterContext.includes('funding') || afterContext.includes('OI') || 
             afterContext.includes('exchange') || context.includes('funding') ||
             context.includes('rate')) && rate < 0.6 && rate > 0) {
          return true;
        }
      }
      return false;
    },
    severity: 'critical'
  },
  {
    id: 'no-namedropping',
    desc: 'No namedropping CT accounts — attribute to crowd not individuals',
    check: (text) => {
      const ctNames = ['Cobie', 'Hsaka', 'Ansem', 'GCR', 'Pentoshi', 'inversebrah', 
        'CryptoKaleo', 'Murad', 'DefiIgnas', 'EmberCN', 'lookonchain', 'ColdBloodShill'];
      return ctNames.some(name => text.includes(name));
    },
    severity: 'warning'
  },
  {
    id: 'max-length',
    desc: 'Alerts must be 4-6 lines MAX, briefings should be concise',
    check: (text) => {
      const lines = text.trim().split('\n').filter(l => l.trim().length > 0);
      return lines.length > 40; // briefings can be longer than alerts
    },
    severity: 'warning'
  },
  {
    id: 'no-nothing-found',
    desc: 'If data source has no results, skip silently — don\'t say "no results found"',
    check: (text) => {
      const bad = ['no results found', 'nothing found', 'no data available', 'skipping this section',
        'no notable', 'nothing to report'];
      const lower = text.toLowerCase();
      return bad.some(p => lower.includes(p));
    },
    severity: 'warning'
  },
  {
    id: 'no-sycophancy',
    desc: 'No AI slop phrases',
    check: (text) => {
      const slop = ['it\'s worth noting', 'it bears mentioning', 'let\'s dive in', 'without further ado',
        'in the ever-evolving', 'game-changer', 'paradigm shift', 'at the end of the day',
        'buckle up', 'strap in', 'here\'s the thing', 'the bottom line is'];
      const lower = text.toLowerCase();
      return slop.some(p => lower.includes(p));
    },
    severity: 'warning'
  },
  {
    id: 'no-sleep-advice',
    desc: 'Never tell Don to get rest/sleep',
    check: (text) => {
      const lower = text.toLowerCase();
      return ['get some rest', 'get some sleep', 'go to bed', 'call it a night'].some(p => lower.includes(p));
    },
    severity: 'critical'
  },
  {
    id: 'no-polymarket',
    desc: 'No Polymarket content in briefings',
    check: (text) => text.toLowerCase().includes('polymarket'),
    severity: 'warning'
  },
  {
    id: 'no-whale-moves',
    desc: 'No whale moves section in briefings unless multi-KOL convergence',
    check: (text) => {
      const lower = text.toLowerCase();
      return lower.includes('whale move') || lower.includes('whale watch');
    },
    severity: 'warning'  
  },
  {
    id: 'no-onchain-runners',
    desc: 'No onchain runners/movers in public TG channel',
    check: (text) => {
      const lower = text.toLowerCase();
      return (lower.includes('runner') && lower.includes('onchain')) || 
             (lower.includes('mover') && lower.includes('onchain'));
    },
    severity: 'warning'
  },
  {
    id: 'has-dollar-encoding',
    desc: 'Dollar signs should survive Telegram (check for empty tickers)',
    check: (text) => {
      // Check for patterns like "  98,000" where $ was eaten
      return /\s{2}\d{2,3},\d{3}/.test(text);
    },
    severity: 'warning'
  }
];

// ── Main ──

function validate(text) {
  const violations = [];
  
  for (const rule of RULES) {
    if (rule.check(text)) {
      violations.push({
        id: rule.id,
        severity: rule.severity,
        desc: rule.desc
      });
    }
  }

  const criticals = violations.filter(v => v.severity === 'critical');
  const warnings = violations.filter(v => v.severity === 'warning');
  const passed = criticals.length === 0;

  return {
    passed,
    criticals: criticals.length,
    warnings: warnings.length,
    violations,
    summary: passed 
      ? `PASS (${warnings.length} warnings)` 
      : `FAIL — ${criticals.length} critical violations`
  };
}

// ── CLI ──

let input = '';

if (process.argv.includes('--file')) {
  const fileIdx = process.argv.indexOf('--file');
  const filePath = process.argv[fileIdx + 1];
  input = fs.readFileSync(filePath, 'utf8');
} else if (process.argv[2] && !process.argv[2].startsWith('-')) {
  input = process.argv[2];
} else {
  // Read from stdin
  input = fs.readFileSync('/dev/stdin', 'utf8');
}

if (!input.trim()) {
  console.error('No input provided');
  console.error('Usage: node briefing-validator.js "text" | --file path | pipe via stdin');
  process.exit(2);
}

const result = validate(input);
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
