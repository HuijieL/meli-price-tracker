#!/usr/bin/env node
/**
 * Meli Top Sellers Fetcher — Phase 0 (no OAuth, HTML scrape)
 *
 * 原计划直接调用 ML public Search API，但截至 2026-04-10 ML 已关闭对
 * api.mercadolibre.com/sites/MLB/search 和 /items/{id} 的匿名访问
 * (HTTP 403 "unauthorized")。
 *
 * Phase 0 fallback：直接抓取 Mais Vendidos 页面 HTML 并解析 poly-card 组件。
 * 每个品类页面固定返回 Top 20，信息涵盖 rank / 标题 / 卖家 / 价格 / 折扣 /
 * 评分 / 官方店 / catalog_product_id / item_id / permalink。
 *
 * attributes 无法通过 HTML 获取 —— 待 Phase 1 接入 OAuth + /items/{id} 后补齐。
 *
 * 输出：
 *   - data/daily/{YYYY-MM-DD}.json      （当日完整快照）
 *   - data/history/{catId}-{slug}.jsonl （按品类追加一行）
 *
 * 每次网络请求间隔 500ms 避免限流。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const CONFIG_PATH = path.join(ROOT, 'config', 'categories.json');
const DAILY_DIR = path.join(ROOT, 'data', 'daily');
const HISTORY_DIR = path.join(ROOT, 'data', 'history');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayISO() {
  // Brazil-local day (UTC-3). Good enough for filename bucketing.
  const now = new Date();
  const brazil = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brazil.toISOString().slice(0, 10);
}

async function fetchHtml(url, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      const backoff = 1000 * (attempt + 1);
      console.warn(`  ! fetch failed (${err.message}); retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

function decodeHtmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function parsePriceFromAriaLabel(label) {
  // "Agora: 661 reais com 50 centavos" | "Antes: 899 reais" | "1.099 reais com 90 centavos"
  if (!label) return null;
  const m = label.match(/([\d.]+)\s*reais(?:\s*com\s*(\d+)\s*centavos)?/i);
  if (!m) return null;
  const reais = Number(m[1].replace(/\./g, ''));
  const cents = m[2] ? Number(m[2]) : 0;
  if (Number.isNaN(reais)) return null;
  return reais + cents / 100;
}

function firstMatch(re, str) {
  const m = str.match(re);
  return m ? m[1] : null;
}

function splitCards(html) {
  // Each Mais Vendidos card starts with <div class="poly-card poly-card--grid-card ...
  const marker = 'poly-card poly-card--grid-card';
  const cards = [];
  let idx = html.indexOf(marker);
  while (idx !== -1) {
    const next = html.indexOf(marker, idx + marker.length);
    cards.push(html.slice(idx, next === -1 ? idx + 20000 : next));
    idx = next;
  }
  return cards;
}

function parseCard(cardHtml, fallbackRank) {
  // Rank — from "Nº MAIS VENDIDO" badge
  const rank = Number(
    firstMatch(/poly-component__highlight">\s*(\d+)º MAIS VENDIDO/i, cardHtml) ?? fallbackRank,
  );

  // Title + permalink
  const titleMatch = cardHtml.match(
    /<a[^>]+href="([^"]+)"[^>]*class="poly-component__title"[^>]*>([^<]+)<\/a>/,
  );
  const permalinkRaw = titleMatch ? decodeHtmlEntities(titleMatch[1]) : null;
  const title = titleMatch ? decodeHtmlEntities(titleMatch[2]).trim() : null;

  // Strip tracking query string from permalink for cleaner storage
  const permalink = permalinkRaw ? permalinkRaw.split('#')[0].split('?')[0] : null;

  // item_id from wid= query param in the title href
  const itemId = permalinkRaw ? firstMatch(/wid=(MLB\d+)/, permalinkRaw) : null;

  // catalog_product_id from /p/MLB{id} path segment
  const catalogId = permalinkRaw ? firstMatch(/\/p\/(MLB\d+)/, permalinkRaw) : null;

  // Seller / brand hint — poly-component__seller span contains the seller name
  const sellerRaw = firstMatch(
    /<span[^>]*class="poly-component__seller"[^>]*>([^<]+)(?:<|\s*<svg)/,
    cardHtml,
  );
  const seller = sellerRaw ? decodeHtmlEntities(sellerRaw).trim() : null;

  // Official store = presence of "Loja oficial" label/svg near seller span
  const officialStore = /aria-label="Loja oficial"/.test(cardHtml);

  // Current price — prefer "Agora:" aria-label (when discounted) else first price aria-label
  let currentPriceLabel = firstMatch(
    /aria-label="(Agora:[^"]+)"/,
    cardHtml,
  );
  if (!currentPriceLabel) {
    // Fall back: the first money-amount aria-label that is NOT "Antes:"
    const labels = [...cardHtml.matchAll(/aria-label="([^"]+reais[^"]*)"/g)].map((m) => m[1]);
    currentPriceLabel = labels.find((l) => !/^Antes:/i.test(l)) ?? null;
  }
  const buyBoxPrice = parsePriceFromAriaLabel(currentPriceLabel);

  // Original price — "Antes:" aria-label
  const originalPriceLabel = firstMatch(/aria-label="(Antes:[^"]+)"/, cardHtml);
  const originalPrice = parsePriceFromAriaLabel(originalPriceLabel);

  // Rating + fuzzy sold count — "4.9 | +50mil vendidos"
  const rating = Number(
    firstMatch(/poly-phrase-label">\s*(\d+(?:\.\d+)?)\s*<\/span>/, cardHtml),
  ) || null;
  const soldQtyFuzzy = firstMatch(
    /poly-phrase-label">\s*\|\s*\+?([\d.]+\s*(?:mil|mi)?)\s*vendidos/i,
    cardHtml,
  );

  // Shipping
  const freeShipping = /Frete grátis/i.test(cardHtml);
  const fullShipping = /Enviado pelo FULL/i.test(cardHtml);

  // Discount percent
  const discountLabel = firstMatch(
    /poly-price__disc_label[^>]*>([^<]+)/,
    cardHtml,
  );
  const discountPct =
    discountLabel && /(\d+)%/.test(discountLabel) ? Number(RegExp.$1) : null;

  // Brand heuristic: look for known brand names anywhere in the title;
  // fall back to the first word. Marked "guess" because the HTML has no
  // authoritative brand attribute (that needs OAuth /items/{id}).
  const KNOWN_BRANDS = [
    'Samsung', 'Xiaomi', 'Apple', 'Motorola', 'Huawei', 'Honor', 'Realme',
    'Redmi', 'Poco', 'JBL', 'Sony', 'Edifier', 'LG', 'Lenovo', 'Multilaser',
    'Positivo', 'TCL', 'Asus', 'Acer', 'Philco', 'Amazfit', 'Xtrax',
    'Mondial', 'Philips', 'Baseus', 'Anker', 'Haylou', 'Mibro', 'QCY',
  ];
  let brandGuess = null;
  if (title) {
    const hit = KNOWN_BRANDS.find((b) => new RegExp(`\\b${b}\\b`, 'i').test(title));
    brandGuess = hit ?? title.split(/[\s,]/)[0];
  }

  return {
    rank,
    item_id: itemId,
    catalog_product_id: catalogId,
    title,
    seller,
    brand_guess: brandGuess,
    official_store: officialStore,
    buy_box_price: buyBoxPrice,
    currency: 'BRL',
    original_price: originalPrice,
    discount_pct: discountPct,
    rating,
    sold_quantity_fuzzy: soldQtyFuzzy,
    free_shipping: freeShipping,
    full_shipping: fullShipping,
    permalink,
  };
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
      if (item.item_id) idx.set(`${catId}:${item.item_id}`, item);
    }
  }
  return idx;
}

async function processCategory(cat, prevIndex, delayMs) {
  const url = cat.mais_vendidos_url;
  console.log(`[${cat.id}] GET ${url}`);
  const html = await fetchHtml(url);
  const cards = splitCards(html);
  console.log(`  parsed ${cards.length} cards`);

  const items = cards.map((c, i) => parseCard(c, i + 1));

  // Join price delta vs previous day
  for (const it of items) {
    const prev = it.item_id ? prevIndex.get(`${cat.id}:${it.item_id}`) : null;
    if (prev && typeof prev.buy_box_price === 'number' && typeof it.buy_box_price === 'number') {
      it.price_delta = Number((it.buy_box_price - prev.buy_box_price).toFixed(2));
      it.prev_rank = prev.rank ?? null;
    } else {
      it.price_delta = null;
      it.prev_rank = null;
    }
  }

  await sleep(delayMs);
  return items;
}

async function main() {
  const configRaw = await fs.readFile(CONFIG_PATH, 'utf8');
  const config = JSON.parse(configRaw);
  const fetchCfg = config.fetch ?? {};
  const delayMs = fetchCfg.request_delay_ms ?? 500;

  await fs.mkdir(DAILY_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });

  const date = todayISO();
  const prevSnapshot = await loadPreviousSnapshot(date);
  const prevIndex = buildPrevIndex(prevSnapshot);
  if (prevSnapshot) {
    console.log(`Using previous snapshot ${prevSnapshot.date} for price/rank delta.`);
  } else {
    console.log('No previous snapshot found; price_delta / prev_rank will be null.');
  }

  const snapshot = {
    date,
    fetched_at: new Date().toISOString(),
    source: 'mercadolivre-mais-vendidos-html',
    oauth: false,
    note:
      'Phase 0 MVP: HTML scrape of Mais Vendidos pages. ' +
      'ML closed anonymous access to api.mercadolibre.com; OAuth will be added in Phase 1.',
    categories: {},
  };

  for (const cat of config.categories) {
    console.log(`\n=== ${cat.id} · ${cat.name_zh} (${cat.name_pt}) ===`);
    try {
      const items = await processCategory(cat, prevIndex, delayMs);
      snapshot.categories[cat.id] = {
        category_id: cat.id,
        slug: cat.slug,
        category_name_pt: cat.name_pt,
        category_name_zh: cat.name_zh,
        mais_vendidos_url: cat.mais_vendidos_url,
        item_count: items.length,
        items,
      };
      console.log(`  -> ${items.length} items`);
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
        item_id: it.item_id,
        brand_guess: it.brand_guess,
        seller: it.seller,
        title: it.title,
        buy_box_price: it.buy_box_price,
        original_price: it.original_price,
        price_delta: it.price_delta,
        prev_rank: it.prev_rank,
      })),
    };
    const slug = cat.slug ?? 'unknown';
    const jsonlPath = path.join(HISTORY_DIR, `${catId}-${slug}.jsonl`);
    await fs.appendFile(jsonlPath, JSON.stringify(slim) + '\n');
  }
  console.log(`Appended history for ${Object.keys(snapshot.categories).length} categories.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
