// ── HTTP Client (native fetch with Akamai bypass) ──
// Uses sec-fetch headers to pass Akamai bot detection without Playwright.

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SEC_FETCH_HEADERS = {
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};

const COMMON_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "en-IN,en;q=0.9",
  Cookie: "countryCode=IN; storeId=nykaa",
  Referer: "https://www.nykaa.com/",
  Origin: "https://www.nykaa.com",
  ...SEC_FETCH_HEADERS,
};

const FETCH_TIMEOUT = 15_000;

/**
 * Fetch a JSON API endpoint with Akamai-bypassing headers.
 */
export async function apiFetch(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      headers: {
        ...COMMON_HEADERS,
        Accept: "application/json, text/plain, */*",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch an HTML page with Akamai-bypassing headers.
 */
export async function pageFetch(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      headers: {
        ...COMMON_HEADERS,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
      },
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (html.length < 500) throw new Error("Response too short — likely blocked");
    return html;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * No-op shutdown (kept for API compatibility with index.ts).
 */
export async function shutdown(): Promise<void> {
  // Nothing to clean up — no browser processes
}
