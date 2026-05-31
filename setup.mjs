/**
 * setup.mjs — One-time interactive login for Amazon Associates
 *
 * What it does:
 *   1. Opens a visible browser → user logs in (any 2FA/CAPTCHA handled manually)
 *   2. Saves session cookies
 *   3. Navigates to the earnings report page
 *   4. Intercepts HTTP responses to discover API endpoints (if any)
 *   5. Saves discovered API info for use by the MCP server (faster, no browser needed)
 *
 * Usage:
 *   node setup.mjs                     # default marketplace (env AMAZON_MARKETPLACE or 'it')
 *   node setup.mjs --marketplace com   # amazon.com
 *   node setup.mjs --marketplace de    # amazon.de
 *   node setup.mjs --all               # all marketplaces in AMAZON_MARKETPLACES env var
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { saveSession, getBaseUrl, isLoginPage, DEFAULT_MARKETPLACE, getSessionPath } from './auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// ── Parse CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const marketplaceIdx = args.indexOf('--marketplace');
const marketplaceFlag = marketplaceIdx !== -1 ? args[marketplaceIdx + 1] : null;
const allFlag = args.includes('--all');

let marketplaces;
if (allFlag) {
  const configured = process.env.AMAZON_MARKETPLACES;
  if (!configured) {
    console.error('❌  --all requires AMAZON_MARKETPLACES=it,com,de in your .env');
    process.exit(1);
  }
  marketplaces = configured.split(',').map(m => m.trim()).filter(Boolean);
} else {
  marketplaces = [marketplaceFlag ?? DEFAULT_MARKETPLACE];
}

// ── API endpoint discovery ─────────────────────────────────────────────────

/**
 * Intercepts network responses while on the reports page.
 * Returns any JSON responses that look like earnings data.
 */
async function discoverApiEndpoints(page, marketplace) {
  const discovered = [];

  page.on('response', async (response) => {
    try {
      const url      = response.url();
      const status   = response.status();
      const ct       = response.headers()['content-type'] ?? '';

      if (status !== 200) return;
      if (!ct.includes('json') && !ct.includes('javascript')) return;
      // Exclude static assets, analytics, third-party
      if (!url.includes('amazon')) return;
      if (url.includes('static') || url.includes('sprite') || url.includes('analytics')) return;

      const body = await response.text();
      // Only keep responses that look like they contain earnings/click data
      if (
        body.includes('click') || body.includes('Click') ||
        body.includes('earning') || body.includes('Earning') ||
        body.includes('revenue') || body.includes('Revenue') ||
        body.includes('dispatch') || body.includes('Dispatch')
      ) {
        const headers = response.request().headers();
        discovered.push({
          url,
          method: response.request().method(),
          postData: response.request().postData(),
          requestHeaders: {
            'accept':       headers['accept'],
            'content-type': headers['content-type'],
            'x-csrf-token': headers['x-csrf-token'],
          },
          bodyPreview: body.slice(0, 500),
        });
        console.log(`  📡 API endpoint found: ${url.slice(0, 80)}`);
      }
    } catch { /* ignore parse errors */ }
  });

  return discovered;
}

/** Saves discovered API info to session/api-{marketplace}.json */
function saveApiInfo(marketplace, endpoints) {
  if (endpoints.length === 0) return;
  const dir  = path.join(__dirname, 'session');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `api-${marketplace}.json`);
  writeFileSync(file, JSON.stringify(endpoints, null, 2));
  console.log(`  💾 API info saved → session/api-${marketplace}.json`);
}

// ── Setup per marketplace ──────────────────────────────────────────────────

async function setupMarketplace(marketplace) {
  const baseUrl = getBaseUrl(marketplace);

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Amazon Associates MCP — Setup [${marketplace.toUpperCase()}]`);
  console.log(`  ${baseUrl}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Steps:');
  console.log('  1. A browser window will open');
  console.log('  2. Log in (email, password, 2FA if required)');
  console.log('  3. The script detects login automatically');
  console.log('  4. Cookies + API endpoints are saved');
  console.log('  5. Browser closes');
  console.log('');

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Start intercepting before navigating
  const discoveredEndpoints = [];
  page.on('response', async (response) => {
    try {
      const url  = response.url();
      const ct   = response.headers()['content-type'] ?? '';
      if (response.status() !== 200) return;
      if (!ct.includes('json')) return;
      if (!url.includes('amazon')) return;
      if (url.includes('static') || url.includes('sprite') || url.includes('gtm')) return;

      const body = await response.text();
      if (
        body.length > 50 &&
        (body.includes('click') || body.includes('Click') ||
         body.includes('earning') || body.includes('Earning') ||
         body.includes('revenue') || body.includes('Revenue'))
      ) {
        const reqHeaders = response.request().headers();
        discoveredEndpoints.push({
          url,
          method:   response.request().method(),
          postData: response.request().postData() ?? null,
          headers:  {
            accept:          reqHeaders['accept'] ?? '',
            'content-type':  reqHeaders['content-type'] ?? '',
            'x-csrf-token':  reqHeaders['x-csrf-token'] ?? '',
            'anti-csrftoken-a2z': reqHeaders['anti-csrftoken-a2z'] ?? '',
          },
          responsePreview: body.slice(0, 300),
        });
        console.log(`  📡 Captured: ${url.slice(0, 80)}`);
      }
    } catch { /* ignore */ }
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  console.log(`Opening browser... (navigating to ${baseUrl})`);

  // ── Poll for successful login ──────────────────────────────────────────
  const POLL_MS    = 2_000;
  const MAX_WAIT   = 5 * 60_000;
  const baseDomain = new URL(baseUrl).hostname; // e.g. 'programma-affiliazione.amazon.it'
  const start      = Date.now();
  let   loggedIn   = false;

  console.log(`\nWaiting for login on ${baseDomain}...`);

  while (Date.now() - start < MAX_WAIT) {
    await new Promise(r => setTimeout(r, POLL_MS));

    if (page.isClosed()) {
      console.error(`\n❌  Browser closed before login.`);
      await browser.close();
      return false;
    }

    const url = page.url();

    // ✅ Logged in = NOT on a login page AND on our marketplace domain
    if (!isLoginPage(url) && url.includes(baseDomain)) {
      loggedIn = true;
      break;
    }

    // Also accept if we're on any amazon domain after login (some markets redirect)
    if (!isLoginPage(url) && url.includes('.amazon.') && !url.includes('www.amazon')) {
      loggedIn = true;
      break;
    }
  }

  if (!loggedIn) {
    console.error(`\n❌  Timeout — login not completed in 5 minutes.`);
    await browser.close();
    return false;
  }

  console.log(`\n✅  Login detected! Saving session...`);

  // ── Navigate to reports to trigger API calls ───────────────────────────
  console.log('  Navigating to reports page to discover API endpoints...');
  try {
    await page.goto(`${baseUrl}/p/reporting/earnings`, {
      waitUntil: 'networkidle',
      timeout:   20_000,
    });
    // Wait a bit extra for any deferred XHR calls
    await page.waitForTimeout(3_000);
  } catch {
    // Non-critical — just means we couldn't discover APIs
  }

  // ── Save cookies ───────────────────────────────────────────────────────
  await saveSession(context, marketplace);
  console.log(`  ✅ Session cookies saved → ${path.relative(__dirname, getSessionPath(marketplace))}`);

  // ── Save API endpoints if found ────────────────────────────────────────
  if (discoveredEndpoints.length > 0) {
    saveApiInfo(marketplace, discoveredEndpoints);
    console.log(`  ✅ ${discoveredEndpoints.length} API endpoint(s) captured`);
  } else {
    console.log('  ℹ️  No JSON API endpoints found — will use page scraping instead');
  }

  await browser.close();
  console.log(`\n✅  Setup complete for [${marketplace.toUpperCase()}]`);
  return true;
}

// ── Run ────────────────────────────────────────────────────────────────────

console.log(`\nSetting up ${marketplaces.length} marketplace(s): ${marketplaces.join(', ')}\n`);

for (const marketplace of marketplaces) {
  const ok = await setupMarketplace(marketplace);
  if (!ok && marketplaces.length > 1) {
    console.log('⏭️  Skipping remaining due to error.');
    break;
  }
}

console.log('\nDone! The MCP server is ready.\n');
