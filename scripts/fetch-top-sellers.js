#!/usr/bin/env node
/**
 * Meli Top Sellers Fetcher — Phase 1 (OAuth API)
 *
 * Pipeline:
 *   1. Refresh access_token (rotates refresh_token; persisted back)
 *   2. For each of 8 categories:
 *      - /highlights/{cat}       → ranked product IDs
 *      - /products/{pid}         → structured attributes + buy-box price
 *      - /products/{pid}/items   → multi-seller prices → real min / max / spread
 *   3. Merge with previous snapshot for price_delta + prev_rank
 *   4. Write data/daily/{date}.json + append data/history/{cat}-{slug}.jsonl
 *
 * Env (or .env.local):
 *   ML_APP_ID, ML_CLIENT_SECRET, ML_REFRESH_TOKEN (required)
 *   ML_ACCESS_TOKEN, ML_USER_ID (optional, auto-refreshed)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreshAccessToken } from './lib/ml-oauth.js';
import { MLClient, normalizeProduct, summarizeSellers } from './lib/ml-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const CONFIG_PATH = path.join(ROOT, 'config', 'categories.json');
const DAILY_DIR = path.join(ROOT, 'data', 'daily');
const HISTORY_DIR = path.join(ROOT, 'data', 'history');

const TOP_N = 20;
const CONCURRENCY = 3;

function todayISO() {
  const now = new Date();
  const brazil = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brazil.toISOString().slice(0, 10);
}

async function loadPreviousSnapshot(date) {
  try {
    const files = (await fs.readdir(DAILY_DIR))
      .filter((f) => f.endsWith('.json') && f < `${date}.json`)
      .sort();
    const prev = files[files.length - 1];
    if (!prev) return null;
    const raw = await fs.readFile(path.join(DAILY_DIR, prev), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildPrevIndex(prevSnapshot) {
  const idx = new Map();
  if (!prevSnapshot?.categories) return idx;
  for (const [catId, cat] of Object.entries(prevSnapshot.categories)) {
    for (const item of cat.items ?? []) {
      const key = item.catalog_product_id || item.item_id;
      if (key) idx.set(`${catId}:${key}`, item);
    }
  }
  return idx;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function enrichProduct(client, entry) {
  // entry: { id, position, type }
  if (entry.type !== 'PRODUCT') {
    return {
      rank: entry.position,
      catalog_product_id: null,
      item_id: entry.type === 'ITEM' ? entry.id : null,
      skipped_reason: `unsupported highlight type: ${entry.type}`,
    };
  }
  const productId = entry.id;
  const [rawProduct, sellers] = await Promise.all([
    client.getProduct(productId).catch((e) => ({ __error: e.message, __status: e.status })),
    client.getProductSellers(productId, { limit: 20 }).catch((e) => ({
      __error: e.message,
      __status: e.status,
    })),
  ]);

  const product = rawProduct?.__error ? null : normalizeProduct(rawProduct);
  const sellerArr = Array.isArray(sellers) ? sellers : [];
  const sellerSummary = summarizeSellers(sellerArr);

  return {
    rank: entry.position,
    catalog_product_id: productId,
    item_id: null,
    title: product?.name ?? null,
    brand: product?.brand ?? null,
    model: product?.model ?? null,
    line: product?.line ?? null,
    attributes: product?.attributes ?? {},
    main_features: product?.main_features ?? [],
    pictures: product?.pictures ?? [],
    permalink: product?.permalink ?? null,
    buy_box_price: product?.buy_box_price ?? sellerSummary.min_price,
    buy_box_seller_id: product?.buy_box_seller_id ?? null,
    currency: product?.buy_box_currency ?? 'BRL',
    min_price: sellerSummary.min_price,
    max_price: sellerSummary.max_price,
    price_spread_pct: sellerSummary.price_spread_pct,
    seller_count: sellerSummary.seller_count,
    official_sellers: sellerSummary.official_sellers,
    top_prices: sellerSummary.all_prices,
    _fetch_errors: [
      rawProduct?.__error && `product:${rawProduct.__status}:${rawProduct.__error}`,
      sellers?.__error && `sellers:${sellers.__status}:${sellers.__error}`,
    ].filter(Boolean),
  };
}

async function processCategory(client, cat, prevIndex) {
  console.log(`[${cat.id}] highlights...`);
  let entries = [];
  try {
    entries = await client.getHighlights(cat.id);
  } catch (err) {
    console.error(`  !! highlights failed: ${err.message}`);
    throw err;
  }
  const top = entries.slice(0, TOP_N);
  console.log(`  -> ${entries.length} entries (taking top ${top.length})`);

  const items = await mapLimit(top, CONCURRENCY, async (entry) => {
    try {
      return await enrichProduct(client, entry);
    } catch (err) {
      return {
        rank: entry.position,
        catalog_product_id: entry.id,
        skipped_reason: err.message,
      };
    }
  });

  // Join with previous day
  for (const it of items) {
    const key = it.catalog_product_id || it.item_id;
    const prev = key ? prevIndex.get(`${cat.id}:${key}`) : null;
    if (prev && typeof prev.min_price === 'number' && typeof it.min_price === 'number') {
      it.price_delta = Number((it.min_price - prev.min_price).toFixed(2));
    } else if (
      prev &&
      typeof prev.buy_box_price === 'number' &&
      typeof it.buy_box_price === 'number'
    ) {
      it.price_delta = Number((it.buy_box_price - prev.buy_box_price).toFixed(2));
    } else {
      it.price_delta = null;
    }
    it.prev_rank = prev?.rank ?? null;
  }

  const ok = items.filter((i) => !i.skipped_reason && i.title).length;
  console.log(`  ✅ enriched ${ok}/${items.length}`);
  return items;
}

async function main() {
  const configRaw = await fs.readFile(CONFIG_PATH, 'utf8');
  const config = JSON.parse(configRaw);

  await fs.mkdir(DAILY_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });

  // 1. Fresh access_token (rotates refresh_token, persists .env.local or emits workflow output)
  console.log('→ Refreshing access_token...');
  const fresh = await getFreshAccessToken(ROOT);
  console.log(
    `  ok (expires_in=${fresh.expiresIn}s, scope=${(fresh.scope ?? '').slice(0, 40)}...)`,
  );

  const client = new MLClient({ accessToken: fresh.accessToken });

  const date = todayISO();
  const prevSnapshot = await loadPreviousSnapshot(date);
  const prevIndex = buildPrevIndex(prevSnapshot);
  console.log(
    prevSnapshot
      ? `Using previous snapshot ${prevSnapshot.date} for delta.`
      : 'No previous snapshot; price_delta will be null.',
  );

  const snapshot = {
    date,
    fetched_at: new Date().toISOString(),
    source: 'mercadolivre-oauth-api',
    oauth: true,
    schema_version: 2,
    note:
      'Phase 1 OAuth pipeline: /highlights + /products + /products/{id}/items. ' +
      'Includes catalog multi-seller real min/max prices.',
    categories: {},
  };

  for (const cat of config.categories) {
    console.log(`\n=== ${cat.id} · ${cat.name_zh} (${cat.name_pt}) ===`);
    try {
      const items = await processCategory(client, cat, prevIndex);
      snapshot.categories[cat.id] = {
        category_id: cat.id,
        slug: cat.slug,
        category_name_pt: cat.name_pt,
        category_name_zh: cat.name_zh,
        mais_vendidos_url: cat.mais_vendidos_url,
        item_count: items.length,
        items,
      };
    } catch (err) {
      console.error(`  !! category ${cat.id} failed: ${err.message}`);
      snapshot.categories[cat.id] = {
        category_id: cat.id,
        slug: cat.slug,
        category_name_pt: cat.name_pt,
        category_name_zh: cat.name_zh,
        error: err.message,
        item_count: 0,
        items: [],
      };
    }
  }

  const totalItems = Object.values(snapshot.categories).reduce(
    (sum, c) => sum + (c.item_count ?? 0),
    0,
  );
  if (totalItems === 0) {
    console.error('\n!! All categories returned 0 items. Refusing to write empty snapshot.');
    process.exit(2);
  }

  // Write daily snapshot
  const dailyPath = path.join(DAILY_DIR, `${date}.json`);
  await fs.writeFile(dailyPath, JSON.stringify(snapshot, null, 2));
  console.log(`\nWrote ${dailyPath}`);

  // Append per-category history JSONL (slim)
  for (const [catId, cat] of Object.entries(snapshot.categories)) {
    const slim = {
      date,
      items: (cat.items ?? []).map((it) => ({
        rank: it.rank,
        catalog_product_id: it.catalog_product_id,
        brand: it.brand,
        model: it.model,
        title: it.title,
        buy_box_price: it.buy_box_price,
        min_price: it.min_price,
        max_price: it.max_price,
        price_spread_pct: it.price_spread_pct,
        seller_count: it.seller_count,
        price_delta: it.price_delta,
        prev_rank: it.prev_rank,
      })),
    };
    const slug = cat.slug ?? 'unknown';
    const jsonlPath = path.join(HISTORY_DIR, `${catId}-${slug}.jsonl`);
    await fs.appendFile(jsonlPath, JSON.stringify(slim) + '\n');
  }
  console.log(`Appended history for ${Object.keys(snapshot.categories).length} categories.`);

  // Summary
  console.log('\n=== Summary ===');
  for (const [catId, cat] of Object.entries(snapshot.categories)) {
    const enriched = (cat.items ?? []).filter((i) => i.title).length;
    const withSellers = (cat.items ?? []).filter((i) => i.seller_count > 1).length;
    console.log(
      `  ${catId.padEnd(12)} enriched=${enriched}/${cat.item_count}  multi-seller=${withSellers}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
