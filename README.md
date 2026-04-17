# Meli Price Tracker

巴西 Mercado Livre 品类 **Mais Vendidos** 排行榜每日抓取 + 日报邮件。
为 Huawei Brazil GTM Manager 提供竞品价格情报，驱动调价决策。

仓库：<https://github.com/HuijieL/meli-price-tracker>

## 当前阶段：Phase 1 (OAuth 接入中)

OAuth 应用已注册，凭证已拿到，API 能力已验证。代码改造待完成。
详细进度与下一步续作点见 [`PROGRESS.md`](./PROGRESS.md)。

> **Phase 0 背景**：截至 2026-04-10，Mercado Livre 已关闭对 `api.mercadolibre.com`
> 的匿名访问（search / items 全部 403）。Phase 0 的 fallback 是抓取
> Mais Vendidos 页面 HTML 并解析 `poly-card`，每页固定 Top 20，无结构化属性。
>
> **Phase 1 突破**：OAuth 打通后发现 `/highlights/{cat}` 就是官方 Mais Vendidos
> 排行榜，返回 **catalog product ID + position**；配合 `/products/{pid}` 拿结构化
> 属性、`/products/{pid}/items` 拿多卖家真实最低价。**Search API 仍 403，但已无所谓**
> —— highlights + products 组合功能上覆盖了 search。

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

| Secret | 说明 | 状态 |
|---|---|---|
| `RESEND_API_KEY` | Resend API Key（发送邮件） | ✅ 已有 |
| `ML_APP_ID` | ML 应用 ID (`1599168458123024`) | ⬜ 待推 |
| `ML_CLIENT_SECRET` | ML 应用密钥 | ⬜ 待推 |
| `ML_REFRESH_TOKEN` | OAuth refresh token（6 个月有效，每次用会轮换） | ⬜ 待推 |
| `GH_PAT` | GitHub PAT（repo 权限，Actions 写回轮换后的 refresh_token） | ⬜ 待创建 |

本地凭证暂存在 [`.env.local`](./.env.local)（已 gitignore）。

## 升级路线

- **Phase 0** — ✅ HTML 抓取 + Resend 邮件（已上线）
- **Phase 1** — 🚧 OAuth 接入（凭证就位，代码改造中）
- **Phase 2** — Catalog 多卖家真实最低价（API 已验证可用，跟 Phase 1 合并落地）
- **Phase 3** — Puppeteer 截图 + Cloudflare R2 存证
- **Phase 4** — 周报 / 月报自动化（7-30 天数据积累后）
- **Phase 5** — 季报 / 年度同比

完整设计见 [`meli-price-tracker-blueprint-v2.1_2.md`](./meli-price-tracker-blueprint-v2.1_2.md)。
