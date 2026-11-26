#!/usr/bin/env node
/**
 * Diagnostic: which ML endpoints still return prices?
 * Since 2026-11-23 /products/{id}/items returns 403 PolicyAgent UNAUTHORIZED.
 * Run via .github/workflows/probe-prices.yml (refreshes + rotates the token like the daily job).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreshAccessToken } from './lib/ml-oauth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { accessToken } = await getFreshAccessToken(ROOT);

async function hit(p) {
  const res = await fetch(`https://api.mercadolibre.com${p}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  console.log(`\n== ${res.status} ${p}\n${text.slice(0, 700)}`);
  try { return JSON.parse(text); } catch { return null; }
}

const hl = await hit('/highlights/MLB/category/MLB1055');
const pids = (hl?.content ?? []).filter((e) => e.type === 'PRODUCT').slice(0, 2).map((e) => e.id);
const iids = (hl?.content ?? []).filter((e) => e.type === 'ITEM').slice(0, 2).map((e) => e.id);
console.log('highlight types:', [...new Set((hl?.content ?? []).map((e) => e.type))], 'item ids:', iids);

for (const p of pids) {
  const prod = await hit(`/products/${p}`);
  console.log('buy_box_winner:', JSON.stringify(prod?.buy_box_winner), 'keys:', Object.keys(prod ?? {}).join(','));
  await hit(`/products/${p}/items`);
  await hit(`/products/${p}/items?limit=5&offset=0`);
  await hit(`/sites/MLB/search?product_id=${p}`);
  const bbItem = prod?.buy_box_winner?.item_id;
  if (bbItem) iids.push(bbItem);
}
await hit('/sites/MLB/search?q=galaxy%20a17&limit=2');
await hit('/products/search?site_id=MLB&q=galaxy%20a17&status=active&limit=2');
for (const i of iids.slice(0, 3)) {
  await hit(`/items/${i}`);
  await hit(`/items?ids=${i}&attributes=id,price,status`);
  await hit(`/items/${i}/sale_price`);
  await hit(`/items/${i}/prices`);
}
