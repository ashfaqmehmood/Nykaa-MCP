# nykaa-mcp

MCP server for searching, browsing, and analyzing products on [Nykaa](https://www.nykaa.com) — India's leading beauty and cosmetics retailer. Provides product search, detailed product info, batch price checks, and ingredient analysis through the [Model Context Protocol](https://modelcontextprotocol.io).

## Quick Start

### Using bunx (recommended)

```bash
bunx nykaa-mcp
```

Or with npx:

```bash
npx nykaa-mcp
```

### Claude Code

```bash
claude mcp add nykaa -- bunx nykaa-mcp
```

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nykaa": {
      "command": "bunx",
      "args": ["nykaa-mcp"]
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
      "args": ["nykaa-mcp"]
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

Detects 48 active ingredients (niacinamide, retinol, hyaluronic acid, vitamin C, etc.) and 24 flagged ingredients (parabens, sulfates, formaldehyde, etc.).

## How It Works

Nykaa doesn't expose a public API. This server uses a hybrid extraction approach:

1. **JSON API** (fastest) — Nykaa's internal search API returns structured product data directly
2. **HTML fallback** — Native `fetch` with browser-like headers when the API is blocked or returns incomplete data

Data is extracted using a cascading strategy:
- Internal JSON API (`/nyk/aggregator-gludo/api/search.list`)
- Embedded page state (`__NEXT_DATA__`, `__PRELOADED_STATE__`)
- JSON-LD structured data (`schema.org`)
- CSS selector-based DOM parsing

All outputs are **context-compressed** — no raw HTML, stripped metadata, truncated descriptions — optimized for LLM context windows.

## Development

```bash
git clone https://github.com/ashbuilds/nykaa-mcp.git
cd nykaa-mcp
bun install
bun run build
```

### Scripts

| Command | Description |
|---------|-------------|
| `bun run build` | Compile TypeScript to `build/` |
| `bun run dev` | Run from source |
| `bun run start` | Run compiled server |

### Project Structure

```
src/
  index.ts       MCP server entry point + tool definitions
  nykaa-api.ts   Core API logic — search, details, prices, ingredients
  browser.ts     HTTP client with Akamai bypass headers
  cache.ts       In-memory TTL cache with periodic cleanup
  context.ts     Utility functions (truncate, stripHtml, etc.)
  types.ts       TypeScript interfaces
```

## Requirements

- Node.js >= 18 or Bun >= 1.1

## License

MIT
