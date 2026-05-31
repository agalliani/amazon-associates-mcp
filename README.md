# amazon-associates-mcp

A self-hosted [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets you query your **Amazon Associates** earnings, clicks, and orders directly from Claude — no manual data export required.

Built for the Italian marketplace (`affiliate-program.amazon.it`) but easily adaptable to any locale.

---

## How it works

The server uses [Playwright](https://playwright.dev) to authenticate with Amazon Associates Central and extract report data on demand. A one-time interactive login saves a persistent session; after that, everything runs headlessly and automatically.

```
Claude ──► MCP Server ──► Playwright (headless) ──► Amazon Associates Central
```

---

## Tools exposed

| Tool | Description |
|------|-------------|
| `get_earnings_summary` | Aggregate metrics (clicks, ordered items, shipped items, earnings €) for a date range |
| `get_daily_breakdown` | Day-by-day breakdown for a date range |
| `get_top_products` | Most ordered products in a period |
| `check_session` | Verify whether the saved session is still valid |

---

## Prerequisites

- Node.js 18+
- An active [Amazon Associates](https://affiliate-program.amazon.it) account

---

## Installation

```bash
git clone https://github.com/agalliani/amazon-associates-mcp.git
cd amazon-associates-mcp
npm install
npx playwright install chromium
```

---

## Configuration

Copy `.env.example` to `.env` and fill in your credentials (used as a fallback for automated re-login):

```bash
cp .env.example .env
```

```env
AMAZON_EMAIL=your-email@example.com
AMAZON_PASSWORD=your-password
AMAZON_MARKETPLACE=it   # change to com, de, fr, es, etc.
```

> ⚠️ `.env` and `session/` are gitignored — your credentials never leave your machine.

---

## First-time setup

Run the interactive login script once. It opens a visible browser window — log in normally (including any 2FA or CAPTCHA), and the session is saved automatically when the dashboard loads:

```bash
node setup.mjs
```

After this step, the MCP server runs fully headlessly with no manual intervention. Re-run `setup.mjs` only if your session expires (typically after several months).

---

## Add to Claude

### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "amazon-associates": {
      "command": "node",
      "args": ["/absolute/path/to/amazon-associates-mcp/index.mjs"]
    }
  }
}
```

Restart Claude after editing the config.

### Claude Code

```bash
claude mcp add amazon-associates -- node /absolute/path/to/amazon-associates-mcp/index.mjs
```

---

## Usage examples

Once connected, ask Claude things like:

- *"How many clicks did I get on Amazon Associates last month?"*
- *"What were my earnings last week?"*
- *"Show me my top 10 ordered products in May 2026"*
- *"Give me a daily breakdown of my affiliate performance for Q1 2026"*

---

## Adapting to other marketplaces

Change `AMAZON_MARKETPLACE` in `.env`:

| Value | Marketplace |
|-------|-------------|
| `it`  | amazon.it (default) |
| `com` | amazon.com |
| `de`  | amazon.de |
| `fr`  | amazon.fr |
| `es`  | amazon.es |
| `co.uk` | amazon.co.uk |

The scraper targets `affiliate-program.amazon.{MARKETPLACE}`.

---

## Contributing

Contributions are welcome! The scraper uses multi-selector strategies to handle Amazon's UI changes, but Associates Central gets restyled occasionally. If selectors break:

1. Run `node setup.mjs` to get a fresh session
2. Open `scraper.mjs` and update the selectors in `extractSummaryMetrics()`
3. Submit a PR

Please open an issue before starting major changes.

---

## Disclaimer

This tool automates interaction with Amazon Associates Central for personal use. It is not affiliated with, endorsed by, or sponsored by Amazon. Use it in accordance with Amazon's Terms of Service. The authors are not responsible for any account restrictions that may result from automated access.

---

## License

[MIT](LICENSE) © Andrea Galliani
