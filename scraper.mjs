/**
 * scraper.mjs — estrazione dati da Amazon Associates Central
 *
 * Basato su ispezione live della pagina reale (maggio 2026):
 * - Reports URL: /p/reporting/earnings
 * - Date range: preset SELECT + calendar dropdowns
 * - Data: estratta via page.innerText parsing (robusto ai restyling)
 */

import { chromium } from 'playwright';
import {
  getBaseUrl,
  DEFAULT_MARKETPLACE,
  SessionExpiredError,
  loadSession,
  saveSession,
  isLoginPage,
} from './auth.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Session ──────────────────────────────────────────────────────────────────

async function createSession(marketplace = DEFAULT_MARKETPLACE, headless = true) {
  const browser = await chromium.launch({ headless });
  const localeMap = {
    it: 'it-IT', com: 'en-US', de: 'de-DE', fr: 'fr-FR',
    es: 'es-ES', 'co.uk': 'en-GB', 'co.jp': 'ja-JP',
  };
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: localeMap[marketplace] ?? 'en-US',
  });
  const loaded = await loadSession(context, marketplace);
  if (!loaded && headless) {
    await browser.close();
    throw new SessionExpiredError(marketplace);
  }
  return { browser, context };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Mappa un range YYYY-MM-DD → valore preset del SELECT Amazon.
 * Ritorna null se il range non corrisponde a nessun preset.
 *
 * Preset disponibili (da ispezione live):
 *   today, yesterday, week, last_week, month, last_month,
 *   last_30, last_90, last_365
 */
function dateRangeToPreset(startDate, endDate) {
  const now   = new Date();
  const todayStr     = now.toISOString().slice(0, 10);
  const yesterdayStr = new Date(now - 86_400_000).toISOString().slice(0, 10);

  const start = new Date(startDate + 'T00:00:00');
  const end   = new Date(endDate   + 'T00:00:00');
  const diffDays = Math.round((end - start) / 86_400_000) + 1;

  if (startDate === todayStr  && endDate === todayStr)     return 'today';
  if (startDate === yesterdayStr && endDate === yesterdayStr) return 'yesterday';
  if (diffDays === 30)  return 'last_30';
  if (diffDays === 90)  return 'last_90';
  if (diffDays === 365) return 'last_365';

  // This month
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  if (startDate === firstOfMonth && endDate === todayStr) return 'month';

  // Last month
  const firstOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const lastOfLastMonth  = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
  if (startDate === firstOfLastMonth && endDate === lastOfLastMonth) return 'last_month';

  return null;
}

/**
 * Imposta il range di date custom tramite i calendar SELECT dropdown.
 * Struttura trovata via ispezione live: .a-cal-select-month, .a-cal-select-day, .a-cal-select-year
 */
async function setCustomDateRange(page, startDate, endDate) {
  // Apre il popover del date picker (tasto con testo del range corrente)
  const trigger = page.locator('.a-popover-trigger').first();
  if (await trigger.isVisible({ timeout: 4_000 })) {
    await trigger.click();
    await page.waitForTimeout(800);
  }

  // Selects per start date (primo set di dropdowns nel popover)
  const monthSelects = page.locator('.a-cal-select-month');
  const daySelects   = page.locator('.a-cal-select-day');
  const yearSelects  = page.locator('.a-cal-select-year');

  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);

  try {
    if (await monthSelects.count() >= 2) {
      await monthSelects.nth(0).selectOption(String(sm));
      await daySelects.nth(0).selectOption(String(sd));
      await yearSelects.nth(0).selectOption(String(sy));
      await monthSelects.nth(1).selectOption(String(em));
      await daySelects.nth(1).selectOption(String(ed));
      await yearSelects.nth(1).selectOption(String(ey));
    }

    // Click Go / Apply / Update
    const applyBtn = page.locator(
      'button:has-text("Go"), button:has-text("Apply"), button:has-text("Update"), input[type="submit"]'
    ).first();
    if (await applyBtn.isVisible({ timeout: 3_000 })) {
      await applyBtn.click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
    }
  } catch {
    // Se il custom range fallisce, lascia il default (last_30)
    console.error('[scraper] custom date range failed, using page default');
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

/**
 * Naviga alla pagina earnings e imposta il date range.
 * Prova prima col preset SELECT; se non corrisponde usa i calendar dropdowns.
 */
async function openReportPage(page, startDate, endDate, marketplace = DEFAULT_MARKETPLACE) {
  const reportsUrl = `${getBaseUrl(marketplace)}/p/reporting/earnings`;

  await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 });

  if (isLoginPage(page.url())) throw new SessionExpiredError(marketplace);

  // Tenta impostazione date via preset
  const preset = dateRangeToPreset(startDate, endDate);

  if (preset) {
    try {
      const selectId = '#ac-daterange-preset-report-download-timeInterval';
      await page.waitForSelector(selectId, { timeout: 6_000 });
      await page.selectOption(selectId, preset);
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
      return;
    } catch { /* fallthrough al custom range */ }
  }

  // Custom date range via calendar dropdowns
  await setCustomDateRange(page, startDate, endDate);
}

// ─── Data extraction ─────────────────────────────────────────────────────────

/**
 * Estrae le metriche dal testo della pagina.
 *
 * Formato testuale osservato su pagina reale (/p/reporting/earnings):
 *   Fees Summary
 *   Clicks\n{val}\nOrdered\n{val}\nDispatched\n{val}\nConversion\n{val}\nEarnings\n{val}
 *   Bounties Summary
 *   Total Number of Referrals\n{val}\nEarnings\n{val}
 *   Total Earnings Summary\n{val}
 */
function parseReportsText(text) {
  const metrics = {};

  const extract = (label, pattern) => {
    const m = text.match(pattern);
    if (m) metrics[label] = m[1].trim();
  };

  // Pattern: label seguito da newline e valore
  extract('clicks',              /Clicks\s*\n\s*([\d,\.]+)/);
  extract('orderedItems',        /Ordered\s*\n\s*([\d,\.]+)/);
  extract('dispatchedItems',     /Dispatched\s*\n\s*([\d,\.]+)/);
  extract('conversion',          /Conversion\s*\n\s*([\d,\.%]+)/);
  extract('feesEarnings',        /Fees Summary[\s\S]*?Earnings\s*\n\s*(€[\d,\.]+)/);
  extract('bountiesEarnings',    /Bounties Summary[\s\S]*?Earnings\s*\n\s*(€[\d,\.]+)/);
  extract('totalEarnings',       /Total Earnings Summary\s*\n\s*(€[\d,\.]+)/);
  extract('totalReferrals',      /Total Number of Referrals\s*\n\s*([\d,\.]+)/);

  // Estrai anche il date range mostrato sulla pagina
  const dateRangeMatch = text.match(/(\d{2}\/\d{2}\/\d{4})\s*[-–]\s*(\d{2}\/\d{2}\/\d{4})/);
  if (dateRangeMatch) {
    metrics._reportedDateRange = `${dateRangeMatch[1]} - ${dateRangeMatch[2]}`;
  }

  return metrics;
}

async function extractMetrics(page) {
  // Attendi che almeno un elemento chiave sia visibile
  await page.waitForSelector(
    '.ac-card-data-item, [class*="summary"], [class*="report"]',
    { timeout: 15_000 }
  );

  const text = await page.evaluate(() => document.body.innerText);
  const metrics = parseReportsText(text);

  if (Object.keys(metrics).filter(k => !k.startsWith('_')).length === 0) {
    return {
      _raw: text.slice(0, 3000),
      _note: 'Parsing failed — raw text for debugging. Please open a GitHub issue.',
    };
  }

  return metrics;
}

// ─── Table extraction ─────────────────────────────────────────────────────────

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

export async function getEarningsSummary({ startDate, endDate, marketplace = DEFAULT_MARKETPLACE }) {
  const { browser, context } = await createSession(marketplace);
  const page = await context.newPage();
  try {
    await openReportPage(page, startDate, endDate, marketplace);
    const metrics = await extractMetrics(page);
    await saveSession(context, marketplace);
    return { marketplace, period: { startDate, endDate }, metrics, fetchedAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
}

export async function getDailyBreakdown({ startDate, endDate, marketplace = DEFAULT_MARKETPLACE }) {
  const { browser, context } = await createSession(marketplace);
  const page = await context.newPage();
  try {
    await openReportPage(page, startDate, endDate, marketplace);
    const summary = await extractMetrics(page);
    const daily   = await extractDailyTable(page);
    await saveSession(context, marketplace);
    return { marketplace, period: { startDate, endDate }, summary, daily, fetchedAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
}

export async function getTopProducts({ startDate, endDate, limit = 20, marketplace = DEFAULT_MARKETPLACE }) {
  const { browser, context } = await createSession(marketplace);
  const page = await context.newPage();
  try {
    // Naviga alla sezione ordered items (tab /p/reporting/orderedItems se esiste)
    const orderedUrl = `${getBaseUrl(marketplace)}/p/reporting/orderedItems`;
    await page.goto(orderedUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    if (isLoginPage(page.url())) throw new SessionExpiredError(marketplace);
    // Se la pagina non esiste, fallback alla earnings page
    if (page.url().includes('/p/reporting/earnings') || page.url() === orderedUrl) {
      try { await openReportPage(page, startDate, endDate, marketplace); } catch { /* ignore */ }
    }
    const rows = await extractDailyTable(page);
    await saveSession(context, marketplace);
    return { marketplace, period: { startDate, endDate }, products: rows.slice(0, limit), fetchedAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
}

export async function checkSession(marketplace = DEFAULT_MARKETPLACE) {
  const { browser, context } = await createSession(marketplace);
  const page = await context.newPage();
  try {
    await page.goto(getBaseUrl(marketplace), { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const loggedIn = !isLoginPage(page.url());
    if (loggedIn) await saveSession(context, marketplace);
    return { marketplace, valid: loggedIn, url: page.url(), checkedAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
}
