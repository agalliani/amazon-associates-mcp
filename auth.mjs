/**
 * auth.mjs — gestione sessione Amazon Associates
 *
 * Strategia:
 * 1. Prima volta: setup.mjs apre browser visibile, utente fa login, cookies salvati
 * 2. Usi successivi: carica cookies → naviga come utente loggato
 * 3. Se sessione scaduta: lancia SessionExpiredError → utente ri-esegue setup.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * URL base di Associates Central per ogni marketplace.
 * Ogni paese ha il suo sottodominio localizzato.
 */
const BASE_URLS = {
  'it':     'https://programma-affiliazione.amazon.it',
  'com':    'https://affiliate-program.amazon.com',
  'de':     'https://partnernet.amazon.de',
  'fr':     'https://partenaires.amazon.fr',
  'es':     'https://afiliados.amazon.es',
  'co.uk':  'https://affiliate-program.amazon.co.uk',
  'co.jp':  'https://affiliate.amazon.co.jp',
  'ca':     'https://associates.amazon.ca',
  'com.au': 'https://affiliate-program.amazon.com.au',
  'in':     'https://affiliate-program.amazon.in',
  'nl':     'https://partnernet.amazon.nl',
  'pl':     'https://partnernet.amazon.pl',
  'se':     'https://partnernet.amazon.se',
};

/** Ritorna l'URL base di Associates Central per il marketplace dato */
export function getBaseUrl(marketplace) {
  return BASE_URLS[marketplace] ?? `https://affiliate-program.amazon.${marketplace}`;
}

/** Ritorna il path del file cookies per il marketplace dato */
export function getSessionPath(marketplace) {
  if (process.env.SESSION_PATH && marketplace === (process.env.AMAZON_MARKETPLACE ?? 'it')) {
    return process.env.SESSION_PATH;
  }
  return path.join(__dirname, 'session', `cookies-${marketplace}.json`);
}

/** Marketplace di default (da env o 'it') */
export const DEFAULT_MARKETPLACE = process.env.AMAZON_MARKETPLACE ?? 'it';

/** @deprecated usa getBaseUrl(marketplace) */
export const BASE_URL = getBaseUrl(DEFAULT_MARKETPLACE);

export class SessionExpiredError extends Error {
  constructor(marketplace = DEFAULT_MARKETPLACE) {
    super(
      `Sessione Amazon Associates (${marketplace}) scaduta o non trovata.\n` +
      `Esegui: node setup.mjs --marketplace ${marketplace}\n` +
      `(apre il browser — fai login — la sessione viene salvata automaticamente)`
    );
    this.name = 'SessionExpiredError';
    this.marketplace = marketplace;
  }
}

/** Carica i cookies salvati nel contesto Playwright */
export async function loadSession(context, marketplace = DEFAULT_MARKETPLACE) {
  const sessionPath = getSessionPath(marketplace);
  if (!existsSync(sessionPath)) return false;
  try {
    const raw = readFileSync(sessionPath, 'utf8');
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return false;
    await context.addCookies(cookies);
    return true;
  } catch {
    return false;
  }
}

/** Salva i cookies correnti su disco */
export async function saveSession(context, marketplace = DEFAULT_MARKETPLACE) {
  const sessionPath = getSessionPath(marketplace);
  const cookies = await context.cookies();
  const dir = path.dirname(sessionPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(sessionPath, JSON.stringify(cookies, null, 2));
}

/** Ritorna la lista dei marketplace che hanno una sessione salvata */
export function listSavedSessions() {
  const sessionDir = path.join(__dirname, 'session');
  if (!existsSync(sessionDir)) return [];
  return readdirSync(sessionDir)
    .filter(f => f.startsWith('cookies-') && f.endsWith('.json'))
    .map(f => f.replace('cookies-', '').replace('.json', ''));
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
 * usa setup.mjs --marketplace XX per fare login manuale.
 */
export async function doLogin(page, marketplace = DEFAULT_MARKETPLACE) {
  const email = process.env.AMAZON_EMAIL;
  const password = process.env.AMAZON_PASSWORD;

  if (!email || !password) {
    throw new SessionExpiredError(marketplace);
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
      `Esegui: node setup.mjs --marketplace ${marketplace}  per fare login manuale.`
    );
  }

  console.error('[auth] Login riuscito.');
}

/**
 * Assicura che la pagina sia autenticata.
 * Se siamo sulla pagina di login prova login automatico,
 * altrimenti lancia SessionExpiredError.
 */
export async function ensureAuthenticated(page, context, marketplace = DEFAULT_MARKETPLACE) {
  if (!isLoginPage(page.url())) return;

  try {
    await doLogin(page, marketplace);
    await saveSession(context, marketplace);
  } catch {
    throw new SessionExpiredError(marketplace);
  }
}
