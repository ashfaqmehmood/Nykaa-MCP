# Nykaa MCP Server

MCP server for searching, browsing, and analyzing products on [Nykaa](https://www.nykaa.com) — India's leading beauty and cosmetics retailer. Provides product search, detailed product info, batch price checks, and ingredient analysis through the [Model Context Protocol](https://modelcontextprotocol.io).

## Quick Start

### Using bunx (recommended)

```bash
bunx nykaa-mcp-server
```

Or with npx:

```bash
npx nykaa-mcp-server
```

> **First run:** Playwright needs Chromium installed. Run `bunx playwright install chromium` once before first use.

### Claude Code

```bash
claude mcp add nykaa -- bunx nykaa-mcp-server
```

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nykaa": {
      "command": "bunx",
      "args": ["nykaa-mcp-server"]
    }
  }
}
```

### Cursor / VS Code

Add to your MCP settings:

```json
{
  "mcpServers": {
    "nykaa": {
      "command": "bunx",
      "args": ["nykaa-mcp-server"]
    }
  }
}
```

## Tools

### `search_nykaa_products`

Search Nykaa products by keyword, brand, or category.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search keywords |
| `limit` | number | `5` | Max results (1-20) |
| `sort_by` | enum | `"relevance"` | `relevance`, `price_asc`, `price_desc`, `discount` |

Returns: `product_id`, `title`, `brand`, `current_price`, `mrp`, `average_rating`, `product_url`

### `get_product_details`

Fetch full details for a single product.

| Parameter | Type | Description |
|-----------|------|-------------|
| `product_id` | string | Nykaa product ID (numeric string from search results) |
| `url` | string | Full Nykaa product URL (alternative to product_id) |

Provide one of `product_id` or `url`.

Returns: `title`, `brand`, `category`, `pricing`, `ingredients`, `description`, `variants`, `average_rating`, `review_count`, `image_url`

### `batch_get_prices`

Lightweight price check for multiple products at once.

| Parameter | Type | Description |
|-----------|------|-------------|
| `product_ids` | string[] | Array of Nykaa product IDs (max 20) |

Returns: `{ [product_id]: { current_price, mrp, in_stock, discount_percentage } }`

### `analyze_ingredients`

Categorize a product's ingredients into actives, base ingredients, and flags.

| Parameter | Type | Description |
|-----------|------|-------------|
| `product_id` | string | Nykaa product ID to analyze |

Returns: `key_actives`, `base_ingredients`, `notable_flags`, `raw_count`

Detects 48 active ingredients (niacinamide, retinol, hyaluronic acid, vitamin C, etc.) and 26 flagged ingredients (parabens, sulfates, formaldehyde, etc.).

## How It Works

Nykaa doesn't expose a public API. This server uses a hybrid extraction approach:

1. **JSON API** (fastest) — Nykaa's internal search API returns structured product data directly
2. **Fast path** — `axios` with browser-like headers for direct HTTP fetching
3. **Fallback** — Headless Chromium via Playwright when Akamai bot protection blocks direct requests

Data is extracted using a cascading strategy:
- Internal JSON API (`/nyk/aggregator-gludo/api/search.list`)
- JSON-LD structured data (`schema.org`)
- Embedded page state (`__NEXT_DATA__`, `__PRELOADED_STATE__`)
- CSS selector-based DOM parsing

The server uses a **system browser discovery** strategy — it tries your installed Chrome/Edge/Brave before falling back to bundled Chromium. System browsers have real TLS fingerprints that bypass Akamai bot protection.

All outputs are **context-compressed** — no raw HTML, stripped metadata, truncated descriptions — optimized for LLM context windows.

## Development

```bash
git clone https://github.com/user/nykaa-mcp-server.git
cd nykaa-mcp-server
bun install
bunx playwright install chromium
bun run build
```

### Scripts

| Command | Description |
|---------|-------------|
| `bun run build` | Compile TypeScript to `build/` |
| `bun run dev` | Run from source |
| `bun run start` | Run compiled server |
| `bun run install-browser` | Install Playwright Chromium |

### Project Structure

```
src/
  index.ts       MCP server entry point + tool definitions
  nykaa-api.ts   Core API logic — search, details, prices, ingredients
  browser.ts     Playwright browser pool + system browser discovery
  cache.ts       In-memory TTL cache with periodic cleanup
  context.ts     Utility functions (truncate, stripHtml, etc.)
  types.ts       TypeScript interfaces
```

## Configuration

All optional. The server works out of the box with no configuration.

| Variable | Default | Description |
|----------|---------|-------------|
| `NYKAA_BROWSER_PATH` | (auto-detect) | Path to a Chromium-based browser binary |

## Requirements

- Node.js >= 18 or Bun >= 1.1
- Chromium browser (installed via `bunx playwright install chromium`)

## License

MIT
