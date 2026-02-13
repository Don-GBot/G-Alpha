#!/usr/bin/env node
/**
 * Reddit Scanner — fetches top posts from crypto subreddits via RSS
 * No auth needed. Outputs JSON for briefing integration.
 * 
 * Usage: node reddit-scanner.js [--period day|week] [--limit 10]
 */

const { parseArgs } = require('util');
const { writeFileSync } = require('fs');

const SUBREDDITS = [
  'cryptocurrency',
  'solana', 
  'defi',
  'ethfinance',
  'bitcoinmarkets',
  'CryptoMarkets',
  'altcoin'
];

const OUTPUT_PATH = '/home/ubuntu/clawd/data/reddit-digest-latest.json';

async function fetchSubreddit(sub, period = 'day', limit = 10) {
  const url = `https://www.reddit.com/r/${sub}/top/.rss?t=${period}&limit=${limit}`;
  
  try {
    const { execSync } = require('child_process');
    const xml = execSync(
      `curl -s -L -H "User-Agent: G-ResearchBot/1.0 (by /u/gbot)" "${url}"`,
      { timeout: 15000, encoding: 'utf8' }
    );
    
    if (!xml || xml.includes('<title>Blocked</title>') || xml.includes('403')) {
      console.error(`[${sub}] Blocked`);
      return [];
    }
    const posts = [];
    
    // Simple XML parsing — extract entries
    const entries = xml.split('<entry>').slice(1);
    
    for (const entry of entries) {
      const title = extractTag(entry, 'title');
      const link = extractAttr(entry, 'link', 'href');
      const author = extractTag(entry, 'name');
      const updated = extractTag(entry, 'updated');
      const content = extractTag(entry, 'content');
      
      // Extract score from content if available
      const scoreMatch = content?.match(/(\d+)\s*(?:points?|upvotes?)/i);
      const commentMatch = content?.match(/(\d+)\s*comments?/i);
      
      if (title) {
        posts.push({
          subreddit: sub,
          title: decodeHTML(title),
          url: link || `https://reddit.com/r/${sub}`,
          author: author || 'unknown',
          updated: updated || null,
          score: scoreMatch ? parseInt(scoreMatch[1]) : null,
          comments: commentMatch ? parseInt(commentMatch[1]) : null
        });
      }
    }
    
    return posts;
  } catch (err) {
    console.error(`[${sub}] Error: ${err.message}`);
    return [];
  }
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : null;
}

function extractAttr(xml, tag, attr) {
  // Get the LAST link with rel="alternate" (the actual post link, not the sub link)
  const links = [...xml.matchAll(/<link\s+[^>]*href="([^"]*)"[^>]*>/g)];
  for (const link of links) {
    if (link[1].includes('/comments/')) return link[1];
  }
  // Fallback to first alternate
  const match = xml.match(new RegExp(`<${tag}[^>]*rel="alternate"[^>]*${attr}="([^"]*)"`, 'i'));
  return match ? match[1] : null;
}

function decodeHTML(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function filterSpam(posts) {
  const spamPatterns = [
    /airdrop/i,
    /free\s*(crypto|token|coin)/i,
    /join\s*(my|our)\s*(telegram|discord)/i,
    /guaranteed\s*profit/i,
    /send\s*\d+.*get\s*\d+/i,
  ];
  
  return posts.filter(p => !spamPatterns.some(re => re.test(p.title)));
}

async function main() {
  const { values } = parseArgs({
    options: {
      period: { type: 'string', default: 'day' },
      limit: { type: 'string', default: '10' },
    }
  });

  const period = values.period;
  const limit = parseInt(values.limit);
  
  console.log(`Scanning ${SUBREDDITS.length} subreddits (top/${period}, limit ${limit})...`);
  
  const allPosts = [];
  
  for (const sub of SUBREDDITS) {
    // Stagger requests to avoid rate limiting
    await new Promise(r => setTimeout(r, 1000));
    const posts = await fetchSubreddit(sub, period, limit);
    allPosts.push(...posts);
    console.log(`  r/${sub}: ${posts.length} posts`);
  }
  
  const filtered = filterSpam(allPosts);
  
  const output = {
    generated: new Date().toISOString(),
    period,
    totalPosts: filtered.length,
    subreddits: SUBREDDITS.length,
    posts: filtered
  };
  
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${filtered.length} posts to ${OUTPUT_PATH}`);
  
  // Print summary for briefing use
  console.log('\n--- TOP POSTS ---');
  
  const bySubreddit = {};
  for (const p of filtered) {
    if (!bySubreddit[p.subreddit]) bySubreddit[p.subreddit] = [];
    bySubreddit[p.subreddit].push(p);
  }
  
  for (const [sub, posts] of Object.entries(bySubreddit)) {
    console.log(`\nr/${sub}:`);
    for (const p of posts.slice(0, 3)) {
      console.log(`  • ${p.title}`);
    }
  }
}

main().catch(console.error);
