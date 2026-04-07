#!/usr/bin/env node

// ── Nykaa MCP Server ──
// Search products, get details, check prices, and analyze ingredients from Nykaa.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchProducts,
  getProductDetails,
  batchGetPrices,
  analyzeIngredients,
} from "./nykaa-api.js";
import { compactJson } from "./context.js";
import { shutdown } from "./browser.js";

const server = new McpServer({
  name: "nykaa-mcp-server",
  version: "1.0.0",
});

// ── Tool 1: Search Products ──

server.tool(
  "search_nykaa_products",
  "Search for beauty & cosmetics products on Nykaa by keywords, brand, or category. Returns a concise list with product IDs, titles, brands, prices, and ratings. Use this to discover products before getting full details.",
  {
    query: z
      .string()
      .min(1)
      .describe("Search keywords — e.g. 'lipstick', 'niacinamide serum', 'Lakme foundation'"),
    limit: z
      .number()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of results to return (default 5)"),
    sort_by: z
      .enum(["relevance", "price_asc", "price_desc", "discount"])
      .default("relevance")
      .describe("Sort order: relevance, price_asc, price_desc, or discount"),
  },
  async ({ query, limit, sort_by }) => {
    try {
      const products = await searchProducts(query, limit, sort_by);
      if (products.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No products found for "${query}". Try different keywords or check spelling.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: compactJson({
              query,
              result_count: products.length,
              products,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to search Nykaa for "${query}": ${error instanceof Error ? error.message : "Unknown error"}. The page may be blocked or the site structure may have changed.`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool 2: Get Product Details ──

server.tool(
  "get_product_details",
  "Fetch detailed information for a specific Nykaa product — including pricing, ingredients, description, variants (shades/sizes), and ratings. Provide either a product_id (from search results) or a full Nykaa URL.",
  {
    product_id: z
      .string()
      .optional()
      .describe("Nykaa product ID (numeric string from search results)"),
    url: z
      .string()
      .optional()
      .describe("Full Nykaa product URL — e.g. 'https://www.nykaa.com/lakme-lipstick/p/363566'"),
  },
  async ({ product_id, url }) => {
    if (!product_id && !url) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Please provide either a product_id or a url.",
          },
        ],
        isError: true,
      };
    }

    try {
      const details = await getProductDetails(product_id, url);
      return {
        content: [
          {
            type: "text" as const,
            text: compactJson(details),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to get product details: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool 3: Batch Get Prices ──

server.tool(
  "batch_get_prices",
  "Lightweight price check for multiple Nykaa products at once. Returns current price, MRP, stock status, and discount for each product ID. Ideal for comparing prices or building wishlists — much faster than calling get_product_details for each item.",
  {
    product_ids: z
      .array(z.string())
      .min(1)
      .max(20)
      .describe("Array of Nykaa product IDs to check (max 20)"),
  },
  async ({ product_ids }) => {
    try {
      const prices = await batchGetPrices(product_ids);
      return {
        content: [
          {
            type: "text" as const,
            text: compactJson({
              checked: product_ids.length,
              prices,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to fetch prices: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool 4: Analyze Ingredients ──

server.tool(
  "analyze_ingredients",
  "Analyze the ingredient list of a Nykaa product. Extracts and categorizes ingredients into key actives (e.g. Niacinamide, Hyaluronic Acid), base/filler ingredients, and notable flags (e.g. Parabens, Sulfates). Useful for skincare-conscious users.",
  {
    product_id: z
      .string()
      .describe("Nykaa product ID to analyze ingredients for"),
  },
  async ({ product_id }) => {
    try {
      const analysis = await analyzeIngredients(product_id);
      return {
        content: [
          {
            type: "text" as const,
            text: compactJson(analysis),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to analyze ingredients: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Start Server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Nykaa MCP Server running on stdio");

  // Graceful shutdown when MCP client disconnects
  process.stdin.on("end", () => {
    shutdown().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  console.error("Fatal error starting server:", error);
  shutdown().finally(() => process.exit(1));
});
