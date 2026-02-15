require("./env");
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(process.env.HOME, '.openclaw', 'agents');
const ARCHIVE_DIR = path.join(process.env.HOME, '.openclaw', 'archived-sessions');
const WARN_BYTES = 5 * 1024 * 1024;  // 5MB
const ALERT_BYTES = 5 * 1024 * 1024; // 5MB
const STALE_DAYS = 3;

const issues = [];
const stats = { total: 0, archived: 0, warned: 0, alerted: 0 };

// Ensure archive dir
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

try {
  const agents = fs.readdirSync(AGENTS_DIR);
  for (const agent of agents) {
    const sessDir = path.join(AGENTS_DIR, agent, 'sessions');
    if (!fs.existsSync(sessDir)) continue;
    
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const full = path.join(sessDir, f);
      const stat = fs.statSync(full);
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      const ageDays = (Date.now() - stat.mtimeMs) / 86400000;
      stats.total++;

      // Archive: stale (>7 days) AND over 1MB
      if (ageDays > STALE_DAYS && stat.size > 1024 * 1024) {
        const dest = path.join(ARCHIVE_DIR, `${agent}_${f}`);
        fs.renameSync(full, dest);
        stats.archived++;
        continue;
      }

      // Alert on big active sessions
      if (stat.size >= ALERT_BYTES) {
        issues.push(`🔴 ${agent}/${f} — ${sizeMB}MB (LARGE)`);
        stats.alerted++;
      } else if (stat.size >= WARN_BYTES) {
        issues.push(`🟡 ${agent}/${f} — ${sizeMB}MB`);
        stats.warned++;
      }
    }
  }
} catch (e) {
  issues.push(`ERROR: ${e.message}`);
}

console.log(`Sessions: ${stats.total} total, ${stats.archived} archived, ${stats.warned} warnings, ${stats.alerted} alerts`);
if (issues.length > 0) {
  console.log('\nActive large sessions:');
  issues.forEach(i => console.log(`  ${i}`));
}
if (stats.archived > 0) {
  console.log(`\nArchived ${stats.archived} stale sessions to ${ARCHIVE_DIR}`);
}
