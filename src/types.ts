// ── Nykaa MCP Server Types ──

export interface ProductSummary {
  product_id: string;
  title: string;
  brand: string;
  current_price: number;
  mrp: number;
  average_rating: number | null;
  product_url: string;
}

export interface ProductVariant {
  name: string;
  sku_id: string | null;
  in_stock: boolean;
}

export interface ProductDetails {
  title: string;
  brand: string;
  category: string | null;
  pricing: {
    current_price: number;
    mrp: number;
    discount_percentage: number;
  };
  ingredients: string[];
  description: string;
  variants: ProductVariant[];
  average_rating: number | null;
  review_count: number | null;
  image_url: string | null;
  product_url: string;
}

export interface PriceInfo {
  current_price: number | null;
  mrp: number | null;
  in_stock: boolean;
  discount_percentage: number | null;
}

export interface IngredientAnalysis {
  key_actives: string[];
  base_ingredients: string[];
  notable_flags: string[];
  raw_count: number;
}

export type SortOption = "relevance" | "price_asc" | "price_desc" | "discount";

// Sort param map is now internal to nykaa-api.ts
