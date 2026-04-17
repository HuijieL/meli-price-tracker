# Meli Price Tracker

巴西 Mercado Livre 品类 **Mais Vendidos** 排行榜每日抓取 + 日报邮件。
为 Huawei Brazil GTM Manager 提供竞品价格情报，驱动调价决策。

仓库：<https://github.com/HuijieL/meli-price-tracker>

## 当前状态：Phase 1 + 2 已上线 ✅（架构已拆分：云端只抓，本地做分析）

**云端（GitHub Actions，每天巴西 21:00）**：OAuth 刷 token → 8 品类 highlights + products
+ sellers → commit 数据。**不发邮件**。

**本地（/meli skill）**：读本地数据 → 按 `prompts/daily-self.md` 分析 → 发邮件（Resend）。

拆分原因：分析逻辑需要灵活迭代（改 prompt 立即生效），数据抓取要稳定（每日不中断）。
两层职责解耦，互不依赖。详见 [`SKILL.md`](./SKILL.md)。

> **Phase 0 背景**：2026-04-11 起 GitHub Actions 定时任务连续失败。根因是
> ML 的 Akamai 对数据中心 IP 起 bot 墙，HTML 抓取 0 卡片。
>
> **Phase 1 + 2 突破**：OAuth 打通后 `/highlights/{cat}` 就是官方 Mais Vendidos
> 排行榜，返回 catalog product ID + position；配合 `/products/{pid}` 拿结构化
> 属性、`/products/{pid}/items` 拿多卖家真实最低价（min/max/spread）。
> OAuth 走 API 不走 HTML，数据中心 IP 照样通。

追踪品类（8 个）：

| 品类 | ID |
|------|----|
| 手机（大类，含配件） | `MLB1051` |
| 手机（纯手机） | `MLB1055` |
| 智能穿戴（大类） | `MLB417704` |
| 智能手表（纯手表） | `MLB135384` |
| 耳机（PC Gaming） | `MLB1664` |
| 耳机（音频类） | `MLB196208` |
| 平板（大类） | `MLB91757` |
| 平板（纯平板） | `MLB99889` |

## 工作流

```
【云端】GitHub Actions (每天 UTC 00:00 / 巴西 21:00)
    │
    ├─ refresh_token 换 access_token        (scripts/lib/ml-oauth.js)
    ├─ fetch-top-sellers.js                 → data/daily/{date}.json
    │                                       + data/history/{cat}.jsonl
    ├─ gh secret set ML_REFRESH_TOKEN       (轮换后的 refresh_token 写回 secret)
    └─ git commit + push
    ❌ 不再自动发邮件

【本地】/meli skill（按需触发）
    │
    ├─ 读 data/daily/{今日} + {昨日}
    ├─ 按 prompts/daily-self.md 让 Claude 做分析
    ├─ 在 chat 中展示分析
    └─ 必须调 scripts/deliver.js --md /tmp/meli-analysis.md 发邮件
```

## 本地运行

```bash
cd scripts
npm install

# 抓数据（和 CI 跑的同一份）— 从 ../.env.local 自动读 ML 凭证
# 跑完会把轮换后的新 refresh_token 自动写回 .env.local
node fetch-top-sellers.js    # → data/daily/{date}.json

# 发邮件（需先把分析 markdown 写到某个文件，或由 /meli skill 自动做）
node deliver.js --md /tmp/meli-analysis.md
```

## 目录结构

```
.
├── .github/workflows/fetch-prices.yml   # 每日 Actions
├── config/categories.json                # 8 品类配置
├── scripts/
│   ├── fetch-top-sellers.js              # Phase 1 OAuth 三段式抓取（CI 调用）
│   ├── deliver.js                        # Resend 邮件（接受 --md / --html，由 skill 调用）
│   ├── lib/
│   │   ├── ml-oauth.js                   # refresh_token 刷新 + 轮换持久化
│   │   └── ml-api.js                     # MLClient：highlights/products/sellers
│   └── package.json                      # 依赖：resend, marked
├── data/
│   ├── daily/{date}.json                 # 每日完整快照（schema v2）
│   └── history/{cat}-{slug}.jsonl        # 品类历史（每天追加一行）
├── prompts/daily-self.md                 # 日报分析指令
├── SKILL.md                              # /meli 触发
├── .env.local                            # 本地凭证（gitignore）
├── meli-price-tracker-blueprint-v2.1_2.md
├── PROGRESS.md                           # 上线纪要 + 6 个月后续授权手册
└── README.md
```

## GitHub Secrets

全部已配置（2026-04-17）：

| Secret | 说明 | 状态 |
|---|---|---|
| `RESEND_API_KEY` | Resend API Key（Meli Tracker 专用） | ✅ |
| `ML_APP_ID` | ML 应用 ID (`1599168458123024`) | ✅ |
| `ML_CLIENT_SECRET` | ML 应用密钥 | ✅ |
| `ML_REFRESH_TOKEN` | OAuth refresh token（6 个月有效，每次用会轮换并自动写回） | ✅ |
| `GH_PAT` | Fine-grained PAT：`HuijieL/meli-price-tracker` 的 Secrets: Read/Write | ✅ |

本地凭证在 [`.env.local`](./.env.local)（gitignore）。

## 升级路线

- **Phase 0** — ✅ HTML 抓取 + Resend 邮件（2026-04-11 起被 bot 墙封死，已弃）
- **Phase 1** — ✅ OAuth 接入（2026-04-17 上线）
- **Phase 2** — ✅ Catalog 多卖家真实最低价（与 Phase 1 合并落地）
- **Phase 2.5** — ✅ 架构拆分：CI 只抓数据，/meli skill 做分析 + 发邮件（2026-04-17 重构）
- **Phase 3** — Puppeteer 截图 + Cloudflare R2 存证（推迟：API 数据已比截图信息量大）
- **Phase 4** — 周报 / 月报自动化（7-30 天数据积累后）
- **Phase 5** — 季报 / 年度同比

完整设计见 [`meli-price-tracker-blueprint-v2.1_2.md`](./meli-price-tracker-blueprint-v2.1_2.md)。
日常运维（token 到期重新授权等）见 [`PROGRESS.md`](./PROGRESS.md)。
