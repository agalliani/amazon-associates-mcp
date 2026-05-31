/**
 * setup.mjs — One-time interactive login for Amazon Associates
 *
 * Run this once to save a persistent session.
 * After this, the MCP server runs fully headlessly — no manual steps needed.
 * Re-run only if your session expires (typically after several months).
 *
 * Usage: node setup.mjs
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveSession, BASE_URL, isLoginPage } from './auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 5 * 60_000;  // 5 minutes

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Amazon Associates MCP — Session Setup');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('1. A browser window will open');
console.log('2. Log in to Amazon Associates');
console.log('   (email, password, 2FA if required)');
console.log('3. Once on the dashboard, cookies are saved');
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
  locale: 'it-IT',
});

const page = await context.newPage();
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

const start = Date.now();
let success = false;

console.log('Waiting for login...');

while (Date.now() - start < MAX_WAIT_MS) {
  await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

  if (page.isClosed()) {
    console.error('\n❌  Browser closed before login. Run setup.mjs again.');
    process.exit(1);
  }

  const url = page.url();
  if (!isLoginPage(url) && url.includes('affiliate-program.amazon')) {
    success = true;
    break;
  }
}

if (!success) {
  console.error('\n❌  Timeout: login not completed within 5 minutes.');
  await browser.close();
  process.exit(1);
}

await saveSession(context);
await browser.close();

console.log('');
console.log('✅  Login successful! Session saved.');
console.log('');
console.log('The MCP server will now run fully automatically.');
console.log('');
