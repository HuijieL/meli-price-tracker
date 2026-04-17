/**
 * Mercado Livre API client — Phase 1
 *
 * Three endpoints cover the full Phase 1 + Phase 2 pipeline:
 *   - getHighlights(cat)          Mais Vendidos ranking (catalog product IDs)
 *   - getProduct(productId)       catalog-level details: brand/model/attributes
 *   - getProductSellers(productId) multi-seller listings → real lowest price
 *
 * Built-in throttle: ~150ms between calls keeps us well under ML's ~1000/hr cap.
 */

const API_BASE = 'https://api.mercadolibre.com';

const DEFAULTS = {
  throttleMs: 150,
  maxRetries: 3,
  retryBaseMs: 800,
  userAgent: 'MeliPriceTracker/1.0 (GTM competitor intel)',
};

export class MLClient {
  constructor({ accessToken, throttleMs, maxRetries, retryBaseMs, userAgent } = {}) {
    if (!accessToken) throw new Error('MLClient: accessToken required');
    this.accessToken = accessToken;
    this.throttleMs = throttleMs ?? DEFAULTS.throttleMs;
    this.maxRetries = maxRetries ?? DEFAULTS.maxRetries;
    this.retryBaseMs = retryBaseMs ?? DEFAULTS.retryBaseMs;
    this.userAgent = userAgent ?? DEFAULTS.userAgent;
    this._lastCallAt = 0;
  }

  async _throttle() {
    const now = Date.now();
    const wait = this.throttleMs - (now - this._lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastCallAt = Date.now();
  }

  async _request(urlPath) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this._throttle();
      let res, json;
      try {
        res = await fetch(`${API_BASE}${urlPath}`, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            Accept: 'application/json',
            'User-Agent': this.userAgent,
          },
        });
        json = await res.json().catch(() => null);
      } catch (netErr) {
        if (attempt === this.maxRetries) throw netErr;
        const backoff = this.retryBaseMs * 2 ** attempt;
        console.warn(`  ! network err (${netErr.message}); retry in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      if (res.ok) return json;

      // 404 / 410 etc. — don't retry
      if ([400, 401, 403, 404, 410].includes(res.status)) {
        const err = new Error(
          `ML API ${res.status}: ${json?.error ?? ''} ${json?.message ?? ''} @ ${urlPath}`,
        );
        err.status = res.status;
        err.body = json;
        throw err;
      }

      // 429 / 5xx — retry with backoff
      if (attempt === this.maxRetries) {
        const err = new Error(
          `ML API ${res.status} after ${this.maxRetries + 1} attempts @ ${urlPath}`,
        );
        err.status = res.status;
        err.body = json;
        throw err;
      }
      const backoff = this.retryBaseMs * 2 ** attempt;
      console.warn(`  ! ML ${res.status} ${urlPath}; retry in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  /**
   * Mais Vendidos ranking for a category.
   * Returns array of { id, position, type }. `type` is usually "PRODUCT"
   * (catalog) but can be "ITEM" (single listing) for rare niches.
   */
  async getHighlights(categoryId, { siteId = 'MLB' } = {}) {
    const data = await this._request(`/highlights/${siteId}/category/${categoryId}`);
    return Array.isArray(data?.content) ? data.content : [];
  }

  /**
   * Catalog product details: name, brand, model, attributes, pictures,
   * buy-box winner (ML's default displayed seller).
   */
  async getProduct(productId) {
    return this._request(`/products/${productId}`);
  }

  /**
   * Active item listings under a catalog product — each seller's price.
   */
  async getProductSellers(productId, { limit = 20 } = {}) {
    const data = await this._request(`/products/${productId}/items?limit=${limit}`);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.results)) return data.results;
    return [];
  }
}

/* ---------- Normalizers ---------- */

const ATTRS_OF_INTEREST = new Set([
  'BRAND',
  'MODEL',
  'LINE',
  'INTERNAL_MEMORY',
  'RAM_MEMORY',
  'COLOR',
  'MAIN_COLOR',
  'DISPLAY_SIZE',
  'BATTERY_CAPACITY',
  'MAIN_CAMERA_RESOLUTION',
  'WITH_BLUETOOTH',
  'WITH_WI_FI',
  'WATCH_TYPE',
  'CONNECTIVITY',
  'CATEGORY_ID',
]);

export function normalizeProduct(raw) {
  if (!raw || raw.status === 'not_found') return null;
  const attrsMap = {};
  for (const a of raw.attributes ?? []) {
    if (!ATTRS_OF_INTEREST.has(a.id)) continue;
    attrsMap[a.id] = a.value_name ?? a.values?.[0]?.name ?? null;
  }
  const bbw = raw.buy_box_winner ?? null;
  return {
    id: raw.id,
    name: raw.name,
    brand: attrsMap.BRAND ?? null,
    model: attrsMap.MODEL ?? null,
    line: attrsMap.LINE ?? null,
    attributes: attrsMap,
    pictures: (raw.pictures ?? []).slice(0, 3).map((p) => p.url || p.secure_url),
    main_features: (raw.main_features ?? []).map((f) => f.text).filter(Boolean).slice(0, 5),
    buy_box_price: bbw?.price ?? null,
    buy_box_seller_id: bbw?.seller_id ?? null,
    buy_box_currency: bbw?.currency_id ?? 'BRL',
    permalink: raw.permalink ?? null,
  };
}

export function summarizeSellers(sellers) {
  if (!Array.isArray(sellers) || sellers.length === 0) {
    return {
      seller_count: 0,
      min_price: null,
      max_price: null,
      price_spread_pct: null,
      official_sellers: [],
      all_prices: [],
    };
  }
  const valid = sellers.filter((s) => typeof s.price === 'number');
  const prices = valid.map((s) => s.price);
  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  const spreadPct =
    min && max && min > 0 ? Number((((max - min) / min) * 100).toFixed(2)) : null;
  const officialSellers = valid
    .filter((s) => s.official_store_id)
    .map((s) => ({
      seller_id: s.seller_id,
      official_store_id: s.official_store_id,
      price: s.price,
    }));
  const sorted = [...valid].sort((a, b) => a.price - b.price).slice(0, 5);
  return {
    seller_count: sellers.length,
    min_price: min,
    max_price: max,
    price_spread_pct: spreadPct,
    official_sellers: officialSellers,
    all_prices: sorted.map((s) => ({
      price: s.price,
      seller_id: s.seller_id,
      official_store_id: s.official_store_id ?? null,
      free_shipping: s.shipping?.free_shipping ?? null,
    })),
  };
}
