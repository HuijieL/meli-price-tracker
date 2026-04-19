# CLAUDE.md

本项目是 Huawei Brazil GTM 的 Mercado Livre 竞品价格追踪系统。Claude Code 在本目录工作时遵守以下约定。

## 架构（两层解耦）

```
【云端】GitHub Actions（每天 UTC 00:00 / 巴西 21:00）
  └─ OAuth 刷 token → fetch-top-sellers.js → 写 data/ → git commit + push
     ❌ 不发邮件

【本地】/meli skill（按需触发）
  └─ git pull → 读 data/daily/ → 按 prompts/daily-self.md 分析 →
     /tmp/meli-analysis.md → scripts/deliver.js 发 Resend 邮件
```

**为什么拆分**：分析逻辑要灵活迭代（改 prompt 立即生效），数据抓取要稳定不中断。两层职责解耦，互不依赖。

## 目录职责

| 路径 | 职责 | 谁可以改 |
|---|---|---|
| `scripts/fetch-top-sellers.js` | 云端抓数据（OAuth 三段式 pipeline） | 稳定，少改 |
| `scripts/deliver.js` | 本地发邮件（Resend + marked 渲染） | 偶尔改模板 |
| `scripts/lib/ml-oauth.js` | refresh_token 刷新 + 轮换持久化 | 别乱动 |
| `scripts/lib/ml-api.js` | MLClient：highlights / products / items | 别乱动 |
| `prompts/daily-self.md` | 报告结构 SSOT（改这里 `/meli` 下次立即生效） | **常改** |
| `config/categories.json` | 8 品类配置 | 改品类时 |
| `data/daily/{date}.json` | 每日快照（schema v2） | CI 写，手勿动 |
| `data/history/{cat}.jsonl` | 品类时序历史 | CI 写，手勿动 |
| `.env.local` | 本地凭证（gitignored） | 手动维护 |
| `docs/DATA.md` | 数据字段字典（权威） | 加字段时 |
| `docs/OPERATIONS.md` | 运维手册（排错 + 6 月重授权） | 踩坑后 |
| `docs/blueprint-archive.md` | 原设计稿，已归档 | 不动 |

## 追踪的 8 个品类

| ID | 名称 | Top N |
|---|---|---|
| `MLB1051` | 手机（大类，含配件） | 20 |
| `MLB1055` | 手机（纯手机） | 20 |
| `MLB417704` | 智能穿戴（大类） | 20 |
| `MLB135384` | 智能手表（纯手表） | 20 |
| `MLB1664` | 耳机（PC Gaming） | 20 |
| `MLB196208` | 耳机（音频类） | 20 |
| `MLB91757` | 平板（大类） | 20 |
| `MLB99889` | 平板（纯平板） | 20 |

写报告时**以纯品类为主**，大类作为补充。

## 数据字段速查（schema v2）

报告里用的字段（完整版见 [docs/DATA.md](docs/DATA.md)）：

| 字段 | 含义 | 用法 |
|---|---|---|
| `catalog_product_id` | ML 目录 ID（`MLB54964804`） | 跨天对比的稳定 key |
| `brand` / `model` / `line` | ML 权威字段 | 直接信任，不是启发式 |
| `buy_box_price` | 橱窗价（用户打开页面看到的） | 用户视角价 |
| **`min_price`** | **catalog 下多卖家真实最低价** | **报告默认用这个** |
| `max_price` | 多卖家最高价 | 算价差用 |
| `price_spread_pct` | `(max-min)/min*100` | `> 20%` 加 🔥（价格战信号） |
| `seller_count` | 卖家数（上限 20） | `> 1` 才有价差意义 |
| `official_sellers` | 官方店明细 | GTM 最高价值，对标用 |
| `price_delta` | `今日 min - 昨日 min`（R$） | 昨日对比 |
| `prev_rank` | 昨日 rank | 算 ↑↓ 排名变化 |

⚠️ **不再有 `brand_guess` / `sold_quantity_fuzzy`**（Phase 0 HTML 启发式字段已淘汰）。

## 必守约定

- **Honor ≠ Huawei**。Honor 是独立品牌，任何时候不要在 Huawei 分析里混入 Honor。
- **价格默认用 `min_price`**，为 null 时回退 `buy_box_price` 并在报告里标注「仅 buy box 价」。
- **`seller_count = 1`** 的商品没有价差概念，spread 为 0，别当异常。
- **全中文报告**，但商品标题保留葡语原文。
- **价格格式**：巴西格式 `R$ 1.099,00`（千位点、小数逗号）。
- **Phase 0 的 HTML 抓取已废弃**（2026-04-11 起被 Akamai bot 墙封死），不要试图回退。

## 常用命令

```bash
# 本地跑一次抓取（会轮换 refresh_token，注意同步 secret）
cd "/Users/li/Desktop/Meli- tracker/scripts" && node fetch-top-sellers.js

# 发邮件（需先准备 /tmp/meli-analysis.md）
cd "/Users/li/Desktop/Meli- tracker/scripts" && node deliver.js --md /tmp/meli-analysis.md

# 手动触发 Actions（更安全，不会导致 secret 失步）
cd "/Users/li/Desktop/Meli- tracker" && gh workflow run fetch-prices.yml && gh run watch
```

凭证同步、6 个月重授权、GH_PAT 权限 → [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 升级路线

- ✅ Phase 1：OAuth 接入（2026-04-17）
- ✅ Phase 2：Catalog 多卖家真实最低价（与 Phase 1 合并）
- ✅ Phase 2.5：CI/Skill 架构拆分（2026-04-17）
- ⏸ Phase 3：Puppeteer 截图 + R2 存证（推迟，API 数据已够）
- ⏳ Phase 4：周报 / 月报（7-30 天数据积累后）
- ⏳ Phase 5：季报 / 年度同比
