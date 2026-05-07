#!/usr/bin/env node
/**
 * Meli 15-day Top 5 Report Generator
 *
 * Reads `data/history/{cat}-{slug}.jsonl` (one line per day, schema v2)
 * and emits an HTML fragment with one table per category:
 *   rows = #1..#5 ranks
 *   cols = last 15 days (left = 15 days ago, right = today)
 *   cells = brand-colored background filled with "Brand Model + R$ price"
 *
 * Email-safe HTML: <td bgcolor="..."> + inline style + small font-size,
 * compatible with Gmail / Apple Mail / iOS Mail / Outlook.
 *
 * Usage:
 *   node generate-report.js --out /tmp/meli-15d-report.html
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const HISTORY_DIR = path.join(ROOT, 'data', 'history');
const CATEGORIES_PATH = path.join(ROOT, 'config', 'categories.json');

const WINDOW_DAYS = 15;
const TOP_N = 5;

const CATEGORY_ORDER = [
  'MLB1055',     // 手机（纯手机）
  'MLB135384',   // 智能手表（纯手表）
  'MLB196208',   // 耳机（音频）
  'MLB99889',    // 平板（纯平板）
  'MLB1051',     // 手机大类
  'MLB417704',   // 智能穿戴大类
  'MLB1664',     // 耳机 Gaming
  'MLB91757',    // 平板大类
];

// 品牌 → { 浅色填充背景, 中文名展示, 标记色 emoji（仅图例用）}
const BRAND_STYLE = {
  huawei:    { bg: '#f4cccc', label: 'Huawei',   chip: '🟥' },
  honor:     { bg: '#fff2cc', label: 'Honor',    chip: '🟨' },
  samsung:   { bg: '#cfe2f3', label: 'Samsung',  chip: '🟦' },
  motorola:  { bg: '#fce5cd', label: 'Motorola', chip: '🟧' },
  xiaomi:    { bg: '#d9ead3', label: 'Xiaomi',   chip: '🟩' },
  mi:        { bg: '#d9ead3', label: 'Xiaomi',   chip: '🟩' },
  redmi:     { bg: '#d9ead3', label: 'Xiaomi',   chip: '🟩' },
  poco:      { bg: '#d9ead3', label: 'Xiaomi',   chip: '🟩' },
  apple:     { bg: '#d9d2e9', label: 'Apple',    chip: '🟪' },
  realme:    { bg: '#ead1dc', label: 'Realme',   chip: '🟫' },
  jbl:       { bg: '#d9d9d9', label: 'JBL',      chip: '⬛' },
  soundcore: { bg: '#d9d9d9', label: 'Soundcore',chip: '⬛' },
  anker:     { bg: '#d9d9d9', label: 'Anker',    chip: '⬛' },
  amazfit:   { bg: '#d9d9d9', label: 'Amazfit',  chip: '⬛' },
  garmin:    { bg: '#d9d9d9', label: 'Garmin',   chip: '⬛' },
  sony:      { bg: '#d9d9d9', label: 'Sony',     chip: '⬛' },
  bose:      { bg: '#d9d9d9', label: 'Bose',     chip: '⬛' },
  logitech:  { bg: '#d9d9d9', label: 'Logitech', chip: '⬛' },
  edifier:   { bg: '#d9d9d9', label: 'Edifier',  chip: '⬛' },
};
const DEFAULT_STYLE = { bg: '#ffffff', label: 'Other', chip: '⬜' };

function styleFor(brand) {
  if (!brand) return DEFAULT_STYLE;
  return BRAND_STYLE[brand.toLowerCase()] ?? DEFAULT_STYLE;
}

function shortName(it) {
  const brand = it.brand ?? '';
  const tail = (it.line ?? it.model ?? '').trim();
  let s;
  if (tail.toLowerCase().startsWith(brand.toLowerCase()) && brand) {
    s = tail;
  } else {
    s = [brand, tail].filter(Boolean).join(' ').trim();
  }
  if (!s) return (it.title ?? '').slice(0, 22);
  return s.length > 22 ? s.slice(0, 22) : s;
}

function fmtPriceBR(p) {
  if (p == null) return '—';
  return 'R$ ' + Math.round(p).toLocaleString('de-DE');
}

function fmtDateMD(iso) {
  const [, m, d] = iso.split('-');
  return `${m}-${d}`;
}

function isNewSchema(line) {
  return line.items?.[0] && 'catalog_product_id' in line.items[0];
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function productUrl(it) {
  if (it.catalog_product_id) {
    return `https://www.mercadolivre.com.br/p/${it.catalog_product_id}`;
  }
  if (it.permalink) return it.permalink;
  return null;
}

async function readHistory(catId, slug) {
  const file = path.join(HISTORY_DIR, `${catId}-${slug}.jsonl`);
  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return lines.filter(isNewSchema).sort((a, b) => a.date.localeCompare(b.date));
}

function buildCategoryTable(cat, history) {
  // 取最后 15 天，左=最早，右=今天 (升序保留)
  const days = history.slice(-WINDOW_DAYS);
  if (days.length === 0) {
    return `<h2>${escapeHtml(cat.name_zh)} / ${escapeHtml(cat.name_en)}</h2>
<p><em>无 schema v2 数据可显示 / no v2 data</em></p>`;
  }

  const dateRange = `${days[0].date} → ${days[days.length - 1].date}`;
  const headerCells = days
    .map(
      (d) =>
        `<th style="padding:6px 8px;border:1px solid #ddd;background:#f5f5f5;font-weight:600;font-size:11px">${fmtDateMD(d.date)}</th>`,
    )
    .join('');

  const bodyRows = [];
  for (let rank = 1; rank <= TOP_N; rank++) {
    const tds = days
      .map((d) => {
        const it = d.items.find((x) => x.rank === rank);
        if (!it) {
          return `<td bgcolor="#ffffff" style="background-color:#ffffff;padding:6px 8px;border:1px solid #ddd;font-size:11px;color:#999">—</td>`;
        }
        const style = styleFor(it.brand);
        const name = escapeHtml(shortName(it));
        const price = escapeHtml(fmtPriceBR(it.min_price));
        const url = productUrl(it);
        const inner = `<strong>${name}</strong><br>${price}`;
        const linked = url
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:#222;text-decoration:none;display:block">${inner}</a>`
          : inner;
        return `<td bgcolor="${style.bg}" style="background-color:${style.bg};padding:6px 8px;border:1px solid #ddd;font-size:11px;color:#222;white-space:nowrap">${linked}</td>`;
      })
      .join('');
    bodyRows.push(
      `<tr><td style="padding:6px 8px;border:1px solid #ddd;background:#f5f5f5;font-weight:600;font-size:11px">#${rank}</td>${tds}</tr>`,
    );
  }

  return `
<h2 style="margin-top:24px;margin-bottom:4px;font-size:18px">${escapeHtml(cat.name_zh)} / ${escapeHtml(cat.name_en)}</h2>
<p style="margin:0 0 8px;color:#666;font-size:12px"><em>Source ${escapeHtml(cat.id)} · ${days.length} days (${dateRange}) · 价格 = catalog <code>min_price</code></em></p>
<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:11px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif">
  <thead>
    <tr>
      <th style="padding:6px 8px;border:1px solid #ddd;background:#f5f5f5;font-weight:600;font-size:11px">Rank \\ Date</th>
      ${headerCells}
    </tr>
  </thead>
  <tbody>
    ${bodyRows.join('\n    ')}
  </tbody>
</table>
`.trim();
}

function buildLegend() {
  const seen = new Set();
  const chips = [];
  for (const [, style] of Object.entries(BRAND_STYLE)) {
    if (seen.has(style.label)) continue;
    seen.add(style.label);
    chips.push(
      `<span bgcolor="${style.bg}" style="display:inline-block;background-color:${style.bg};padding:2px 8px;margin:2px;border:1px solid #ccc;border-radius:3px;font-size:11px">${style.chip} ${style.label}</span>`,
    );
  }
  chips.push(
    `<span style="display:inline-block;background-color:#ffffff;padding:2px 8px;margin:2px;border:1px solid #ccc;border-radius:3px;font-size:11px">⬜ 其他/Other</span>`,
  );
  return chips.join(' ');
}

function buildPreface(latestDate) {
  return `
<h1 style="margin:0 0 8px;font-size:22px">📊 Meli 15日 Top 5 榜单 / 15-Day Top 5 Leaderboard</h1>
<p style="margin:4px 0;color:#444;font-size:13px"><strong>截至 / As of</strong>: ${escapeHtml(latestDate)} · 巴西时间 Brazil time</p>
<p style="margin:4px 0;color:#444;font-size:13px"><strong>数据源 / Source</strong>: Mercado Livre OAuth API (<code>/highlights</code> + <code>/products</code> + <code>/items</code>)</p>
<p style="margin:4px 0;color:#444;font-size:13px"><strong>价格字段 / Price field</strong>: <code>min_price</code> — catalog 下多卖家真实最低价 / catalog multi-seller real lowest price</p>
<p style="margin:8px 0 4px;color:#444;font-size:13px"><strong>品牌色块图例 / Brand color legend</strong>:</p>
<p style="margin:0 0 12px">${buildLegend()}</p>
<hr style="border:none;border-top:1px solid #eee;margin:16px 0">
`.trim();
}

function buildFooter() {
  return `
<hr style="border:none;border-top:1px solid #eee;margin-top:32px">
<p style="color:#999;font-size:11px;margin-top:8px">
  自动生成 / Auto-generated by GitHub Actions · 每天巴西时间 7:30 抓取 · 8:00 前送达<br>
  Repo: <a href="https://github.com/HuijieL/meli-price-tracker" style="color:#0064d2">HuijieL/meli-price-tracker</a> · 设计 Design by Ben LI Huijie
</p>
`.trim();
}

function parseArgs(argv) {
  const args = { out: '/tmp/meli-15d-report.html' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catsRaw = JSON.parse(await fs.readFile(CATEGORIES_PATH, 'utf8'));
  const catsById = Object.fromEntries(catsRaw.categories.map((c) => [c.id, c]));

  const sections = [];
  let latestDate = '';

  for (const catId of CATEGORY_ORDER) {
    const cat = catsById[catId];
    if (!cat) continue;
    const history = await readHistory(cat.id, cat.slug);
    if (history.length > 0) {
      const lastDate = history[history.length - 1].date;
      if (lastDate > latestDate) latestDate = lastDate;
    }
    sections.push(buildCategoryTable(cat, history));
  }

  const html = [
    buildPreface(latestDate || '—'),
    sections.join('\n'),
    buildFooter(),
  ].join('\n');

  await fs.writeFile(args.out, html, 'utf8');
  console.log(`✅ Wrote ${args.out} (${html.length} bytes, ${sections.length} categories)`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { buildCategoryTable, styleFor, shortName, fmtPriceBR };
