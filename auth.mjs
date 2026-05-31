/**
 * auth.mjs — gestione sessione Amazon Associates
 *
 * Strategia:
 * 1. Prima volta: setup.mjs apre browser visibile, utente fa login, cookies salvati
 * 2. Usi successivi: carica cookies → naviga come utente loggato
 * 3. Se sessione scaduta: lancia SessionExpiredError → utente ri-esegue setup.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = process.env.SESSION_PATH
  ?? path.join(__dirname, 'session', 'cookies.json');

const MARKETPLACE = process.env.AMAZON_MARKETPLACE ?? 'it';
export const BASE_URL = `https://affiliate-program.amazon.${MARKETPLACE}`;

export class SessionExpiredError extends Error {
  constructor() {
    super(
      `Sessione Amazon Associates scaduta o non trovata.\n` +
      `Esegui: node setup.mjs\n` +
      `(apre il browser — fai login — la sessione viene salvata automaticamente)`
    );
    this.name = 'SessionExpiredError';
  }
}

/** Carica i cookies salvati nel contesto Playwright */
export async function loadSession(context) {
  if (!existsSync(SESSION_PATH)) return false;
  try {
    const raw = readFileSync(SESSION_PATH, 'utf8');
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return false;
    await context.addCookies(cookies);
    return true;
  } catch {
    return false;
  }
}

/** Salva i cookies correnti su disco */
export async function saveSession(context) {
  const cookies = await context.cookies();
  const dir = path.dirname(SESSION_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(cookies, null, 2));
}

/** Ritorna true se l'URL corrente è una pagina di login */
export function isLoginPage(url) {
  return (
    url.includes('/ap/signin') ||
    url.includes('/ap/register') ||
    url.includes('signin') ||
    url.includes('login')
  );
}

/**
 * Esegue il login automatico con email/password.
 * Se Amazon mostra CAPTCHA o richiede 2FA via SMS, questo fallisce →
 * usa setup.mjs per fare login manuale.
 */
export async function doLogin(page) {
  const email = process.env.AMAZON_EMAIL;
  const password = process.env.AMAZON_PASSWORD;

  if (!email || !password) {
    throw new SessionExpiredError();
  }

  console.error('[auth] Tentativo login automatico...');

  await page.waitForSelector('#ap_email', { timeout: 10_000 });
  await page.fill('#ap_email', email);
  await page.click('#continue');

  await page.waitForSelector('#ap_password', { timeout: 10_000 });
  await page.fill('#ap_password', password);
  await page.click('#signInSubmit');

  await page.waitForLoadState('networkidle', { timeout: 15_000 });

  if (isLoginPage(page.url())) {
    throw new Error(
      `Login automatico bloccato (CAPTCHA o 2FA).\n` +
      `Esegui: node setup.mjs  per fare login manuale.`
    );
  }

  console.error('[auth] Login riuscito.');
}

/**
 * Assicura che la pagina sia autenticata.
 * Se siamo sulla pagina di login prova login automatico,
 * altrimenti lancia SessionExpiredError.
 */
export async function ensureAuthenticated(page, context) {
  if (!isLoginPage(page.url())) return;

  try {
    await doLogin(page);
    await saveSession(context);
  } catch {
    throw new SessionExpiredError();
  }
}
