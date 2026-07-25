#!/usr/bin/env node
/**
 * 把每日 Mais Vendidos 排行榜推到 Telegram「排行榜」频道，一个品类一条消息。
 *
 * 与 deliver.js（Resend 邮件 + generate-report.js 的 15 天网格）并行，互不依赖。
 * 邮件那份是 15 天 × Top5 的**横向宽表**，Telegram 没有 table 标签，硬转会稀烂。
 * 所以这里换一个 Telegram 原生形态：**今日 Top 20 纵向列表 + 排名/价格变化箭头**。
 * 想看 15 天趋势仍然看邮件 —— 两个通道各自承担擅长的表达。
 *
 * 品类取舍：默认只推 4 个**纯品类**（手机/手表/耳机/平板）。
 * 遵守 CLAUDE.md 的「写报告时以纯品类为主，大类作为补充」——
 * 大类含配件、噪音大，要看加 --include-parent。
 *
 * 用法：
 *   node scripts/deliver-telegram.js              # 4 个纯品类
 *   node scripts/deliver-telegram.js --dry        # 打印不发
 *   node scripts/deliver-telegram.js --include-parent   # 连大类一起推（8 条）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTelegram, escapeTg, fmtBR, fmtPct } from './lib/telegram.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DAILY_DIR = path.join(ROOT, 'data', 'daily');

/* ---------- env / args ---------- */

async function loadEnvLocal() {
  try {
    const raw = await fs.readFile(path.join(ROOT, '.env.local'), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry') a.dry = true;
    else if (argv[i] === '--date') a.date = argv[++i];
    else if (argv[i] === '--chat') a.chat = argv[++i];
    else if (argv[i] === '--include-parent') a.includeParent = true;
    else if (argv[i] === '--top') a.top = Number(argv[++i]);
  }
  return a;
}

/* ---------- 品类 ---------- */

// 纯品类优先（CLAUDE.md 约定）；大类默认不推
const PURE_CATEGORIES = ['MLB1055', 'MLB135384', 'MLB196208', 'MLB99889'];
const PARENT_CATEGORIES = ['MLB1051', 'MLB417704', 'MLB1664', 'MLB91757'];

const CAT_EMOJI = {
  MLB1055: '📱', MLB1051: '📱',
  MLB135384: '⌚', MLB417704: '⌚',
  MLB196208: '🎧', MLB1664: '🎧',
  MLB99889: '📲', MLB91757: '📲',
};

/* ---------- 渲染 ---------- */

const permalinkOf = (it) => it.permalink
  || `https://www.mercadolivre.com.br/p/${it.catalog_product_id}`;

// 标题去掉葡语 boilerplate 前缀，保留品牌 + 型号 + 关键规格
function shortTitle(t) {
  if (!t) return '';
  let s = t.replace(
    /^(Celular|Smartphone|Tablet|Smartwatch|Smartband|Fone(s)?( de| sem)? (ouvido(s)?|fio)?( sem fio)?|Rel[óo]gio( Smartwatch| inteligente)?|Relogio|Caixa De Som)\s+/i,
    '',
  );
  if (s.length > 50) s = s.slice(0, 47) + '…';
  return s;
}

/** 排名变化：▲ 上升 / ▼ 下降 / 🆕 新进榜 / — 持平 */
function rankMark(it) {
  if (it.prev_rank == null) return '🆕';
  const d = it.prev_rank - it.rank;      // 正数 = 名次上升
  if (d === 0) return '—';
  return d > 0 ? `▲${d}` : `▼${-d}`;
}

/** 价格变化（对昨日 min_price） */
function priceMark(it) {
  if (it.price_delta == null || it.price_delta === 0) return '';
  const pct = it.min_price && it.price_delta
    ? (it.price_delta / (it.min_price - it.price_delta)) * 100
    : null;
  const emoji = it.price_delta < 0 ? '🟢' : '🔴';
  return pct != null
    ? ` · ${emoji} ${fmtPct(pct)}`
    : ` · ${emoji} R$ ${fmtBR(Math.abs(it.price_delta))}`;
}

function itemLine(it) {
  // Huawei 标黄以便一眼扫到自家位置。
  // Honor 是独立品牌，绝不并入 Huawei（CLAUDE.md 硬约定）。
  const isHuawei = (it.brand || '').toLowerCase() === 'huawei';
  const flag = isHuawei ? '🔶 ' : '';
  const price = it.min_price != null ? `R$ ${fmtBR(it.min_price)}` : '—';
  // 价差恒为正，不要走 fmtPct（会加 "+" 号，"差+20.7%" 读起来像涨了 20.7%）
  const spread = it.price_spread_pct > 20
    ? ` · 🔥差 ${Number(it.price_spread_pct).toFixed(1)}%` : '';
  return `<b>${String(it.rank).padStart(2)}.</b> ${flag}<a href="${escapeTg(permalinkOf(it))}">${escapeTg(shortTitle(it.title))}</a> <i>${rankMark(it)}</i>\n`
       + `    <b>${price}</b> · ${it.seller_count ?? 0}卖家${spread}${priceMark(it)}`;
}

/* ---------- main ---------- */

async function loadSnapshot(args) {
  const files = (await fs.readdir(DAILY_DIR).catch(() => []))
    .filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`No snapshots in ${DAILY_DIR}`);
  const file = args.date ? `${args.date}.json` : files[files.length - 1];
  return JSON.parse(await fs.readFile(path.join(DAILY_DIR, file), 'utf8'));
}

async function main() {
  await loadEnvLocal();
  const args = parseArgs(process.argv);
  const snap = await loadSnapshot(args);
  const topN = args.top || 20;

  const tg = createTelegram({
    token: process.env.TG_BOT_TOKEN,
    chatId: args.chat || process.env.TG_CHAT_RANKING,
    threadId: process.env.TG_THREAD_RANKING || null,
    dry: args.dry,
  });

  const wanted = args.includeParent
    ? [...PURE_CATEGORIES, ...PARENT_CATEGORIES]
    : PURE_CATEGORIES;
  const cats = wanted
    .map((id) => snap.categories?.[id])
    .filter(Boolean);

  if (!cats.length) throw new Error(`snapshot ${snap.date} 里没有任何目标品类`);

  /* ---- 1. 概览：各品类 Huawei 上榜情况 + 品牌集中度 ---- */
  const overview = [];
  for (const c of cats) {
    const items = (c.items ?? []).slice(0, topN);
    const hw = items.filter((x) => (x.brand || '').toLowerCase() === 'huawei');
    const brands = {};
    for (const x of items) brands[x.brand || '?'] = (brands[x.brand || '?'] ?? 0) + 1;
    const top3 = Object.entries(brands).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([b, n]) => `${escapeTg(b)} ${n}`).join(' · ');
    const hwStr = hw.length
      ? `🔶 Huawei <b>${hw.length}</b> 席（#${hw.map((x) => x.rank).join(' #')}）`
      : '🔶 Huawei <b>未上榜</b>';
    overview.push(`${CAT_EMOJI[c.category_id] ?? '•'} <b>${escapeTg(c.category_name_zh)}</b>`);
    overview.push(`   ${hwStr}`);
    overview.push(`   <i>${top3}</i>`);
  }
  await tg.sendLines(`📈 <b>Mais Vendidos 排行榜</b> · ${snap.date}`, overview);

  /* ---- 2. 每品类一条 Top N ---- */
  for (const c of cats) {
    const items = (c.items ?? []).slice(0, topN);
    if (!items.length) continue;
    const ups = items.filter((x) => x.prev_rank != null && x.prev_rank > x.rank).length;
    const downs = items.filter((x) => x.prev_rank != null && x.prev_rank < x.rank).length;
    const news = items.filter((x) => x.prev_rank == null).length;
    const moves = [ups && `▲${ups}`, downs && `▼${downs}`, news && `🆕${news}`]
      .filter(Boolean).join(' ');
    const header = `${CAT_EMOJI[c.category_id] ?? '•'} <b>${escapeTg(c.category_name_zh)}</b> · ${snap.date}\n`
      + `<i>Top ${items.length}${moves ? ` · ${moves}` : ''}</i>`;
    await tg.sendLines(header, items.map(itemLine));
  }

  console.log(`✅ telegram 排行榜 ${snap.date}: ${tg.sentCount} 条消息 · ${cats.length} 品类`);
}

main().catch((err) => { console.error('\n✗', err.message); process.exit(1); });
