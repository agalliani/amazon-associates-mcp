/**
 * setup.mjs — One-time interactive login for Amazon Associates
 *
 * Supports multiple marketplaces via --marketplace flag.
 *
 * Usage:
 *   node setup.mjs                     # login for default marketplace (env AMAZON_MARKETPLACE or 'it')
 *   node setup.mjs --marketplace com   # login for amazon.com
 *   node setup.mjs --marketplace de    # login for amazon.de
 *   node setup.mjs --all               # login for all marketplaces in AMAZON_MARKETPLACES env var
 *
 * After setup, the MCP server runs fully headlessly.
 * Re-run only if your session expires (typically after several months).
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveSession, getBaseUrl, isLoginPage, DEFAULT_MARKETPLACE } from './auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// ── Parse args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const marketplaceFlag = args[args.indexOf('--marketplace') + 1];
const allFlag = args.includes('--all');

let marketplaces;

if (allFlag) {
  const configured = process.env.AMAZON_MARKETPLACES;
  if (!configured) {
    console.error('❌  --all requires AMAZON_MARKETPLACES=it,com,de,fr,es in your .env');
    process.exit(1);
  }
  marketplaces = configured.split(',').map(m => m.trim()).filter(Boolean);
} else {
  marketplaces = [marketplaceFlag ?? DEFAULT_MARKETPLACE];
}

// ── Setup function ─────────────────────────────────────────────────────────

async function setupMarketplace(marketplace) {
  const baseUrl = getBaseUrl(marketplace);

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Amazon Associates MCP — Setup [${marketplace.toUpperCase()}]`);
  console.log(`  ${baseUrl}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('1. A browser window will open');
  console.log('2. Log in to Amazon Associates');
  console.log('   (email, password, 2FA if required)');
  console.log('3. Once on the dashboard, the session is saved');
  console.log('   automatically and the browser closes.');
  console.log('');
  console.log('Opening browser...');
  console.log('');

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({
    viewport: null,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const POLL_INTERVAL_MS = 2_000;
  const MAX_WAIT_MS = 5 * 60_000;
  const start = Date.now();
  let success = false;

  console.log(`Waiting for login on amazon.${marketplace}...`);

  while (Date.now() - start < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    if (page.isClosed()) {
      console.error(`\n❌  Browser closed before login. Run: node setup.mjs --marketplace ${marketplace}`);
      await browser.close();
      return false;
    }

    const url = page.url();
    if (!isLoginPage(url) && url.includes('affiliate-program.amazon')) {
      success = true;
      break;
    }
  }

  if (!success) {
    console.error(`\n❌  Timeout for ${marketplace}. Re-run: node setup.mjs --marketplace ${marketplace}`);
    await browser.close();
    return false;
  }

  await saveSession(context, marketplace);
  await browser.close();
  console.log(`✅  [${marketplace.toUpperCase()}] Session saved.`);
  return true;
}

// ── Run ────────────────────────────────────────────────────────────────────

console.log(`\nSetting up ${marketplaces.length} marketplace(s): ${marketplaces.join(', ')}\n`);

for (const marketplace of marketplaces) {
  const ok = await setupMarketplace(marketplace);
  if (!ok && marketplaces.length > 1) {
    console.log(`⏭️  Skipping remaining marketplaces due to error.`);
    break;
  }
}

console.log('');
console.log('Done! The MCP server now runs fully automatically.');
console.log('');
