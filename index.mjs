/**
 * index.mjs — Amazon Associates MCP Server
 *
 * Tools:
 *   get_earnings_summary   → metriche aggregate per un periodo
 *   get_daily_breakdown    → breakdown giornaliero
 *   get_top_products       → prodotti più ordinati
 *   check_session          → verifica validità sessione
 *
 * Start: node index.mjs
 * First-time setup: npm run setup
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
import { SessionExpiredError } from './auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = (desc) =>
  z.string().regex(DATE_REGEX).describe(desc);

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function err(e) {
  return {
    content: [{ type: 'text', text: `❌ ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

const server = new McpServer({ name: 'amazon-associates-mcp', version: '1.0.0' });

server.tool(
  'get_earnings_summary',
  'Aggregate metrics (clicks, ordered items, shipped items, earnings €) for Amazon Associates in a date range.',
  { startDate: dateParam('Start date YYYY-MM-DD'), endDate: dateParam('End date YYYY-MM-DD') },
  async ({ startDate, endDate }) => {
    try { return ok(await getEarningsSummary({ startDate, endDate })); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'get_daily_breakdown',
  'Day-by-day breakdown of clicks, orders and earnings for Amazon Associates in a date range.',
  { startDate: dateParam('Start date YYYY-MM-DD'), endDate: dateParam('End date YYYY-MM-DD') },
  async ({ startDate, endDate }) => {
    try { return ok(await getDailyBreakdown({ startDate, endDate })); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'get_top_products',
  'Most ordered products via Amazon Associates affiliate links in a period.',
  {
    startDate: dateParam('Start date YYYY-MM-DD'),
    endDate: dateParam('End date YYYY-MM-DD'),
    limit: z.number().int().min(1).max(100).default(20).describe('Max rows to return (default 20)'),
  },
  async ({ startDate, endDate, limit }) => {
    try { return ok(await getTopProducts({ startDate, endDate, limit })); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'check_session',
  'Check whether the saved Amazon Associates session is still valid.',
  {},
  async () => {
    try {
      return ok(await checkSession());
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        return {
          content: [{
            type: 'text',
            text: [
              '⚠️  Session expired or not found.',
              '',
              'Run the setup script to log in:',
              `  cd ${__dirname}`,
              '  node setup.mjs',
              '',
              'A browser window will open — log in — session is saved automatically.',
            ].join('\n'),
          }],
        };
      }
      return err(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[amazon-associates-mcp] Server started.');
