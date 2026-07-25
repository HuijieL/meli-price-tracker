#!/usr/bin/env node
/**
 * Telegram Bot API 发送层（无依赖，Node 20+ 原生 fetch）。
 *
 * 为什么不用 node-telegram-bot-api：只需要 sendMessage / sendDocument 两个端点，
 * 一个 npm 依赖不值得。CI 里少装一个包 = 少一个供应链面。
 *
 * 关键约束（踩过才知道）：
 *   - 单条消息 4096 字符上限（entities 解析后计数，HTML 标签不算）。
 *     保险起见按原始串长 3500 切分 —— 中文占 1 个 code unit，标签占位算进去还有余量。
 *   - 群 / 频道限流 20 条/分钟。默认每条之间 sleep 1.2s，另外识别 429 的
 *     parameters.retry_after 主动退避重试。
 *   - parse_mode=HTML 只认 b/i/u/s/a/code/pre/blockquote/tg-spoiler，
 *     其余标签会直接报 400。正文里的 & < > 必须 escape（escapeTg）。
 *
 * 用法：
 *   const tg = createTelegram({ token, chatId });
 *   await tg.send('<b>标题</b>\n正文');
 *   await tg.sendLines('<b>标题</b>', ['行1', '行2', ...]);   // 自动分页
 */

const API = 'https://api.telegram.org';

/** Telegram HTML parse_mode 只需要 escape 这三个字符 */
export const escapeTg = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 巴西价格格式：R$ 1.099,00（千位点、小数逗号） */
export const fmtBR = (n) => (n == null || Number.isNaN(n)) ? '—'
  : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtPct = (n) => n == null ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(1)}%`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 单条消息安全长度。硬上限 4096 是「entities 解析后」的字符数 —— HTML 标签
 * 本身不计入，所以按原始串长卡 3900 已经很保守（一行 <a href> 就有 ~60 字符
 * markup 不算数）。留 196 给续页后缀。
 */
const MAX_CHARS = 3900;
/** 群/频道 20 条/分钟 → 1.2s 间隔留足冗余 */
const SEND_INTERVAL_MS = 1200;

export function createTelegram({ token, chatId, threadId = null, dry = false } = {}) {
  if (!dry && !token) throw new Error('TG_BOT_TOKEN missing');
  if (!dry && !chatId) throw new Error('telegram chat id missing');

  let sentCount = 0;

  async function call(method, payload, { attempt = 0 } = {}) {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));

    if (body.ok) return body.result;

    // 429：按 Telegram 指定的 retry_after 退避
    if (res.status === 429 && attempt < 3) {
      const wait = ((body.parameters?.retry_after ?? 5) + 1) * 1000;
      console.warn(`  ⏳ 429 限流，${wait / 1000}s 后重试 (${attempt + 1}/3)`);
      await sleep(wait);
      return call(method, payload, { attempt: attempt + 1 });
    }
    // 5xx：网络抖动，短退避
    if (res.status >= 500 && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      return call(method, payload, { attempt: attempt + 1 });
    }
    throw new Error(`telegram ${method} ${res.status}: ${body.description ?? JSON.stringify(body)}`);
  }

  /** 发一条消息（不分页 —— 调用方保证长度）。 */
  async function send(text, { buttons, preview = false } = {}) {
    if (dry) {
      console.log(`\n──────── [dry] message #${++sentCount} (${text.length} chars) ────────`);
      console.log(text);
      return { message_id: -1 };
    }
    if (sentCount > 0) await sleep(SEND_INTERVAL_MS);
    sentCount++;
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: !preview },
    };
    if (threadId) payload.message_thread_id = Number(threadId);
    if (buttons) payload.reply_markup = { inline_keyboard: buttons };
    return call('sendMessage', payload);
  }

  /** 贪心装箱：行不拆断，超 limit 就换页 */
  function packPages(header, lines, limit) {
    const pages = [];
    let cur = [];
    let len = header.length;
    for (const line of lines) {
      if (cur.length && len + line.length + 1 > limit) {
        pages.push(cur);
        cur = [];
        len = header.length;
      }
      cur.push(line);
      len += line.length + 1;
    }
    if (cur.length) pages.push(cur);
    return pages.length ? pages : [[]];
  }

  /**
   * 标题 + 若干行 → 自动分页发送。
   * 续页标题加 (2/3) 后缀，方便手机上确认没漏。
   *
   * 纯贪心会切出「3512 字 + 60 字」这种尾页（最后一行刚好溢出）。
   * 所以先用 MAX_CHARS 贪心求出**最少页数** n，再按 总长/n 重新装箱把内容摊平。
   * 摊平后页数可能因为行粒度变多，那就退回贪心结果 —— 页数优先于美观。
   */
  async function sendLines(header, lines, opts = {}) {
    let pages = packPages(header, lines, MAX_CHARS);
    if (pages.length > 1) {
      const n = pages.length;
      const linesTotal = lines.reduce((s, l) => s + l.length + 1, 0);
      const even = header.length + linesTotal / n;
      // 理想均分值按行粒度往往差一点就多切一页 —— 逐步放松直到页数回到 n
      for (let slack = 1.0; slack <= 1.5; slack += 0.05) {
        const limit = Math.min(MAX_CHARS, Math.ceil(even * slack));
        const balanced = packPages(header, lines, limit);
        if (balanced.length <= n) { pages = balanced; break; }
      }
    }

    const results = [];
    for (let i = 0; i < pages.length; i++) {
      const suffix = pages.length > 1 ? ` <i>(${i + 1}/${pages.length})</i>` : '';
      results.push(await send([header + suffix, '', ...pages[i]].join('\n'), opts));
    }
    return results;
  }

  /** 发文件（完整 HTML 明细当附件）。用 multipart，不走 JSON。 */
  async function sendDocument(filename, content, caption = '') {
    if (dry) {
      console.log(`\n[dry] would attach ${filename} (${content.length} bytes) caption="${caption}"`);
      return { message_id: -1 };
    }
    if (sentCount > 0) await sleep(SEND_INTERVAL_MS);
    sentCount++;
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (threadId) form.append('message_thread_id', String(threadId));
    if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
    form.append('document', new Blob([content], { type: 'text/html' }), filename);
    const res = await fetch(`${API}/bot${token}/sendDocument`, { method: 'POST', body: form });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(`telegram sendDocument ${res.status}: ${body.description}`);
    return body.result;
  }

  return { send, sendLines, sendDocument, get sentCount() { return sentCount; } };
}
