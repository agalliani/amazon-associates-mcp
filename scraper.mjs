/**
 * scraper.mjs — Amazon Associates data extraction
 *
 * Approach (in order of preference):
 *   1. Direct HTTP fetch() with saved cookie header (fast, no browser)
 *   2. Playwright headless browser fallback (if fetch fails / session expired)
 *
 * The direct fetch approach bypasses Playwright cookie loading issues
 * (SameSite/Secure restrictions in headless context).
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getBaseUrl,
  DEFAULT_MARKETPLACE,
  SessionExpiredError,
  loadSession,
  saveSession,
  isLoginPage,
  getSessionPath,
} from './auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Cookie helpers ───────────────────────────────────────────────────────────

function loadCookiesRaw(marketplace) {
  const file = getSessionPath(marketplace);
  if (!existsSync(file)) return null;
  try {
    const cookies = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(cookies) && cookies.length > 0 ? cookies : null;
  } catch { return null; }
}

function buildCookieHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// ─── Direct HTTP fetch ────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Fetches a page directly with saved session cookies.
 * Returns the response text, or null if the session is expired/invalid.
 */
async function fetchWithSession(url, marketplace) {
  const cookies = loadCookiesRaw(marketplace);
  if (!cookies) return null;

  const baseUrl = getBaseUrl(marketplace);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'cookie':          buildCookieHeader(cookies),
      'user-agent':      UA,
      'accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'referer':         baseUrl,
      'origin':          baseUrl,
    },
    redirect: 'follow',
  });

  const finalUrl = response.url;
  // If redirected to login, session is expired
  if (isLoginPage(finalUrl)) return null;

  const text = await response.text();
  // Double-check the response content isn't a login page
  if (text.includes('ap_email') || text.includes('ap_password')) return null;

  return { text, finalUrl };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Maps a date range to the closest Amazon preset value.
 * Preset SELECT id: #ac-daterange-preset-report-download-timeInterval
 */
function dateRangeToPreset(startDate, endDate) {
  const now   = new Date();
  const todayStr     = now.toISOString().slice(0, 10);
  const yesterdayStr = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const start = new Date(startDate + 'T00:00:00');
  const end   = new Date(endDate   + 'T00:00:00');
  const diffDays = Math.round((end - start) / 86_400_000) + 1;

  if (startDate === todayStr  && endDate === todayStr)       return 'today';
  if (startDate === yesterdayStr && endDate === yesterdayStr) return 'yesterday';
  if (diffDays === 30)  return 'last_30';
  if (diffDays === 90)  return 'last_90';
  if (diffDays === 365) return 'last_365';

  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  if (startDate === firstOfMonth && endDate === todayStr) return 'month';

  const firstOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const lastOfLastMonth  = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
  if (startDate === firstOfLastMonth && endDate === lastOfLastMonth) return 'last_month';

  return 'last_30'; // default preset when no match
}

// ─── Data parsing ─────────────────────────────────────────────────────────────

/**
 * Parses earnings metrics from the /p/reporting/earnings page text.
 *
 * Structure observed on the live page (May 2026):
 *   Fees Summary
 *   Clicks\n{N}\nOrdered\n{N}\nDispatched\n{N}\nConversion\n{%}\nEarnings\n€{N}
 *   Bounties Summary
 *   Total Number of Referrals\n{N}\nEarnings\n€{N}
 *   Total Earnings Summary\n€{N}
 */
function parseReportsText(text) {
  const metrics = {};

  const extract = (label, pattern) => {
    const m = text.match(pattern);
    if (m) metrics[label] = m[1].trim();
  };

  extract('clicks',           /Clicks\s*[\n\r]+\s*([\d,\.]+)/);
  extract('orderedItems',     /Ordered\s*[\n\r]+\s*([\d,\.]+)/);
  extract('dispatchedItems',  /Dispatched\s*[\n\r]+\s*([\d,\.]+)/);
  extract('conversion',       /Conversion\s*[\n\r]+\s*([\d,\.%]+)/);
  extract('feesEarnings',     /Fees Summary[\s\S]*?Earnings\s*[\n\r]+\s*(€[\d,\.]+)/);
  extract('bountiesEarnings', /Bounties Summary[\s\S]*?Earnings\s*[\n\r]+\s*(€[\d,\.]+)/);
  extract('totalEarnings',    /Total Earnings Summary\s*[\n\r]+\s*(€[\d,\.]+)/);
  extract('totalReferrals',   /Total Number of Referrals\s*[\n\r]+\s*([\d,\.]+)/);

  const drMatch = text.match(/(\d{2}\/\d{2}\/\d{4})\s*[-–]\s*(\d{2}\/\d{2}\/\d{4})/);
  if (drMatch) metrics._reportedDateRange = `${drMatch[1]} - ${drMatch[2]}`;

  return metrics;
}

// ─── Session (Playwright fallback) ────────────────────────────────────────────

async function createBrowserSession(marketplace = DEFAULT_MARKETPLACE) {
  const browser = await chromium.launch({ headless: true });
  const localeMap = { it: 'it-IT', com: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', 'co.uk': 'en-GB' };
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: localeMap[marketplace] ?? 'en-US',
  });
  const loaded = await loadSession(context, marketplace);
  if (!loaded) {
    await browser.close();
    throw new SessionExpiredError(marketplace);
  }
  return { browser, context };
}

async function extractMetricsViaBrowser(startDate, endDate, marketplace) {
  const { browser, context } = await createBrowserSession(marketplace);
  const page = await context.newPage();
  try {
    const baseUrl    = getBaseUrl(marketplace);
    const reportsUrl = `${baseUrl}/p/reporting/earnings`;
    const preset     = dateRangeToPreset(startDate, endDate);

    await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 });

    if (isLoginPage(page.url())) throw new SessionExpiredError(marketplace);

    // Set date via preset SELECT
    try {
      const selectId = '#ac-daterange-preset-report-download-timeInterval';
      await page.waitForSelector(selectId, { timeout: 6_000 });
      await page.selectOption(selectId, preset);
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
    } catch { /* use page default */ }

    await page.waitForSelector('.ac-card-data-item, [class*="summary"]', { timeout: 12_000 });
    const text = await page.evaluate(() => document.body.innerText);
    const metrics = parseReportsText(text);

    await saveSession(context, marketplace);
    return metrics;
  } finally {
    await browser.close();
  }
}

async function extractDailyTableViaBrowser(startDate, endDate, marketplace) {
  const { browser, context } = await createBrowserSession(marketplace);
  const page = await context.newPage();
  try {
    const reportsUrl = `${getBaseUrl(marketplace)}/p/reporting/earnings`;
    const preset = dateRangeToPreset(startDate, endDate);

    await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 });
    if (isLoginPage(page.url())) throw new SessionExpiredError(marketplace);

    try {
      const selectId = '#ac-daterange-preset-report-download-timeInterval';
      await page.waitForSelector(selectId, { timeout: 6_000 });
      await page.selectOption(selectId, preset);
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
    } catch { /* use page default */ }

    await saveSession(context, marketplace);

    return await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      const dataTable = tables.sort(
        (a, b) => b.querySelectorAll('tr').length - a.querySelectorAll('tr').length
      )[0];
      if (!dataTable) return [];
      const headers = Array.from(dataTable.querySelectorAll('th'))
        .map(th => th.innerText?.trim().toLowerCase());
      return Array.from(dataTable.querySelectorAll('tbody tr'))
        .map(row => {
          const cells = Array.from(row.querySelectorAll('td'))
            .map(td => td.innerText?.trim());
          const obj = {};
          headers.forEach((h, i) => { if (h) obj[h] = cells[i]; });
          return obj;
        })
        .filter(row => Object.keys(row).length > 0);
    });
  } finally {
    await browser.close();
  }
}

// ─── Core: get earnings page via direct fetch ─────────────────────────────────

/**
 * Fetches the earnings report page using HTTP + cookies (no browser).
 * Returns parsed metrics or null if session is invalid.
 */
async function getEarningsViaFetch(startDate, endDate, marketplace) {
  const baseUrl    = getBaseUrl(marketplace);
  const preset     = dateRangeToPreset(startDate, endDate);

  // Use the preset as a URL param (some Amazon Associates versions support it)
  const url = `${baseUrl}/p/reporting/earnings?timeInterval=${preset}`;

  let result = await fetchWithSession(url, marketplace);
  if (!result) {
    // Try without the param
    result = await fetchWithSession(`${baseUrl}/p/reporting/earnings`, marketplace);
  }
  if (!result) return null;

  const metrics = parseReportsText(result.text);

  // If we got no metrics, the page may have changed structure — return raw for debugging
  if (Object.keys(metrics).filter(k => !k.startsWith('_')).length === 0) {
    return {
      _note: 'Metrics not parsed from page. Raw text sample below.',
      _raw:  result.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000),
    };
  }

  return metrics;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getEarningsSummary({ startDate, endDate, marketplace = DEFAULT_MARKETPLACE }) {
  // 1. Try direct HTTP fetch (fast, no browser)
  try {
    const metrics = await getEarningsViaFetch(startDate, endDate, marketplace);
    if (metrics) {
      return { marketplace, period: { startDate, endDate }, metrics, source: 'http', fetchedAt: new Date().toISOString() };
    }
  } catch (e) {
    console.error('[scraper] direct fetch failed:', e.message);
  }

  // 2. Fallback: Playwright browser
  const metrics = await extractMetricsViaBrowser(startDate, endDate, marketplace);
  return { marketplace, period: { startDate, endDate }, metrics, source: 'browser', fetchedAt: new Date().toISOString() };
}

export async function getDailyBreakdown({ startDate, endDate, marketplace = DEFAULT_MARKETPLACE }) {
  let summary = null;

  try {
    const metrics = await getEarningsViaFetch(startDate, endDate, marketplace);
    if (metrics) summary = metrics;
  } catch { /* fallthrough */ }

  if (!summary) {
    summary = await extractMetricsViaBrowser(startDate, endDate, marketplace);
  }

  const daily = await extractDailyTableViaBrowser(startDate, endDate, marketplace).catch(() => []);
  return { marketplace, period: { startDate, endDate }, summary, daily, fetchedAt: new Date().toISOString() };
}

export async function getTopProducts({ startDate, endDate, limit = 20, marketplace = DEFAULT_MARKETPLACE }) {
  const baseUrl = getBaseUrl(marketplace);
  const rows    = await extractDailyTableViaBrowser(startDate, endDate, marketplace).catch(() => []);
  return { marketplace, period: { startDate, endDate }, products: rows.slice(0, limit), fetchedAt: new Date().toISOString() };
}

export async function checkSession(marketplace = DEFAULT_MARKETPLACE) {
  // Quick check: try to fetch home page with saved cookies
  const cookies = loadCookiesRaw(marketplace);
  if (!cookies) throw new SessionExpiredError(marketplace);

  const baseUrl  = getBaseUrl(marketplace);
  const result   = await fetchWithSession(baseUrl, marketplace);
  const valid    = result !== null;

  return { marketplace, valid, checkedAt: new Date().toISOString() };
}
