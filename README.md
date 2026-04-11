# Meli Price Tracker

巴西 Mercado Livre 品类 **Mais Vendidos** 排行榜每日抓取 + 日报邮件。
为 Huawei Brazil GTM Manager 提供竞品价格情报，驱动调价决策。

## 当前阶段：Phase 0 (MVP)

无 OAuth、无截图、无 catalog 多卖家链路。通过 Resend 发送每日 HTML 邮件。

> **注意**：截至 2026-04-10，Mercado Livre 已关闭对 `api.mercadolibre.com`
> 的匿名访问（search / items 全部 403 unauthorized）。Phase 0 改为直接抓取
> Mais Vendidos 页面 HTML 并解析 `poly-card` 组件。每页固定返回 Top 20。
> `attributes`（内存/颜色/RAM 等）字段需要待 Phase 1 OAuth 接入后补齐。

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
GitHub Actions (每天 UTC 00:00 / 巴西 21:00)
    │
    ├─ fetch-top-sellers.js   → data/daily/{date}.json + data/history/{cat}.jsonl
    ├─ deliver.js             → Resend 邮件 (Top 10 / 品类)
    └─ git commit + push
```

## 本地运行

```bash
cd scripts
npm install

# 抓取（无需任何环境变量）
node fetch-top-sellers.js

# 发邮件（需要 RESEND_API_KEY）
RESEND_API_KEY=re_xxx node deliver.js
```

## 目录结构

```
.
├── .github/workflows/fetch-prices.yml   # 每日 Actions
├── config/categories.json                # 8 品类配置
├── scripts/
│   ├── fetch-top-sellers.js              # 无 OAuth 抓取
│   ├── deliver.js                        # Resend 邮件
│   └── package.json                      # 依赖：resend
├── data/
│   ├── daily/{date}.json                 # 每日完整快照
│   └── history/{cat}-{slug}.jsonl        # 品类历史（每天追加一行）
├── prompts/daily-self.md                 # 日报分析指令
├── SKILL.md                              # /meli 触发
├── meli-price-tracker-blueprint-v2.1_2.md
└── README.md
```

## GitHub Secrets

| Secret | 说明 |
|---|---|
| `RESEND_API_KEY` | Resend API Key（发送邮件） |

## 升级路线

- **Phase 1** — 注册 ML 开发者账号 + OAuth
- **Phase 2** — Catalog 多卖家真实最低价
- **Phase 3** — Puppeteer 截图 + Cloudflare R2 存证
- **Phase 4** — 周报 / 月报自动化（7-30 天数据积累后）
- **Phase 5** — 季报 / 年度同比

完整设计见 [`meli-price-tracker-blueprint-v2.1_2.md`](./meli-price-tracker-blueprint-v2.1_2.md)。
