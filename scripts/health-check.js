require("./env");
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const issues = [];
const dataDir = path.join(__dirname, '..', 'data');

// 1. Data freshness — check *-latest.json files
const now = Date.now();
const MAX_STALE_MS = 24 * 60 * 60 * 1000;
try {
  const SKIP_STALE = ['movers-latest.json']; // not wired into briefings yet
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('-latest.json') && !SKIP_STALE.includes(f));
  for (const f of files) {
    const stat = fs.statSync(path.join(dataDir, f));
    const ageMs = now - stat.mtimeMs;
    const ageH = (ageMs / 3600000).toFixed(1);
    if (ageMs > MAX_STALE_MS) {
      issues.push(`STALE DATA: ${f} — last updated ${ageH}h ago`);
    }
  }
} catch (e) {
  issues.push(`DATA CHECK ERROR: ${e.message}`);
}

// 2. Cron errors — read from gateway API via fetch
async function checkCrons() {
  try {
    // Read openclaw config to find gateway
    const configPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const port = config.gateway?.port || 18789;
    const token = config.gateway?.token || '';
    
    const resp = await fetch(`http://127.0.0.1:${port}/api/cron/list`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (resp.ok) {
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { issues.push('CRON CHECK: non-JSON response'); return; }
      const jobs = data.jobs || [];
      for (const job of jobs) {
        if (!job.enabled) continue;
        const errs = job.state?.consecutiveErrors || 0;
        if (errs >= 3) {
          issues.push(`CRON FAILING: ${job.name} — ${errs} consecutive errors`);
        }
        // Check if last run was >2x the expected interval
        const lastRun = job.state?.lastRunAtMs;
        if (lastRun && job.schedule?.expr) {
          const sinceLastH = (now - lastRun) / 3600000;
          if (sinceLastH > 24) {
            issues.push(`CRON STALE: ${job.name} — last ran ${sinceLastH.toFixed(1)}h ago`);
          }
        }
      }
    }
  } catch (e) {
    issues.push(`CRON CHECK ERROR: ${e.message}`);
  }
}

// 3. Disk usage
function checkDisk() {
  try {
    const { execSync } = require('child_process');
    const df = execSync('df -h / --output=pcent').toString().trim();
    const pct = parseInt(df.split('\n')[1]);
    if (pct > 80) {
      issues.push(`DISK USAGE: ${pct}% — getting full`);
    }
  } catch (e) {
    issues.push(`DISK CHECK ERROR: ${e.message}`);
  }
}

// 4. Session hygiene
function checkSessions() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('node scripts/session-hygiene.js', { cwd: __dirname + '/..', timeout: 10000 }).toString();
    // Extract alerts from output
    const lines = out.split('\n').filter(l => l.includes('🔴'));
    for (const l of lines) issues.push(`SESSION: ${l.trim()}`);
  } catch (e) {
    // session-hygiene might not exist yet
  }
}

async function main() {
  checkDisk();
  checkSessions();
  await checkCrons();
  
  if (issues.length === 0) {
    console.log('ALL CLEAR');
    process.exit(0);
  } else {
    console.log('ISSUES FOUND:');
    issues.forEach(i => console.log(`  - ${i}`));
    process.exit(1);
  }
}

main();
