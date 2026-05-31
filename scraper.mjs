/**
 * scraper.mjs — estrazione dati da Amazon Associates Central
 *
 * Tutti i metodi aprono un browser headless, usano la sessione salvata,
 * estraggono i dati e chiudono il browser.
 *
 * Se la sessione è scaduta viene lanciato SessionExpiredError.
 */

import { chromium } from 'playwright';
import {
  BASE_URL,
  SessionExpiredError,
  loadSession,
  saveSession,
  isLoginPage,
} from './auth.mjs';

const REPORTS_URL = `${BASE_URL}/home/reports`;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Crea browser + context con cookies caricati */
async function createSession(headless = true) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'it-IT',
  });
  const loaded = await loadSession(context);
  if (!loaded && headless) {
    await browser.close();
    throw new SessionExpiredError();
  }
  return { browser, context };
}

/**
 * Converte YYYY-MM-DD → MM/DD/YYYY
 * (formato usato da Amazon Associates date picker)
 */
function toAmzDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/**
 * Naviga alla pagina Reports e imposta il range di date.
 */
async function openReportPage(page, startDate, endDate) {
  await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 });

  if (isLoginPage(page.url())) throw new SessionExpiredError();

  // Prova input diretti (versione nuova UI)
  try {
    const startInput = page.locator(
      'input[name="startDate"], input[placeholder*="Data inizio"], input[aria-label*="start"], input[aria-label*="inizio"]'
    ).first();

    if (await startInput.isVisible({ timeout: 5_000 })) {
      await startInput.fill(toAmzDate(startDate));
      const endInput = page.locator(
        'input[name="endDate"], input[placeholder*="Data fine"], input[aria-label*="end"], input[aria-label*="fine"]'
      ).first();
      await endInput.fill(toAmzDate(endDate));

      const applyBtn = page.locator(
        'button:has-text("Apply"), button:has-text("Applica"), button:has-text("Aggiorna"), button[type="submit"]'
      ).first();
      await applyBtn.click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
      return;
    }
  } catch { /* prova via URL params */ }

  // Fallback: URL querystring
  const url = new URL(REPORTS_URL);
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 30_000 });

  if (isLoginPage(page.url())) throw new SessionExpiredError();
}

/**
 * Estrae le metriche di riepilogo dalla pagina reports.
 * Usa strategia multi-selettore per resistere ai restyling di Amazon.
 */
async function extractSummaryMetrics(page) {
  await page.waitForSelector(
    '[data-test-id*="metric"], [class*="summary"], [class*="metric"], table',
    { timeout: 15_000 }
  );

  const metrics = await page.evaluate(() => {
    const result = {};

    // Pattern 1: data-test-id attributes
    document.querySelectorAll('[data-test-id]').forEach(el => {
      const id = (el.getAttribute('data-test-id') ?? '').toLowerCase();
      const text = el.innerText?.trim();
      if (id.includes('click')) result.clicks = text;
      if (id.includes('earning') || id.includes('guadagni')) result.earnings = text;
      if (id.includes('order') || id.includes('ordered')) result.orderedItems = text;
      if (id.includes('shipped') || id.includes('spediti')) result.shippedItems = text;
      if (id.includes('conversion')) result.conversionRate = text;
    });

    if (Object.keys(result).length > 0) return result;

    // Pattern 2: label/value pairs in tables or grids
    const labels = ['Click', 'Clicks', 'Guadagni', 'Earning', 'Ordinati', 'Ordered', 'Spediti', 'Shipped'];
    document.querySelectorAll('th, td, [class*="label"], [class*="header"], h3, h4').forEach(el => {
      const text = el.innerText?.trim();
      labels.forEach(label => {
        if (text?.toLowerCase().includes(label.toLowerCase())) {
          const nextEl = el.nextElementSibling ?? el.parentElement?.nextElementSibling;
          if (nextEl) {
            const val = nextEl.innerText?.trim();
            if (label.toLowerCase().includes('click')) result.clicks = val;
            else if (label.toLowerCase().includes('earn') || label.toLowerCase().includes('guada')) result.earnings = val;
            else if (label.toLowerCase().includes('ordin') || label.toLowerCase().includes('order')) result.orderedItems = val;
            else if (label.toLowerCase().includes('sped') || label.toLowerCase().includes('ship')) result.shippedItems = val;
          }
        }
      });
    });

    return result;
  });

  // Fallback: raw text for debugging when selectors fail
  if (Object.keys(metrics).length === 0) {
    const pageText = await page.evaluate(() => document.body.innerText);
    return {
      _raw: pageText.slice(0, 3000),
      _note: 'selectors not matched — raw text for debugging. Please open a GitHub issue with this output.',
    };
  }

  return metrics;
}

/** Estrae il dettaglio giornaliero dalla tabella principale */
async function extractDailyTable(page) {
  try {
    await page.waitForSelector('table', { timeout: 8_000 });
    return await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      const dataTable = tables.sort(
        (a, b) => b.querySelectorAll('tr').length - a.querySelectorAll('tr').length
      )[0];
      if (!dataTable) return [];

      const headers = Array.from(dataTable.querySelectorAll('th')).map(th =>
        th.innerText?.trim().toLowerCase()
      );
      return Array.from(dataTable.querySelectorAll('tbody tr'))
        .map(row => {
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText?.trim());
          const obj = {};
          headers.forEach((h, i) => { if (h) obj[h] = cells[i]; });
          return obj;
        })
        .filter(row => Object.keys(row).length > 0);
    });
  } catch {
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Riepilogo earnings per un periodo.
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 */
export async function getEarningsSummary({ startDate, endDate }) {
  const { browser, context } = await createSession();
  const page = await context.newPage();
  try {
    await openReportPage(page, startDate, endDate);
    const metrics = await extractSummaryMetrics(page);
    await saveSession(context);
    return { period: { startDate, endDate }, metrics, fetchedAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
}

/**
 * Breakdown giornaliero nel periodo.
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 */
export async function getDailyBreakdown({ startDate, endDate }) {
  const { browser, context } = await createSession();
  const page = await context.newPage();
  try {
    await openReportPage(page, startDate, endDate);
    const summary = await extractSummaryMetrics(page);
    const daily = await extractDailyTable(page);
    await saveSession(context);
    return { period: { startDate, endDate }, summary, daily, fetchedAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
}

/**
 * Top prodotti ordinati nel periodo.
 * @param {string} startDate
 * @param {string} endDate
 * @param {number} limit  (default 20)
 */
export async function getTopProducts({ startDate, endDate, limit = 20 }) {
  const { browser, context } = await createSession();
  const page = await context.newPage();
  try {
    const productsUrl = `${BASE_URL}/home/reports/ref=ac_reports_t2`;
    await page.goto(productsUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    if (isLoginPage(page.url())) throw new SessionExpiredError();

    try { await openReportPage(page, startDate, endDate); } catch { /* date picker might not be present */ }

    const rows = await extractDailyTable(page);
    await saveSession(context);
    return { period: { startDate, endDate }, products: rows.slice(0, limit), fetchedAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
}

/** Verifica se la sessione è ancora valida. */
export async function checkSession() {
  const { browser, context } = await createSession();
  const page = await context.newPage();
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const loggedIn = !isLoginPage(page.url());
    if (loggedIn) await saveSession(context);
    return { valid: loggedIn, url: page.url(), checkedAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
}
