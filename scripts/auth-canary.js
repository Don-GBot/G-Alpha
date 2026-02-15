require("./env");
#!/usr/bin/env node
const fs = require('fs');
const https = require('https');

const BOT_TOKEN = process.env.TG_BOT_TOKEN || require('./tg-token.js').getBotToken();
const DON_CHAT = '7620750194';
const JOBS_PATH = `${process.env.HOME}/.openclaw/cron/jobs.json`;

function alert(msg) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: DON_CHAT, text: msg });
    const req = https.request(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, resolve);
    req.write(body);
    req.end();
  });
}

async function main() {
  try {
    const data = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
    const jobs = data.jobs || [];
    const failing = jobs.filter(j => j.enabled && (j.state?.consecutiveErrors || 0) >= 3);
    
    if (failing.length === 0) {
      console.log('HEALTHY — all crons running clean');
      process.exit(0);
    } else {
      const names = failing.map(j => `${j.name} (${j.state.consecutiveErrors} errors)`).join(', ');
      const msg = `🔴 CRON CANARY: ${failing.length} job(s) failing — ${names}`;
      console.log(msg);
      await alert(msg);
      process.exit(1);
    }
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    await alert(`⚠️ CRON CANARY: Can't read jobs.json — ${e.message}`);
    process.exit(1);
  }
}

main();
