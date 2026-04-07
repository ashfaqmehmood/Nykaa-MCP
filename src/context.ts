// ── Context Compression Utilities ──
// Keeps LLM responses lean — strips noise, truncates, projects fields.

const DEFAULT_MAX_LENGTH = 1500;

export function truncate(text: string, maxLength = DEFAULT_MAX_LENGTH): string {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...[truncated]";
}

export function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanPrice(raw: string): number | null {
  const match = raw.replace(/,/g, "").match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

export function calcDiscount(mrp: number, current: number): number {
  if (mrp <= 0 || current >= mrp) return 0;
  return Math.round(((mrp - current) / mrp) * 100);
}

export function compactJson(data: unknown): string {
  return JSON.stringify(data);
}
