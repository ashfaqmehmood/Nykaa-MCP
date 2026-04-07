// ── Playwright Browser Singleton + Page Pool ──

import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { existsSync } from "fs";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const POOL_SIZE = 3;
const PAGE_TIMEOUT = 30_000;

let browser: Browser | null = null;
let context: BrowserContext | null = null;
const availablePages: Page[] = [];
const busyPages = new Set<Page>();

// Dedicated page that stays on nykaa.com to maintain Akamai cookies
let cookiePage: Page | null = null;

// ── Browser Discovery ──
// Nykaa uses Akamai bot protection which blocks Playwright's bundled Chromium.
// We try system browsers first (they have real TLS/HTTP2 fingerprints).

const BROWSER_CANDIDATES: string[] = [
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Helium.app/Contents/MacOS/Helium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/brave-browser",
  "/usr/bin/microsoft-edge",
];

function findBrowserPath(): string | undefined {
  // User override via env var
  const envPath = process.env.NYKAA_BROWSER_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }

  // Fall back to bundled Chromium (may be blocked by Akamai)
  return undefined;
}

async function ensureBrowser(): Promise<BrowserContext> {
  if (context && browser?.isConnected()) return context;

  const executablePath = findBrowserPath();
  if (executablePath) {
    console.error(`Using browser: ${executablePath}`);
  } else {
    console.error("Using bundled Chromium (may be blocked by Akamai — set NYKAA_BROWSER_PATH if needed)");
  }

  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    javaScriptEnabled: true,
  });

  // Pre-create pages
  for (let i = 0; i < POOL_SIZE; i++) {
    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT);
    availablePages.push(page);
  }

  return context;
}

// ── Page Pool ──

export async function acquirePage(): Promise<Page> {
  await ensureBrowser();

  // Try to get an available page
  if (availablePages.length > 0) {
    const page = availablePages.pop()!;
    busyPages.add(page);
    return page;
  }

  // All pages busy — create a temporary one
  const page = await context!.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT);
  busyPages.add(page);
  return page;
}

export async function releasePage(page: Page): Promise<void> {
  busyPages.delete(page);

  // Return to pool if below pool size, otherwise close
  if (availablePages.length < POOL_SIZE) {
    try {
      await page.goto("about:blank");
      availablePages.push(page);
    } catch {
      // Page is broken, discard it
      try { await page.close(); } catch { /* ignore */ }
    }
  } else {
    try { await page.close(); } catch { /* ignore */ }
  }
}

// ── In-Browser Fetch (bypasses Akamai) ──
// Uses a persistent page on nykaa.com so Akamai cookies are present.

async function ensureCookiePage(): Promise<Page> {
  await ensureBrowser();

  if (cookiePage && !cookiePage.isClosed()) return cookiePage;

  cookiePage = await context!.newPage();
  cookiePage.setDefaultTimeout(PAGE_TIMEOUT);
  await cookiePage.goto("https://www.nykaa.com", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });

  return cookiePage;
}

/**
 * Fetch a URL from within the browser context.
 * The browser has Akamai cookies, so API calls succeed.
 */
export async function browserFetch(url: string): Promise<unknown> {
  const page = await ensureCookiePage();
  return page.evaluate(async (fetchUrl: string) => {
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, url);
}

// ── Shutdown ──

export async function shutdown(): Promise<void> {
  if (cookiePage) {
    try { await cookiePage.close(); } catch { /* ignore */ }
    cookiePage = null;
  }

  for (const page of [...availablePages, ...busyPages]) {
    try { await page.close(); } catch { /* ignore */ }
  }
  availablePages.length = 0;
  busyPages.clear();

  if (context) {
    try { await context.close(); } catch { /* ignore */ }
    context = null;
  }
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
