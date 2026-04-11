#!/usr/bin/env node
/**
 * Meli Daily Digest Emailer — Phase 0
 *
 * 读取 data/daily/ 下最新日期的 JSON，为每个品类生成 Top 10 表格（排名、
 * 品牌、产品、价格、较昨日变化），用 Resend API 发送一封 HTML 邮件。
 *
 * 环境变量：
 *   RESEND_API_KEY — Resend API key (必需)
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

function buildPrevPriceIndex(prevSnapshot) {
  const idx = new Map();
  if (!prevSnapshot?.categories) return idx;
  for (const [catId, cat] of Object.entries(prevSnapshot.categories)) {
    for (const item of cat.items ?? []) {
      idx.set(`${catId}:${item.item_id}`, item);
    }
  }
  return idx;
}

function priceChangeCell(currentPrice, prevItem) {
  if (!prevItem) {
    return '<span style="color:#0a7f2e;font-weight:600">🆕 新上榜</span>';
  }
  const prevPrice = prevItem.buy_box_price;
  if (currentPrice == null || prevPrice == null) return '→ —';
  const delta = currentPrice - prevPrice;
  if (Math.abs(delta) < 0.005) return '<span style="color:#666">→ 持平</span>';
  const pct = prevPrice ? (delta / prevPrice) * 100 : 0;
  if (delta > 0) {
    return `<span style="color:#b00020">↑ +${brl(delta)} (${pct.toFixed(1)}%)</span>`;
  }
  return `<span style="color:#0a7f2e">↓ ${brl(delta)} (${pct.toFixed(1)}%)</span>`;
}

function renderCategoryTable(catId, cat, prevIndex) {
  const top = (cat.items ?? []).slice(0, 10);
  if (top.length === 0) {
    return `<h3 style="margin:24px 0 8px">${escapeHtml(cat.category_name_zh ?? catId)} <span style="color:#999;font-weight:400;font-size:13px">(${escapeHtml(catId)})</span></h3><p style="color:#999">无数据${cat.error ? '：' + escapeHtml(cat.error) : ''}</p>`;
  }
  const rows = top
    .map((it) => {
      const prev = prevIndex.get(`${catId}:${it.item_id}`);
      const change = priceChangeCell(it.buy_box_price, prev);
      const title = escapeHtml(it.title ?? '').slice(0, 80);
      const brand = escapeHtml(it.brand ?? '-');
      return `
      <tr>
        <td style="padding:6px 8px;text-align:center;border-bottom:1px solid #eee">${it.rank}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-weight:600">${brand}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee"><a href="${escapeHtml(it.permalink ?? '#')}" style="color:#0064d2;text-decoration:none">${title}</a></td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums">${brl(it.buy_box_price)}</td>
        <td style="padding:6px 8px;text-align:right;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums">${change}</td>
      </tr>`;
    })
    .join('');
  return `
    <h3 style="margin:28px 0 8px;font-size:16px">${escapeHtml(cat.category_name_zh ?? catId)} <span style="color:#999;font-weight:400;font-size:13px">(${escapeHtml(catId)} · ${escapeHtml(cat.category_name_pt ?? '')})</span></h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="padding:8px;text-align:center;border-bottom:2px solid #ddd;width:48px">#</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd;width:100px">品牌</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd">产品</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;width:110px">价格 (buy box)</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;width:150px">较昨日</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderEmail(latest, prev) {
  const prevIndex = buildPrevPriceIndex(prev);
  const cats = Object.entries(latest.categories ?? {});
  const tables = cats.map(([id, c]) => renderCategoryTable(id, c, prevIndex)).join('\n');
  const prevNote = prev
    ? `对比基准：<strong>${escapeHtml(prev.date)}</strong>`
    : '首日运行，暂无对比基准';
  return `<!doctype html>
<html lang="zh">
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:960px;margin:0 auto;padding:24px;color:#222;background:#fff">
    <div style="border-bottom:2px solid #0064d2;padding-bottom:12px;margin-bottom:16px">
      <h1 style="margin:0;font-size:22px">📊 Meli 日报 — ${escapeHtml(latest.date)}</h1>
      <p style="margin:4px 0 0;color:#666;font-size:13px">
        Mercado Livre 巴西 · Mais Vendidos 排行榜 · Top 10 / 品类<br>
        抓取时间 ${escapeHtml(latest.fetched_at ?? '')} · ${prevNote}
      </p>
    </div>
    ${tables}
    <p style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;color:#999;font-size:12px">
      Phase 0 MVP · 数据来自 ML public Search API（无 OAuth，仅 buy box 价格）· 后续升级加入 catalog 多卖家真实最低价
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

// Run main() only when executed directly (not when imported for testing).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
