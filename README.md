# Meli Price Tracker

巴西 Mercado Livre 品类 **Mais Vendidos** 排行榜每日抓取 + 日报邮件。
为 Huawei Brazil GTM Manager 提供竞品价格情报，驱动调价决策。

**仓库**：<https://github.com/HuijieL/meli-price-tracker>
**状态**：Phase 1+2 已上线 ✅（2026-04-17）

## 两层架构

- **云端（GitHub Actions，每天巴西 21:00）**：OAuth 刷 token → 8 品类抓 highlights + products + sellers → commit 数据。**不发邮件。**
- **本地（`/meli` skill）**：读本地数据 → 按 `prompts/daily-self.md` 分析 → Resend 发邮件。

分析链路放本地是为了改 prompt 立即生效；数据抓取放云端是为了每日稳定不中断。

## 本地跑

```bash
cd scripts
npm install

# 抓数据（和 CI 同一份）
node fetch-top-sellers.js     # → data/daily/{date}.json

# 发邮件（需先写 /tmp/meli-analysis.md，或由 /meli skill 自动生成）
node deliver.js --md /tmp/meli-analysis.md
```

## 触发分析与邮件

在 Claude Code 里输入 `/meli`。Skill 会：`git pull` → 读今日+昨日 JSON → 按 prompt 生成 GTM 报告 → 终端展示 → Resend 发到 lihuijie129@gmail.com。

## 文档索引

| 想做的事 | 看哪里 |
|---|---|
| 了解项目约定、字段速查、避坑 | [CLAUDE.md](CLAUDE.md) |
| 数据字段完整字典 | [docs/DATA.md](docs/DATA.md) |
| Actions 红了、refresh_token 到期 | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| 报告结构（改这里下次 `/meli` 立即生效） | [prompts/daily-self.md](prompts/daily-self.md) |
| 历史设计稿（已归档） | [docs/blueprint-archive.md](docs/blueprint-archive.md) |

## 目录结构

```
.
├── CLAUDE.md                   # CC 工作约定（自动加载）
├── README.md                   # 本文件
├── .env.local                  # 本地凭证（gitignored）
├── .github/workflows/fetch-prices.yml
├── config/categories.json      # 8 品类
├── scripts/
│   ├── fetch-top-sellers.js    # Phase 1 OAuth 三段式抓取
│   ├── deliver.js              # Resend 邮件
│   └── lib/{ml-oauth,ml-api}.js
├── data/
│   ├── daily/{date}.json       # 每日快照（schema v2）
│   └── history/{cat}.jsonl     # 品类历史（每天追加）
├── prompts/daily-self.md       # 报告结构 SSOT
└── docs/
    ├── DATA.md                 # 数据字典
    ├── OPERATIONS.md           # 运维手册
    └── blueprint-archive.md    # 历史设计稿
```
