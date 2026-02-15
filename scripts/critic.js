require("./env");
#!/usr/bin/env node
// Critic — task-aware content validation with specialized rubrics
// Usage: node critic.js <file> [task-type] [brief]
// Task types: content, code, research, general (auto-detects if omitted)
// Exit 0 = pass, Exit 1 = fail

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const taskType = process.argv[3] || 'auto';
const brief = process.argv[4] || '';

if (!file || !fs.existsSync(file)) {
  console.error('Usage: node critic.js <file> [content|code|research|general] [brief]');
  process.exit(2);
}

const content = fs.readFileSync(file, 'utf8');
const lines = content.trim().split('\n');
const issues = [];

// Auto-detect task type
function detectType() {
  if (taskType !== 'auto') return taskType;
  const ext = path.extname(file);
  if (['.js', '.py', '.sh', '.ts'].includes(ext)) return 'code';
  if (content.includes('ALPHA') || content.includes('RECAP') || content.includes('briefing')) return 'content';
  if (content.includes('Source:') || content.includes('according to') || content.includes('research')) return 'research';
  return 'general';
}

const type = detectType();

// ═══ SHARED CHECKS (all types) ═══
function sharedChecks() {
  if (/great question|happy to help|absolutely!|that's a great point|I'd be happy/i.test(content)) {
    issues.push('SLOP: Contains sycophantic AI phrases');
  }
  // Identity leak — G should never reveal internal system details
  if (/AGENTS\.md|SOUL\.md|LIVE\.md|openclaw\.json|sk-ant-/i.test(content) && type === 'content') {
    issues.push('IDENTITY LEAK: References internal config files in public content');
  }
}

// ═══ CONTENT RUBRIC (briefings, recaps, tweets, channel posts) ═══
function contentChecks() {
  // Length
  if (lines.length > 30) issues.push(`TOO LONG: ${lines.length} lines (max 30 for channel posts)`);
  if (lines.length < 3) issues.push(`TOO SHORT: ${lines.length} lines (min 3)`);

  // Telegram formatting
  if (content.includes('```')) issues.push('CODE BLOCKS: Not allowed in Telegram posts');
  if (content.includes('✅')) issues.push('GREEN CHECKMARKS: Banned');
  if (/\|.*\|.*\|/.test(content) && content.includes('---')) issues.push('TABLES: Not allowed in Telegram');

  // AI filler words
  const fillers = content.match(/\b(however|furthermore|additionally|moreover|nevertheless|consequently|subsequently|utilizing|leverage|delve|tapestry|multifaceted|comprehensive|robust)\b/gi);
  if (fillers && fillers.length > 2) {
    issues.push(`AI WORDS: ${fillers.length} filler words (${[...new Set(fillers.map(f => f.toLowerCase()))].join(', ')})`);
  }

  // Funding rate threshold
  const fundingContext = content.match(/[\d.]+%.*?funding|funding.*?[\d.]+%/gi);
  if (fundingContext) {
    const rates = content.match(/([\d.]+)%/g);
    if (rates) {
      for (const r of rates) {
        const val = parseFloat(r);
        if (val > 0 && val < 0.6 && val !== 0) {
          issues.push(`LOW FUNDING: ${r} below 0.6% threshold — should not be in output`);
          break;
        }
      }
    }
  }

  // CT namedropping
  const mentions = content.match(/@\w+/g);
  if (mentions) {
    const allowed = ['@GsDailyAlpha', '@ClawdG9699', '@DaDefiDon'];
    const bad = mentions.filter(m => !allowed.includes(m));
    if (bad.length > 0) issues.push(`NAMEDROP: ${bad.join(', ')} — don't namedrop CT accounts in public content`);
  }

  // Tone — too many exclamation marks = hype
  const exclamations = (content.match(/!/g) || []).length;
  if (exclamations > 3) issues.push(`HYPE: ${exclamations} exclamation marks — tone it down`);

  // Stale references
  if (/\byesterday\b/i.test(content) && brief.includes('briefing')) {
    issues.push('STALE: References "yesterday" in a morning briefing');
  }

  // Repetition — same word 5+ times (excluding common words)
  const words = content.toLowerCase().match(/\b[a-z]{5,}\b/g) || [];
  const freq = {};
  words.forEach(w => freq[w] = (freq[w] || 0) + 1);
  const repeated = Object.entries(freq).filter(([w, c]) => c >= 5 && !['bitcoin', 'funding', 'market', 'crypto'].includes(w));
  if (repeated.length > 0) {
    issues.push(`REPETITIVE: ${repeated.map(([w, c]) => `"${w}" x${c}`).join(', ')}`);
  }
}

// ═══ CODE RUBRIC (scripts, tools) ═══
function codeChecks() {
  // Error handling
  if (!content.includes('catch') && !content.includes('try') && content.length > 500) {
    issues.push('NO ERROR HANDLING: No try/catch in 500+ char script');
  }

  // Hardcoded secrets
  if (/['"][A-Za-z0-9]{30,}['"]/.test(content) && !/test|example|sample/i.test(file)) {
    // Check if it looks like an actual secret vs a hash/id
    if (/api.key|token|secret|password/i.test(content)) {
      issues.push('HARDCODED SECRET: Possible API key or token in code');
    }
  }

  // Console.log spam
  const logs = (content.match(/console\.log/g) || []).length;
  if (logs > 10) issues.push(`LOG SPAM: ${logs} console.log calls — clean up before shipping`);

  // No shebang
  if (content.startsWith('#!') === false && path.extname(file) === '.js') {
    // Not critical but note it
  }

  // Syntax check for JS
  if (path.extname(file) === '.js') {
    try {
      new Function(content);
    } catch (e) {
      // Module syntax won't parse in Function constructor, skip those
      if (!e.message.includes('import') && !e.message.includes('export') && !e.message.includes('await')) {
        issues.push(`SYNTAX ERROR: ${e.message}`);
      }
    }
  }

  // TODO/FIXME/HACK
  const todos = content.match(/\b(TODO|FIXME|HACK|XXX)\b/g);
  if (todos && todos.length > 0) {
    issues.push(`UNFINISHED: ${todos.length} TODO/FIXME markers found`);
  }

  // Exit code handling
  if (content.includes('process.exit') && !content.includes('process.exit(0)') && !content.includes('process.exit(1)')) {
    issues.push('EXIT CODES: Non-standard exit codes — use 0 (success) or 1 (failure)');
  }
}

// ═══ RESEARCH RUBRIC (analysis, DD, reports) ═══
function researchChecks() {
  // Vague claims without evidence
  const vaguePatterns = /\b(many people|some experts|it is believed|arguably|it's worth noting|interestingly)\b/gi;
  const vague = content.match(vaguePatterns);
  if (vague && vague.length > 2) {
    issues.push(`VAGUE CLAIMS: ${vague.length} unsourced assertions (${[...new Set(vague.map(v => v.toLowerCase()))].join(', ')})`);
  }

  // No data/numbers in a research piece
  const numbers = content.match(/\$[\d,.]+|\d+%|\d+[KMB]\b/g);
  if (!numbers || numbers.length < 2) {
    issues.push('NO DATA: Research piece has fewer than 2 data points — needs evidence');
  }

  // Excessive hedging
  const hedges = content.match(/\b(might|could|perhaps|possibly|potentially|may|seems)\b/gi);
  if (hedges && hedges.length > 5) {
    issues.push(`OVER-HEDGING: ${hedges.length} hedging words — take a position`);
  }

  // Length check for research (should be substantive)
  if (content.length < 500) {
    issues.push('TOO THIN: Research piece under 500 chars — needs more depth');
  }
}

// ═══ GENERAL RUBRIC (fallback) ═══
function generalChecks() {
  contentChecks(); // General gets content checks as baseline
}

// Run checks
sharedChecks();
switch (type) {
  case 'content': contentChecks(); break;
  case 'code': codeChecks(); break;
  case 'research': researchChecks(); break;
  default: generalChecks();
}

// Output
if (issues.length === 0) {
  console.log(`PASS [${type}] — content looks good`);
  process.exit(0);
} else {
  console.log(`FAIL [${type}] — ${issues.length} issue(s):\n`);
  issues.forEach(i => console.log(`  - ${i}`));
  process.exit(1);
}
