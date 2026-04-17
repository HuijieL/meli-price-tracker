#!/usr/bin/env node
/**
 * Meli Daily Digest Emailer — Phase 1 (OAuth, catalog multi-seller)
 *
 * Per category: Top 10 with brand/model, structured attributes (memory/color/screen),
 * buy-box price, real MIN price across sellers, seller count, spread %,
 * price delta vs previous day, Huawei rows highlighted.
 *
 * Env:
 *   RESEND_API_KEY — Resend API key (required)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Resend } from 'resend';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const DAILY_DIR = path.join(ROOT, 'data', 'daily');
const TO = ['lihuijie129@gmail.com'];
const FROM = 'Meli Tracker <onboarding@resend.dev>';

const SPREAD_WARN_THRESHOLD = 20; // price spread % flagged as "price war"

function brl(n) {
  if (n == null || Number.isNaN(Number(n))) return '-';
  return Number(n).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadLatestTwoSnapshots() {
  const files = (await fs.readdir(DAILY_DIR))
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`No daily snapshots found in ${DAILY_DIR}`);
  const latestFile = files[files.length - 1];
  const prevFile = files.length >= 2 ? files[files.length - 2] : null;
  const latest = JSON.parse(await fs.readFile(path.join(DAILY_DIR, latestFile), 'utf8'));
  const prev = prevFile
    ? JSON.parse(await fs.readFile(path.join(DAILY_DIR, prevFile), 'utf8'))
    : null;
  return { latest, prev };
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

function priceChangeCell(current, prev) {
  if (!prev) return '<span style="color:#0a7f2e;font-weight:600">🆕 新上榜</span>';
  const prevPrice = prev.min_price ?? prev.buy_box_price;
  if (current == null || prevPrice == null) return '<span style="color:#999">→ —</span>';
  const delta = current - prevPrice;
  if (Math.abs(delta) < 0.01) return '<span style="color:#666">→ 持平</span>';
  const pct = prevPrice ? (delta / prevPrice) * 100 : 0;
  if (delta > 0) {
    return `<span style="color:#b00020">↑ +${brl(delta)} (${pct.toFixed(1)}%)</span>`;
  }
  return `<span style="color:#0a7f2e">↓ ${brl(delta)} (${pct.toFixed(1)}%)</span>`;
}

function rankChangeBadge(currentRank, prev) {
  if (!prev) return '';
  const prevRank = prev.rank;
  if (prevRank == null) return '';
  const diff = prevRank - currentRank;
  if (diff === 0) return '';
  if (diff > 0) return `<span style="color:#0a7f2e;font-size:11px">↑${diff}</span>`;
  return `<span style="color:#b00020;font-size:11px">↓${-diff}</span>`;
}

function formatAttrs(attrs) {
  if (!attrs) return '';
  const parts = [];
  if (attrs.INTERNAL_MEMORY) parts.push(attrs.INTERNAL_MEMORY);
  if (attrs.RAM_MEMORY) parts.push(`RAM ${attrs.RAM_MEMORY}`);
  if (attrs.DISPLAY_SIZE) parts.push(attrs.DISPLAY_SIZE);
  if (attrs.COLOR) parts.push(attrs.COLOR);
  return parts.slice(0, 4).join(' · ');
}

function spreadCell(pct, sellerCount) {
  if (pct == null || sellerCount < 2) return '<span style="color:#999">-</span>';
  const hot = pct >= SPREAD_WARN_THRESHOLD;
  const color = hot ? '#b00020' : '#666';
  const icon = hot ? '🔥 ' : '';
  return `<span style="color:${color}">${icon}${pct.toFixed(1)}% · ${sellerCount}家</span>`;
}

function isHuawei(brand) {
  return brand && /huawei/i.test(brand);
}

function renderItemRow(catId, it, prev) {
  const highlight = isHuawei(it.brand) ? 'background:#fff7e6;' : '';
  const rankBadge = rankChangeBadge(it.rank, prev);
  const attrLine = formatAttrs(it.attributes);
  const minPrice = brl(it.min_price);
  const buyBox = it.buy_box_price != null && it.buy_box_price !== it.min_price
    ? `<div style="color:#999;font-size:11px">buy box ${brl(it.buy_box_price)}</div>`
    : '';
  const change = priceChangeCell(it.min_price ?? it.buy_box_price, prev);
  const spread = spreadCell(it.price_spread_pct, it.seller_count ?? 0);
  const titleShort = escapeHtml((it.title ?? '').slice(0, 65));
  const link = escapeHtml(it.permalink ?? '#');
  return `
    <tr style="${highlight}">
      <td style="padding:8px;text-align:center;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums">
        <div style="font-weight:600">${it.rank}</div>
        <div>${rankBadge}</div>
      </td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-weight:600">${escapeHtml(it.brand ?? '-')}${
        isHuawei(it.brand) ? ' <span style="color:#b00020">★</span>' : ''
      }</td>
      <td style="padding:8px;border-bottom:1px solid #eee">
        <div><a href="${link}" style="color:#0064d2;text-decoration:none">${titleShort}</a></div>
        <div style="color:#666;font-size:11px">${escapeHtml(attrLine)}</div>
      </td>
      <td style="padding:8px;text-align:right;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums">
        <div style="font-weight:600">${minPrice}</div>
        ${buyBox}
      </td>
      <td style="padding:8px;text-align:right;border-bottom:1px solid #eee;font-size:12px">${spread}</td>
      <td style="padding:8px;text-align:right;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums">${change}</td>
    </tr>`;
}

function renderCategoryTable(catId, cat, prevIndex) {
  const top = (cat.items ?? []).slice(0, 10);
  if (top.length === 0) {
    return `<h3 style="margin:24px 0 8px">${escapeHtml(cat.category_name_zh ?? catId)} <span style="color:#999;font-weight:400;font-size:13px">(${escapeHtml(catId)})</span></h3><p style="color:#999">无数据${cat.error ? '：' + escapeHtml(cat.error) : ''}</p>`;
  }
  const rows = top
    .map((it) => {
      const key = it.catalog_product_id || it.item_id;
      const prev = key ? prevIndex.get(`${catId}:${key}`) : null;
      return renderItemRow(catId, it, prev);
    })
    .join('');
  const huaweiCount = top.filter((it) => isHuawei(it.brand)).length;
  const huaweiBadge = huaweiCount
    ? `<span style="color:#b00020;font-size:12px;margin-left:8px">★ Huawei ×${huaweiCount}</span>`
    : '';
  return `
    <h3 style="margin:32px 0 8px;font-size:16px">${escapeHtml(cat.category_name_zh ?? catId)}
      <span style="color:#999;font-weight:400;font-size:13px">(${escapeHtml(catId)} · ${escapeHtml(cat.category_name_pt ?? '')})</span>
      ${huaweiBadge}
    </h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="padding:8px;text-align:center;border-bottom:2px solid #ddd;width:50px">#</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd;width:90px">品牌</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd">产品 · 配置</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;width:110px">最低价 / buy box</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;width:110px">价差 · 卖家</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;width:130px">较昨日</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderHuaweiDashboard(latest) {
  const rows = [];
  for (const [catId, cat] of Object.entries(latest.categories ?? {})) {
    for (const it of cat.items ?? []) {
      if (isHuawei(it.brand)) {
        rows.push({ catId, catName: cat.category_name_zh, item: it });
      }
    }
  }
  if (rows.length === 0) {
    return `<div style="margin:16px 0;padding:12px;background:#fff7e6;border-left:4px solid #faad14;color:#8c4a00">
      ⚠️ <strong>今日无 Huawei 产品上榜 Top 20</strong> — 所有 8 个品类排行均未见 Huawei 产品。
    </div>`;
  }
  const rowHtml = rows
    .map(
      (r) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${escapeHtml(r.catName)}</td>
      <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee;font-weight:600">#${r.item.rank}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-weight:600">${escapeHtml(r.item.brand)} ${escapeHtml(r.item.model ?? '')}</td>
      <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums">${brl(r.item.min_price)}</td>
      <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;font-size:12px;color:#666">${r.item.seller_count ?? 0} 家 · ${r.item.price_spread_pct ? r.item.price_spread_pct.toFixed(1) + '%' : '-'}</td>
    </tr>`,
    )
    .join('');
  return `
    <div style="margin:16px 0 24px;padding:12px;background:#fff7e6;border-left:4px solid #b00020;border-radius:4px">
      <strong style="color:#b00020">★ Huawei 产品状态 (${rows.length} 个上榜)</strong>
      <table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:12px">
        <tbody>${rowHtml}</tbody>
      </table>
    </div>`;
}

function renderEmail(latest, prev) {
  const prevIndex = buildPrevIndex(prev);
  const cats = Object.entries(latest.categories ?? {});
  const tables = cats.map(([id, c]) => renderCategoryTable(id, c, prevIndex)).join('\n');
  const huaweiDashboard = renderHuaweiDashboard(latest);
  const prevNote = prev
    ? `对比基准：<strong>${escapeHtml(prev.date)}</strong>`
    : '首日运行，暂无对比基准';
  const schemaBadge = latest.oauth
    ? '<span style="background:#0a7f2e;color:#fff;font-size:10px;padding:2px 6px;border-radius:3px">OAuth · catalog</span>'
    : '<span style="background:#faad14;color:#fff;font-size:10px;padding:2px 6px;border-radius:3px">HTML scrape</span>';
  const totalItems = cats.reduce((s, [, c]) => s + (c.item_count ?? 0), 0);
  const totalHuawei = cats.reduce(
    (s, [, c]) => s + (c.items ?? []).filter((i) => isHuawei(i.brand)).length,
    0,
  );
  return `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Meli 日报 — ${escapeHtml(latest.date)}</title>
  </head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;max-width:1000px;margin:0 auto;padding:24px;color:#222;background:#fff">
    <div style="border-bottom:2px solid #0064d2;padding-bottom:12px;margin-bottom:16px">
      <h1 style="margin:0;font-size:22px">📊 Meli 日报 — ${escapeHtml(latest.date)} ${schemaBadge}</h1>
      <p style="margin:4px 0 0;color:#666;font-size:13px">
        Mercado Livre 巴西 · Mais Vendidos 排行榜 · Top 10 / 品类<br>
        抓取时间 ${escapeHtml(latest.fetched_at ?? '')} · ${prevNote}<br>
        8 品类 · ${totalItems} 商品 · 其中 Huawei ${totalHuawei} 个
      </p>
    </div>
    ${huaweiDashboard}
    ${tables}
    <p style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;color:#999;font-size:12px">
      Phase 1 · 数据源 Mercado Livre OAuth API · /highlights + /products + /products/{id}/items<br>
      🔥 = 价差 ≥ ${SPREAD_WARN_THRESHOLD}% (多卖家价格战) · ★ = Huawei 重点追踪 · buy box = 默认展示价（≠ 真实最低价）
    </p>
  </body>
</html>`;
}

export { renderEmail, loadLatestTwoSnapshots };

async function main() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY is not set; skipping email.');
    process.exit(1);
  }

  const { latest, prev } = await loadLatestTwoSnapshots();
  const html = renderEmail(latest, prev);
  const subject = `📊 Meli 日报 — ${latest.date}`;

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from: FROM,
    to: TO,
    subject,
    html,
  });

  if (error) {
    console.error('Resend error:', error);
    process.exit(1);
  }
  console.log(`Sent email id=${data?.id ?? '?'} to ${TO.join(', ')}`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
