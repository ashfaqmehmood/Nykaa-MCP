// ── Nykaa Scraping & Data Extraction ──

import axios from "axios";
import * as cheerio from "cheerio";
import type { Page } from "playwright";
import { acquirePage, releasePage, browserFetch } from "./browser.js";
import { truncate, stripHtml, cleanPrice, calcDiscount } from "./context.js";
import { cacheGet, cacheSet } from "./cache.js";
import type {
  ProductSummary,
  ProductDetails,
  PriceInfo,
  IngredientAnalysis,
  SortOption,
  ProductVariant,
} from "./types.js";
import { SORT_PARAM_MAP } from "./types.js";

// ── Constants ──

const BASE_URL = "https://www.nykaa.com";

const AXIOS_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-IN,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
};

const AXIOS_TIMEOUT = 10_000;

// ── Nykaa JSON API (internal, no auth required) ──

const SEARCH_API = `${BASE_URL}/nyk/aggregator-gludo/api/search.list`;

const API_HEADERS = {
  ...AXIOS_HEADERS,
  Accept: "application/json, text/plain, */*",
  Cookie: "countryCode=IN; storeId=nykaa",
};

// ── Rate Limiting ──

const MIN_REQUEST_INTERVAL = 200; // ms between requests
let lastRequestTime = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = MIN_REQUEST_INTERVAL - (now - lastRequestTime);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestTime = Date.now();
}

// ── Retry Wrapper ──

async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) throw error;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error("Unreachable");
}

// Known active ingredients for categorization
const KEY_ACTIVES = new Set([
  "niacinamide", "salicylic acid", "hyaluronic acid", "retinol", "retinal",
  "vitamin c", "ascorbic acid", "glycolic acid", "lactic acid", "azelaic acid",
  "benzoyl peroxide", "kojic acid", "arbutin", "alpha arbutin", "ceramide",
  "peptide", "collagen", "squalane", "bakuchiol", "centella asiatica",
  "tea tree", "aloe vera", "zinc oxide", "titanium dioxide", "tocopherol",
  "vitamin e", "panthenol", "allantoin", "urea", "snail mucin",
  "tranexamic acid", "mandelic acid", "ferulic acid", "resveratrol",
  "caffeine", "green tea", "turmeric", "rice water", "shea butter",
  "jojoba oil", "rosehip oil", "argan oil", "coconut oil", "castor oil",
  "biotin", "keratin", "bhringraj", "amla",
]);

// Flagged/potentially concerning ingredients
const FLAGGED_INGREDIENTS = new Set([
  "paraben", "methylparaben", "propylparaben", "butylparaben", "ethylparaben",
  "sulfate", "sodium lauryl sulfate", "sodium laureth sulfate", "sls", "sles",
  "formaldehyde", "phthalate", "triclosan", "oxybenzone", "hydroquinone",
  "toluene", "lead", "mercury", "mineral oil", "petrolatum",
  "diethanolamine", "triethanolamine", "dea", "tea",
  "synthetic fragrance", "artificial color",
]);

// ── Axios Fast Path ──

async function fetchWithAxios(url: string): Promise<string | null> {
  try {
    await throttle();
    const res = await axios.get(url, {
      headers: AXIOS_HEADERS,
      timeout: AXIOS_TIMEOUT,
      maxRedirects: 3,
    });
    if (res.status === 200 && typeof res.data === "string" && res.data.length > 500) {
      return res.data;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Playwright Helpers ──

async function fetchWithPlaywright(url: string): Promise<string> {
  const page = await acquirePage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Wait for content to render
    await page.waitForTimeout(2000);
    return await page.content();
  } finally {
    await releasePage(page);
  }
}

async function fetchPage(url: string): Promise<string> {
  return withRetry(async () => {
    // Try axios first (fast path)
    const html = await fetchWithAxios(url);
    if (html) return html;
    // Fall back to Playwright
    return fetchWithPlaywright(url);
  });
}

// ── Extraction: Embedded JSON ──

function extractEmbeddedJson(html: string): Record<string, unknown> | null {
  const $ = cheerio.load(html);

  // Try __NEXT_DATA__
  const nextData = $('script#__NEXT_DATA__').html();
  if (nextData) {
    try { return JSON.parse(nextData); } catch { /* continue */ }
  }

  // Try window.__PRELOADED_STATE__
  const scripts = $('script').toArray();
  for (const script of scripts) {
    const text = $(script).html() || "";
    const preloadMatch = text.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});?\s*(?:<\/script>|$)/);
    if (preloadMatch) {
      try { return JSON.parse(preloadMatch[1]); } catch { /* continue */ }
    }
    // Try window.__DATA__
    const dataMatch = text.match(/window\.__DATA__\s*=\s*({[\s\S]*?});?\s*(?:<\/script>|$)/);
    if (dataMatch) {
      try { return JSON.parse(dataMatch[1]); } catch { /* continue */ }
    }
  }

  return null;
}

function extractJsonLd(html: string): Record<string, unknown>[] {
  const $ = cheerio.load(html);
  const results: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).html();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        results.push(parsed);
      } catch { /* skip */ }
    }
  });
  return results;
}

// ── JSON API: Search ──

async function searchViaApi(
  query: string,
  limit: number,
  sortBy: SortOption
): Promise<ProductSummary[] | null> {
  try {
    await throttle();
    const params = new URLSearchParams({
      search: query,
      from: "0",
      app_version: "7003",
      platform: "website",
      source: "react",
      filter_format: "v2",
      show_searchable_child: "true",
      sort: SORT_PARAM_MAP[sortBy],
    });

    const data = (await browserFetch(`${SEARCH_API}?${params}`)) as Record<string, unknown>;
    if (data?.status !== "success") return null;

    const response = data.response as Record<string, unknown>;
    const products = response?.products;
    if (!Array.isArray(products)) return null;

    return (products as Record<string, unknown>[]).slice(0, limit).map((p) => ({
      product_id: String(p.id || ""),
      title: String(p.name || "").slice(0, 200),
      brand: Array.isArray(p.brand_name)
        ? String((p.brand_name as string[])[0] || "")
        : String(p.brand_name || ""),
      current_price: (p.final_price as number) || (p.price as number) || 0,
      mrp: (p.price as number) || 0,
      average_rating: (p.rating as number) || null,
      product_url:
        String(p.product_url || "") ||
        (p.slug ? `${BASE_URL}/${p.slug}` : ""),
    }));
  } catch {
    return null;
  }
}

// ── Tool: Search Products ──

export async function searchProducts(
  query: string,
  limit: number,
  sortBy: SortOption
): Promise<ProductSummary[]> {
  const cacheKey = `search:${query}:${limit}:${sortBy}`;
  const cached = cacheGet<ProductSummary[]>(cacheKey);
  if (cached) return cached;

  // Strategy 0: Try Nykaa JSON API (fastest path — returns structured data directly)
  const apiResults = await searchViaApi(query, limit, sortBy);
  if (apiResults && apiResults.length > 0) {
    cacheSet(cacheKey, apiResults);
    return apiResults;
  }

  // Fall back to HTML scraping if API is blocked/down
  const sortParam = SORT_PARAM_MAP[sortBy];
  const url = `${BASE_URL}/search/result/?q=${encodeURIComponent(query)}&root=search&searchType=Manual&sort=${sortParam}`;

  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  const products: ProductSummary[] = [];

  // Strategy 1: Try embedded JSON state
  const embedded = extractEmbeddedJson(html);
  if (embedded) {
    const extracted = extractProductsFromJson(embedded, limit);
    if (extracted.length > 0) {
      cacheSet(cacheKey, extracted);
      return extracted;
    }
  }

  // Strategy 2: Try JSON-LD
  const jsonLd = extractJsonLd(html);
  for (const ld of jsonLd) {
    if (ld["@type"] === "ItemList" && Array.isArray(ld.itemListElement)) {
      for (const item of (ld.itemListElement as Record<string, unknown>[]).slice(0, limit)) {
        const itemObj = (item.item || item) as Record<string, unknown>;
        products.push({
          product_id: String(itemObj.sku || itemObj.productID || ""),
          title: String(itemObj.name || ""),
          brand: String((itemObj.brand as Record<string, unknown>)?.name || ""),
          current_price: cleanPrice(String(
            (itemObj.offers as Record<string, unknown>)?.price || "0"
          )) || 0,
          mrp: 0,
          average_rating: itemObj.aggregateRating
            ? parseFloat(String((itemObj.aggregateRating as Record<string, unknown>).ratingValue))
            : null,
          product_url: String(itemObj.url || ""),
        });
      }
      if (products.length > 0) {
        const result = products.slice(0, limit);
        cacheSet(cacheKey, result);
        return result;
      }
    }
  }

  // Strategy 3: CSS selector extraction from product cards
  const cardSelectors = [
    '[class*="product-listing"] [class*="product-card"]',
    '[class*="productList"] [class*="product"]',
    '.css-d5znlh', // known Nykaa product card class
    '[data-at*="product"]',
    '.product-list .product-item',
    '[class*="ProductCard"]',
    '[class*="productCard"]',
  ];

  let cards = $(cardSelectors[0]);
  for (const sel of cardSelectors) {
    const found = $(sel);
    if (found.length > 0) { cards = found; break; }
  }

  // If no specific cards found, try generic link-based extraction
  if (cards.length === 0) {
    // Look for product links
    $('a[href*="/p/"]').each((i, el) => {
      if (i >= limit) return;
      const $el = $(el);
      const href = $el.attr("href") || "";
      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      const idMatch = href.match(/\/p\/(\d+)/);

      // Try to find price and title nearby
      const parent = $el.closest('[class*="product"], [class*="card"], li, article');
      const container = parent.length ? parent : $el;

      const title = container.find('[class*="title"], [class*="name"], h3, h4').first().text().trim()
        || $el.text().trim();
      const brand = container.find('[class*="brand"]').first().text().trim();
      const priceText = container.find('[class*="price"], [class*="Price"]').first().text().trim();
      const ratingText = container.find('[class*="rating"], [class*="Rating"]').first().text().trim();

      if (title && idMatch) {
        products.push({
          product_id: idMatch[1],
          title: stripHtml(title).slice(0, 200),
          brand: stripHtml(brand),
          current_price: cleanPrice(priceText) || 0,
          mrp: 0,
          average_rating: ratingText ? parseFloat(ratingText) || null : null,
          product_url: fullUrl,
        });
      }
    });

    const result = products.slice(0, limit);
    if (result.length > 0) cacheSet(cacheKey, result);
    return result;
  }

  cards.each((i, el) => {
    if (i >= limit) return;
    const $card = $(el);
    const link = $card.find("a[href*='/p/']").first();
    const href = link.attr("href") || "";
    const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    const idMatch = href.match(/\/p\/(\d+)/);

    const title =
      $card.find('[class*="title"], [class*="name"], h3, h4').first().text().trim() ||
      link.text().trim();
    const brand = $card.find('[class*="brand"]').first().text().trim();
    const priceEls = $card.find('[class*="price"], [class*="Price"]');
    const currentPriceText = priceEls.first().text().trim();
    const mrpText = priceEls.length > 1 ? priceEls.eq(1).text().trim() : "";
    const ratingText = $card.find('[class*="rating"], [class*="Rating"]').first().text().trim();

    products.push({
      product_id: idMatch ? idMatch[1] : "",
      title: stripHtml(title).slice(0, 200),
      brand: stripHtml(brand),
      current_price: cleanPrice(currentPriceText) || 0,
      mrp: cleanPrice(mrpText) || 0,
      average_rating: ratingText ? parseFloat(ratingText) || null : null,
      product_url: fullUrl,
    });
  });

  const result = products.slice(0, limit);
  if (result.length > 0) cacheSet(cacheKey, result);
  return result;
}

function extractProductsFromJson(
  data: Record<string, unknown>,
  limit: number
): ProductSummary[] {
  const products: ProductSummary[] = [];

  // Deep search for product arrays in the JSON
  const candidates = findArraysWithProducts(data);

  for (const arr of candidates) {
    for (const item of arr.slice(0, limit)) {
      const obj = item as Record<string, unknown>;
      const id = String(obj.id || obj.productId || obj.product_id || obj.sku || "");
      const title = String(obj.name || obj.title || obj.productName || "");
      if (!title) continue;

      products.push({
        product_id: id,
        title: title.slice(0, 200),
        brand: String(obj.brand || obj.brandName || ""),
        current_price:
          typeof obj.price === "number" ? obj.price :
          typeof obj.offerPrice === "number" ? obj.offerPrice :
          cleanPrice(String(obj.price || obj.offerPrice || "0")) || 0,
        mrp:
          typeof obj.mrp === "number" ? obj.mrp :
          cleanPrice(String(obj.mrp || "0")) || 0,
        average_rating:
          typeof obj.rating === "number" ? obj.rating :
          typeof obj.averageRating === "number" ? obj.averageRating :
          null,
        product_url: String(obj.url || obj.productUrl || obj.slug || ""),
      });
    }
    if (products.length > 0) break;
  }

  return products.slice(0, limit);
}

function findArraysWithProducts(
  obj: unknown,
  depth = 0
): unknown[][] {
  if (depth > 8 || !obj || typeof obj !== "object") return [];
  const results: unknown[][] = [];

  if (Array.isArray(obj)) {
    // Check if this array contains product-like objects
    const hasProducts = obj.some(
      (item) =>
        item &&
        typeof item === "object" &&
        ("name" in item || "title" in item || "productName" in item) &&
        ("price" in item || "offerPrice" in item || "mrp" in item)
    );
    if (hasProducts) results.push(obj);
  } else {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      results.push(...findArraysWithProducts(value, depth + 1));
    }
  }

  return results;
}

// ── Tool: Get Product Details ──

export async function getProductDetails(
  productId?: string,
  url?: string
): Promise<ProductDetails> {
  const cacheKey = `details:${productId || url}`;
  const cached = cacheGet<ProductDetails>(cacheKey);
  if (cached) return cached;

  let targetUrl: string;
  if (url) {
    targetUrl = url.startsWith("http") ? url : `${BASE_URL}${url}`;
  } else if (productId) {
    // Try JSON API first to resolve the product URL
    const apiResult = await searchViaApi(productId, 1, "relevance");
    if (apiResult && apiResult.length > 0 && apiResult[0].product_url) {
      const resolved = apiResult[0].product_url;
      targetUrl = resolved.startsWith("http") ? resolved : `${BASE_URL}${resolved}`;
    } else {
      // Fall back to HTML search
      const searchUrl = `${BASE_URL}/search/result/?q=${productId}&root=search&searchType=Manual`;
      const html = await fetchPage(searchUrl);
      const $ = cheerio.load(html);
      const productLink = $(`a[href*="/p/${productId}"]`).first().attr("href");
      if (productLink) {
        targetUrl = productLink.startsWith("http") ? productLink : `${BASE_URL}${productLink}`;
      } else {
        targetUrl = `${BASE_URL}/p/${productId}`;
      }
    }
  } else {
    throw new Error("Either product_id or url must be provided.");
  }

  const html = await fetchPage(targetUrl);
  const $ = cheerio.load(html);

  // Strategy 1: JSON-LD structured data
  const jsonLd = extractJsonLd(html);
  let ldProduct: Record<string, unknown> | null = null;
  for (const ld of jsonLd) {
    if (ld["@type"] === "Product") {
      ldProduct = ld;
      break;
    }
  }

  // Strategy 2: Embedded JSON
  const embedded = extractEmbeddedJson(html);

  // Build product details from best available source
  const details = buildProductDetails($, ldProduct, embedded, targetUrl);
  cacheSet(cacheKey, details);
  return details;
}

function buildProductDetails(
  $: cheerio.CheerioAPI,
  ldProduct: Record<string, unknown> | null,
  embedded: Record<string, unknown> | null,
  pageUrl: string
): ProductDetails {
  // Helper: safe string from embedded JSON
  const embStr = (key: string): string | null => {
    if (!embedded) return null;
    const v = deepFindKey(embedded, key);
    return typeof v === "string" && v.length > 0 && v.length < 500 ? v : null;
  };
  const embNum = (key: string): number | null => {
    if (!embedded) return null;
    const v = deepFindKey(embedded, key);
    return typeof v === "number" && v > 0 ? v : null;
  };

  // ── Title ── (embedded → JSON-LD → DOM → meta)
  const title =
    embStr("productName") ||
    (ldProduct?.name as string) ||
    $('h1[class*="title"], h1[class*="name"], h1[class*="Title"], h1').first().text().trim() ||
    $('meta[property="og:title"]').attr("content") ||
    "Unknown Product";

  // ── Brand ── (embedded → JSON-LD → meta → DOM with length guard)
  let brand =
    embStr("brandName") ||
    embStr("brand_name") ||
    (ldProduct?.brand as Record<string, unknown>)?.name as string ||
    $('meta[property="product:brand"]').attr("content") ||
    "";
  if (!brand || brand.length > 100) {
    // CSS selector fallback with strict length guard
    const cssBrand = $('[class*="brand-name"], [class*="brandName"]').first().text().trim();
    brand = cssBrand.length > 0 && cssBrand.length < 100 ? cssBrand : "";
  }

  // ── Category ──
  const category =
    embStr("categoryName") ||
    $('[class*="breadcrumb"] a').last().text().trim() ||
    $('meta[property="product:category"]').attr("content") ||
    null;

  // ── Pricing ── (embedded → JSON-LD → DOM)
  let currentPrice = embNum("offerPrice") || embNum("offer_price") || embNum("sellingPrice") || 0;
  let mrp = embNum("mrp") || 0;

  if (!currentPrice && ldProduct?.offers) {
    const offers = ldProduct.offers as Record<string, unknown>;
    currentPrice = cleanPrice(String(offers.price || "0")) || 0;
    mrp = cleanPrice(String(offers.highPrice || offers.price || "0")) || 0;
  }

  if (!currentPrice) {
    const priceSelectors = [
      '[class*="selling-price"], [class*="sellingPrice"], [class*="offer-price"]',
      '[class*="price"]:not([class*="mrp"]):not([class*="strike"])',
    ];
    for (const sel of priceSelectors) {
      const text = $(sel).first().text().trim();
      const p = cleanPrice(text);
      if (p && p > 10) { currentPrice = p; break; } // ignore tiny/bogus prices
    }
  }

  if (!mrp) {
    const mrpSelectors = [
      '[class*="mrp"], [class*="strike-price"], [class*="original-price"]',
      'span[style*="line-through"], s, del',
    ];
    for (const sel of mrpSelectors) {
      const text = $(sel).first().text().trim();
      const p = cleanPrice(text);
      if (p && p > 10) { mrp = p; break; }
    }
  }

  if (!mrp) mrp = currentPrice;

  // ── Description ── (embedded → JSON-LD → meta — avoid broad CSS selectors)
  let descriptionRaw = "";
  if (embedded) {
    const embDesc = deepFindKey(embedded, "description");
    if (typeof embDesc === "string" && embDesc.length > 20 && embDesc.length < 5000) {
      descriptionRaw = embDesc;
    }
  }
  if (!descriptionRaw) {
    descriptionRaw =
      (ldProduct?.description as string) ||
      $('meta[property="og:description"]').attr("content") ||
      "";
  }
  const description = truncate(stripHtml(descriptionRaw));

  // ── Ingredients ──
  const ingredients = extractIngredients($, embedded);

  // ── Variants ──
  const variants = extractVariants($, embedded);

  // ── Rating ── (embedded → JSON-LD → DOM)
  let averageRating = embNum("rating") || embNum("averageRating") || null;
  let reviewCount: number | null = embNum("reviewCount") || embNum("ratingCount") || null;

  if (averageRating === null && ldProduct?.aggregateRating) {
    const agg = ldProduct.aggregateRating as Record<string, unknown>;
    averageRating = parseFloat(String(agg.ratingValue)) || null;
    reviewCount = parseInt(String(agg.reviewCount || agg.ratingCount), 10) || null;
  }

  if (averageRating === null) {
    const ratingText = $('[class*="rating"], [class*="Rating"]').first().text().trim();
    const parsed = ratingText ? parseFloat(ratingText) : NaN;
    averageRating = !isNaN(parsed) && parsed >= 0 && parsed <= 5 ? parsed : null;
  }
  if (reviewCount === null) {
    const reviewText = $('[class*="review-count"], [class*="reviewCount"]').first().text().trim();
    const match = reviewText.match(/(\d[\d,]*)/);
    reviewCount = match ? parseInt(match[1].replace(/,/g, ""), 10) : null;
  }

  // ── Image ──
  const imageUrl =
    (ldProduct?.image as string) ||
    ((ldProduct?.image as Record<string, unknown>)?.url as string) ||
    $('meta[property="og:image"]').attr("content") ||
    $('[class*="product-image"] img, [class*="ProductImage"] img').first().attr("src") ||
    null;

  return {
    title: stripHtml(title).slice(0, 300),
    brand: stripHtml(brand).slice(0, 100),
    category: category ? stripHtml(category).slice(0, 100) : null,
    pricing: {
      current_price: currentPrice,
      mrp,
      discount_percentage: calcDiscount(mrp, currentPrice),
    },
    ingredients,
    description,
    variants,
    average_rating: averageRating,
    review_count: reviewCount,
    image_url: imageUrl,
    product_url: pageUrl,
  };
}

function parseIngredientText(raw: string): string[] {
  const cleaned = stripHtml(raw).replace(/^ingredients\s*:?\s*/i, "").trim();
  // Guard: if text is too long it's probably the wrong element
  if (cleaned.length < 10 || cleaned.length > 5000) return [];
  return cleaned
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length < 200);
}

function extractIngredients(
  $: cheerio.CheerioAPI,
  embedded: Record<string, unknown> | null
): string[] {
  // Try embedded JSON first (most reliable)
  if (embedded) {
    const found = deepFindKey(embedded, "ingredients");
    if (typeof found === "string" && found.length > 10) {
      const parsed = parseIngredientText(found);
      if (parsed.length > 0) return parsed;
    }
    if (Array.isArray(found) && found.length > 0) {
      return found.map(String).filter(Boolean);
    }
  }

  // Try targeted DOM selectors (avoid overly broad ones)
  const ingredientSelectors = [
    '[class*="ingredient"], [class*="Ingredient"]',
    '#ingredients',
    '[data-section="ingredients"]',
    '[data-at="ingredient"]',
  ];

  for (const sel of ingredientSelectors) {
    // Use .last() — ingredient content tends to be in the deepest matching element
    const el = $(sel).last();
    if (el.length) {
      const parsed = parseIngredientText(el.text());
      if (parsed.length > 0) return parsed;
    }
  }

  return [];
}

function extractVariants(
  $: cheerio.CheerioAPI,
  embedded: Record<string, unknown> | null
): ProductVariant[] {
  const variants: ProductVariant[] = [];

  // Try embedded JSON first
  if (embedded) {
    const found = deepFindKey(embedded, "variants") || deepFindKey(embedded, "shades");
    if (Array.isArray(found)) {
      for (const v of found.slice(0, 50)) {
        const obj = v as Record<string, unknown>;
        variants.push({
          name: String(obj.name || obj.shade || obj.label || obj.title || ""),
          sku_id: obj.skuId ? String(obj.skuId) : obj.sku ? String(obj.sku) : null,
          in_stock: obj.inStock !== false && obj.outOfStock !== true,
        });
      }
      if (variants.length > 0) return variants;
    }
  }

  // Try DOM: shade/variant selectors
  const variantSelectors = [
    '[class*="variant"], [class*="Variant"]',
    '[class*="shade"], [class*="Shade"]',
    '[class*="size-option"], [class*="sizeOption"]',
  ];

  for (const sel of variantSelectors) {
    $(sel).each((_, el) => {
      const $el = $(el);
      const name = $el.attr("title") || $el.attr("aria-label") || $el.text().trim();
      if (name) {
        const isDisabled = $el.hasClass("disabled") || $el.attr("aria-disabled") === "true";
        variants.push({
          name: stripHtml(name).slice(0, 100),
          sku_id: $el.attr("data-sku") || $el.attr("data-id") || null,
          in_stock: !isDisabled,
        });
      }
    });
    if (variants.length > 0) break;
  }

  return variants;
}

function deepFindKey(obj: unknown, key: string, depth = 0): unknown {
  if (depth > 10 || !obj || typeof obj !== "object") return undefined;

  if (!Array.isArray(obj)) {
    const record = obj as Record<string, unknown>;
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(record)) {
      if (k.toLowerCase() === lowerKey) return v;
    }
    for (const v of Object.values(record)) {
      const found = deepFindKey(v, key, depth + 1);
      if (found !== undefined) return found;
    }
  } else {
    for (const item of obj) {
      const found = deepFindKey(item, key, depth + 1);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

// ── Tool: Batch Get Prices ──

export async function batchGetPrices(
  productIds: string[]
): Promise<Record<string, PriceInfo>> {
  const results: Record<string, PriceInfo> = {};
  const uncachedIds: string[] = [];

  // Return cached prices immediately
  for (const id of productIds) {
    const cached = cacheGet<PriceInfo>(`price:${id}`);
    if (cached) {
      results[id] = cached;
    } else {
      uncachedIds.push(id);
    }
  }

  if (uncachedIds.length === 0) return results;

  // Try JSON API first — one lightweight call per product
  const CONCURRENCY = 5;
  for (let i = 0; i < uncachedIds.length; i += CONCURRENCY) {
    const batch = uncachedIds.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((id) => fetchPriceViaApi(id))
    );

    for (let j = 0; j < batch.length; j++) {
      const result = settled[j];
      if (result.status === "fulfilled" && result.value) {
        results[batch[j]] = result.value;
        cacheSet(`price:${batch[j]}`, result.value);
      } else {
        // API failed — try HTML fallback
        try {
          const fallback = await fetchPriceViaHtml(batch[j]);
          results[batch[j]] = fallback;
          cacheSet(`price:${batch[j]}`, fallback);
        } catch {
          results[batch[j]] = {
            current_price: null,
            mrp: null,
            in_stock: false,
            discount_percentage: null,
          };
        }
      }
    }
  }

  return results;
}

async function fetchPriceViaApi(productId: string): Promise<PriceInfo | null> {
  await throttle();
  const params = new URLSearchParams({
    search: productId,
    from: "0",
    app_version: "7003",
    platform: "website",
    source: "react",
    filter_format: "v2",
    show_searchable_child: "true",
  });

  const data = (await browserFetch(`${SEARCH_API}?${params}`)) as Record<string, unknown>;
  if (data?.status !== "success") return null;

  const response = data.response as Record<string, unknown>;
  const products = response?.products;
  if (!Array.isArray(products) || products.length === 0) return null;

  // Find the exact product by ID, or use the first result
  const product = (products as Record<string, unknown>[]).find(
    (p) => String(p.id) === productId
  ) || (products[0] as Record<string, unknown>);

  const currentPrice = (product.final_price as number) || (product.price as number) || null;
  const mrp = (product.price as number) || null;

  return {
    current_price: currentPrice,
    mrp,
    in_stock: product.in_stock !== false,
    discount_percentage:
      currentPrice !== null && mrp !== null ? calcDiscount(mrp, currentPrice) : null,
  };
}

async function fetchPriceViaHtml(productId: string): Promise<PriceInfo> {
  const searchUrl = `${BASE_URL}/search/result/?q=${productId}&root=search&searchType=Manual`;
  const html = await fetchPage(searchUrl);
  const $ = cheerio.load(html);

  const productLink = $(`a[href*="/p/${productId}"]`).first().attr("href");
  let productHtml = html;

  if (productLink) {
    const fullUrl = productLink.startsWith("http") ? productLink : `${BASE_URL}${productLink}`;
    productHtml = await fetchPage(fullUrl);
  }

  const $p = cheerio.load(productHtml);

  const jsonLd = extractJsonLd(productHtml);
  let currentPrice: number | null = null;
  let mrp: number | null = null;
  let inStock = true;

  for (const ld of jsonLd) {
    if (ld["@type"] === "Product" && ld.offers) {
      const offers = ld.offers as Record<string, unknown>;
      currentPrice = cleanPrice(String(offers.price || "")) || null;
      mrp = cleanPrice(String(offers.highPrice || offers.price || "")) || null;
      inStock = String(offers.availability || "").toLowerCase().includes("instock");
      break;
    }
  }

  if (currentPrice === null) {
    const priceText = $p('[class*="selling-price"], [class*="sellingPrice"], [class*="offer-price"], [class*="price"]')
      .first().text().trim();
    currentPrice = cleanPrice(priceText);
  }

  if (mrp === null) {
    const mrpText = $p('[class*="mrp"], [class*="strike"], s, del').first().text().trim();
    mrp = cleanPrice(mrpText);
  }

  if (mrp === null) mrp = currentPrice;

  const outOfStockText = $p('[class*="out-of-stock"], [class*="outOfStock"], [class*="sold-out"]').text();
  if (outOfStockText) inStock = false;

  return {
    current_price: currentPrice,
    mrp,
    in_stock: inStock,
    discount_percentage:
      currentPrice !== null && mrp !== null ? calcDiscount(mrp, currentPrice) : null,
  };
}

// ── Tool: Analyze Ingredients ──

export async function analyzeIngredients(
  productId: string
): Promise<IngredientAnalysis> {
  // Get product details to extract ingredients
  const details = await getProductDetails(productId);

  if (details.ingredients.length === 0) {
    throw new Error(
      `Ingredient data not available for product ${productId}. The product page may not list ingredients, or the page structure has changed.`
    );
  }

  const keyActives: string[] = [];
  const baseIngredients: string[] = [];
  const notableFlags: string[] = [];

  for (const ingredient of details.ingredients) {
    const lower = ingredient.toLowerCase().trim();
    if (!lower) continue;

    let isActive = false;
    let isFlagged = false;

    // Check against known actives
    for (const active of KEY_ACTIVES) {
      if (lower.includes(active)) {
        keyActives.push(ingredient.trim());
        isActive = true;
        break;
      }
    }

    // Check against flagged ingredients
    if (!isActive) {
      for (const flag of FLAGGED_INGREDIENTS) {
        if (lower.includes(flag)) {
          notableFlags.push(ingredient.trim());
          isFlagged = true;
          break;
        }
      }
    }

    if (!isActive && !isFlagged) {
      baseIngredients.push(ingredient.trim());
    }
  }

  return {
    key_actives: keyActives,
    base_ingredients: baseIngredients,
    notable_flags: notableFlags,
    raw_count: details.ingredients.length,
  };
}
