/**
 * index.mjs — Amazon Associates MCP Server (multi-marketplace)
 *
 * Tools:
 *   get_earnings_summary      → metriche aggregate per marketplace + periodo
 *   get_daily_breakdown       → breakdown giornaliero
 *   get_top_products          → prodotti più ordinati
 *   get_all_earnings_summary  → metriche aggregate su TUTTI i marketplace con sessione attiva
 *   check_session             → verifica validità sessione per un marketplace
 *   list_sessions             → lista marketplace con sessioni salvate
 *
 * Start: node index.mjs
 * Setup: node setup.mjs --marketplace it   (ripeti per ogni marketplace)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getEarningsSummary,
  getDailyBreakdown,
  getTopProducts,
  checkSession,
} from './scraper.mjs';
import { SessionExpiredError, DEFAULT_MARKETPLACE, listSavedSessions } from './auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// ── Helpers ────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = (desc) => z.string().regex(DATE_RE).describe(desc);
const marketplaceParam = z
  .string()
  .default(DEFAULT_MARKETPLACE)
  .describe(`Amazon marketplace code: 'it', 'com', 'de', 'fr', 'es', 'co.uk', etc. Default: ${DEFAULT_MARKETPLACE}`);

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function err(e) {
  return {
    content: [{ type: 'text', text: `❌ ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'amazon-associates-mcp', version: '2.0.0' });

// ── get_earnings_summary ───────────────────────────────────────────────────

server.tool(
  'get_earnings_summary',
  'Aggregate metrics (clicks, ordered items, shipped items, earnings) for an Amazon Associates marketplace in a date range.',
  {
    startDate: dateParam('Start date YYYY-MM-DD'),
    endDate: dateParam('End date YYYY-MM-DD'),
    marketplace: marketplaceParam,
  },
  async ({ startDate, endDate, marketplace }) => {
    try { return ok(await getEarningsSummary({ startDate, endDate, marketplace })); }
    catch (e) { return err(e); }
  }
);

// ── get_daily_breakdown ────────────────────────────────────────────────────

server.tool(
  'get_daily_breakdown',
  'Day-by-day breakdown of clicks, orders and earnings for an Amazon Associates marketplace.',
  {
    startDate: dateParam('Start date YYYY-MM-DD'),
    endDate: dateParam('End date YYYY-MM-DD'),
    marketplace: marketplaceParam,
  },
  async ({ startDate, endDate, marketplace }) => {
    try { return ok(await getDailyBreakdown({ startDate, endDate, marketplace })); }
    catch (e) { return err(e); }
  }
);

// ── get_top_products ───────────────────────────────────────────────────────

server.tool(
  'get_top_products',
  'Most ordered products via Amazon Associates affiliate links in a period.',
  {
    startDate: dateParam('Start date YYYY-MM-DD'),
    endDate: dateParam('End date YYYY-MM-DD'),
    marketplace: marketplaceParam,
    limit: z.number().int().min(1).max(100).default(20).describe('Max rows to return (default 20)'),
  },
  async ({ startDate, endDate, marketplace, limit }) => {
    try { return ok(await getTopProducts({ startDate, endDate, marketplace, limit })); }
    catch (e) { return err(e); }
  }
);

// ── get_all_earnings_summary ───────────────────────────────────────────────

server.tool(
  'get_all_earnings_summary',
  'Query earnings summary for ALL Amazon Associates marketplaces that have an active session. Useful for a cross-market overview.',
  {
    startDate: dateParam('Start date YYYY-MM-DD'),
    endDate: dateParam('End date YYYY-MM-DD'),
  },
  async ({ startDate, endDate }) => {
    const markets = listSavedSessions();
    if (markets.length === 0) {
      return {
        content: [{
          type: 'text',
          text: '⚠️  No saved sessions found. Run: node setup.mjs --marketplace it  (repeat for each marketplace)',
        }],
      };
    }

    const results = await Promise.allSettled(
      markets.map(marketplace => getEarningsSummary({ startDate, endDate, marketplace }))
    );

    const data = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { marketplace: markets[i], error: r.reason?.message ?? 'unknown error' }
    );

    return ok({ period: { startDate, endDate }, marketplaces: data, fetchedAt: new Date().toISOString() });
  }
);

// ── check_session ──────────────────────────────────────────────────────────

server.tool(
  'check_session',
  'Check whether the saved session for a specific Amazon Associates marketplace is still valid.',
  { marketplace: marketplaceParam },
  async ({ marketplace }) => {
    try {
      return ok(await checkSession(marketplace));
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        return {
          content: [{
            type: 'text',
            text: [
              `⚠️  Session for marketplace "${marketplace}" expired or not found.`,
              '',
              'Run the setup script:',
              `  cd ${__dirname}`,
              `  node setup.mjs --marketplace ${marketplace}`,
              '',
              'A browser window will open — log in — session saved automatically.',
            ].join('\n'),
          }],
        };
      }
      return err(e);
    }
  }
);

// ── list_sessions ──────────────────────────────────────────────────────────

server.tool(
  'list_sessions',
  'List all Amazon Associates marketplaces that have a saved session cookie file.',
  {},
  async () => {
    const markets = listSavedSessions();
    return ok({
      savedSessions: markets,
      count: markets.length,
      note: markets.length === 0
        ? 'No sessions found. Run: node setup.mjs --marketplace it'
        : `Active sessions for: ${markets.join(', ')}`,
    });
  }
);

// ── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[amazon-associates-mcp] Server started (multi-marketplace).');
