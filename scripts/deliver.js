#!/usr/bin/env node
/**
 * Meli Daily Digest Emailer — Skill-driven mode
 *
 * Invoked by the /meli skill after Claude runs the analysis per
 * prompts/daily-self.md. Takes the analysis (markdown or HTML) and
 * sends it as a styled email via Resend.
 *
 * Usage:
 *   node deliver.js --md <path>      # analysis written as markdown
 *   node deliver.js --html <path>    # analysis written as HTML fragment
 *
 * Env (auto-loaded from ../.env.local):
 *   RESEND_API_KEY — required
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Resend } from 'resend';
import { marked } from 'marked';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const DAILY_DIR = path.join(ROOT, 'data', 'daily');
const TO = ['lihuijie129@gmail.com'];
const FROM = 'Meli Tracker <onboarding@resend.dev>';

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

async function loadLatestSnapshot() {
  const files = (await fs.readdir(DAILY_DIR))
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`No daily snapshots found in ${DAILY_DIR}`);
  const latestFile = files[files.length - 1];
  return JSON.parse(await fs.readFile(path.join(DAILY_DIR, latestFile), 'utf8'));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--md') args.md = argv[++i];
    else if (argv[i] === '--html') args.html = argv[++i];
    else if (argv[i] === '--to') args.to = argv[++i];
    else if (argv[i] === '--subject') args.subject = argv[++i];
  }
  return args;
}

async function loadAnalysis(args) {
  if (args.md) {
    const md = await fs.readFile(args.md, 'utf8');
    return marked.parse(md);
  }
  if (args.html) {
    return await fs.readFile(args.html, 'utf8');
  }
  throw new Error(
    'No analysis supplied. Pass --md <path> or --html <path>.\n' +
      'Typical flow: Claude writes analysis to /tmp/meli-analysis.md, then calls\n' +
      '  node scripts/deliver.js --md /tmp/meli-analysis.md',
  );
}

function wrapInShell(analysisHtml, latest) {
  const catCount = Object.keys(latest.categories ?? {}).length;
  const totalItems = Object.values(latest.categories ?? {}).reduce(
    (s, c) => s + (c.item_count ?? 0),
    0,
  );
  return `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Meli 日报 — ${latest.date}</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
          'PingFang SC', 'Microsoft YaHei', sans-serif;
        max-width: 900px;
        margin: 0 auto;
        padding: 24px;
        color: #222;
        background: #fff;
        line-height: 1.6;
      }
      h1, h2, h3 { line-height: 1.3; }
      h1 { font-size: 22px; margin: 0 0 8px; }
      h2 { font-size: 18px; margin: 28px 0 12px; padding-top: 8px; border-top: 1px solid #eee; }
      h3 { font-size: 15px; margin: 20px 0 8px; }
      table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 12px 0; }
      th, td { padding: 8px; border-bottom: 1px solid #eee; text-align: left; }
      th { background: #f5f5f5; border-bottom: 2px solid #ddd; }
      td { font-variant-numeric: tabular-nums; }
      code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
      blockquote { border-left: 3px solid #0064d2; margin: 12px 0; padding: 4px 12px; color: #555; background: #f9f9f9; }
      .header { border-bottom: 2px solid #0064d2; padding-bottom: 12px; margin-bottom: 16px; }
      .meta { color: #666; font-size: 13px; margin: 4px 0 0; }
      .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; color: #999; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>📊 Meli 日报 — ${latest.date}</h1>
      <p class="meta">
        Mercado Livre 巴西 · Mais Vendidos 排行榜<br>
        ${catCount} 品类 · ${totalItems} 商品 · 抓取时间 ${latest.fetched_at ?? '-'}
      </p>
    </div>
    ${analysisHtml}
    <p class="footer">
      数据源: Mercado Livre OAuth API · /highlights + /products + /products/{id}/items<br>
      分析: /meli skill · prompts/daily-self.md<br>
      <strong>Design by Ben LI Huijie</strong>
    </p>
  </body>
</html>`;
}

async function main() {
  await loadEnvLocal();

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY is not set (env or .env.local); cannot send email.');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const analysisHtml = await loadAnalysis(args);
  const latest = await loadLatestSnapshot();
  const html = wrapInShell(analysisHtml, latest);

  const subject = args.subject ?? `📊 Meli 日报 — ${latest.date}`;
  const to = args.to ? args.to.split(',').map((s) => s.trim()) : TO;

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({ from: FROM, to, subject, html });

  if (error) {
    console.error('Resend error:', error);
    process.exit(1);
  }
  console.log(`✅ Sent email id=${data?.id ?? '?'} to ${to.join(', ')} (subject: ${subject})`);
}

export { wrapInShell, loadLatestSnapshot };

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
