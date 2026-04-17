---
name: meli-price-tracker
description: >
  巴西美客多 (Mercado Livre) 品类排行榜竞品价格追踪。
  覆盖手机、智能手表、耳机、平板四大品类 Mais Vendidos 排名。
  触发词：/meli、美客多价格、meli价格、今日排名、竞品价格、top seller。
---

# Mercado Livre 竞品价格追踪

## 架构

- **云端（GitHub Actions）**: 每天巴西 21:00 抓数据 → commit。**只存不发邮件**。
- **本地（本 skill）**: `/meli` 触发时做分析 + 发邮件。

两层解耦，云端专注数据质量，本 skill 专注分析质量。

## 数据源

仓库: <https://github.com/HuijieL/meli-price-tracker>

本地已 clone 到 `/Users/li/Desktop/Meli- tracker/`，直接读本地文件：

- 最新快照: `data/daily/{今日日期}.json`
- 昨日快照: `data/daily/{昨日日期}.json`（用于对比）
- 品类历史: `data/history/{category_id}-{slug}.jsonl`（用于周/月报）

如果本地数据不是今天的（Actions 还没跑 / 失败），先 `cd` 进仓库 `git pull`。

## 工作流（必须按顺序完整执行，不可跳步）

**1. 读数据**
- 列出 `data/daily/` 下最新两个 JSON 文件（今日 + 昨日）
- 若今天的不存在，提示用户「今日数据还未生成，使用昨日数据分析」并用次新

**2. 按 `prompts/daily-self.md` 生成分析**
- 严格遵循该 prompt 定义的结构（🚨紧急关注 / 📊Top 5 / 🏷️竞品价格变动 / 📱Huawei 状态 / 💡定价建议）
- 输出 markdown 格式（表格、标题、列表）
- 所有数据点来自 JSON，**不要编造**

**3. 在对话框中展示完整分析** — 让用户立刻看到

**4. 保存分析到临时文件**
```bash
# 把刚生成的 markdown 分析内容写入：
/tmp/meli-analysis.md
```

**5. 发邮件（必须执行，不可跳过）**
```bash
cd "/Users/li/Desktop/Meli- tracker/scripts"
node deliver.js --md /tmp/meli-analysis.md
```

邮件会：
- 自动从 `.env.local` 读 `RESEND_API_KEY`
- 自动读最新快照填页眉（品类数、总商品数、抓取时间）
- 把 markdown 渲染成 HTML 并发到 lihuijie129@gmail.com

**只有用户明确说「不发邮件」时才跳过第 5 步。** 默认必须发。

## 快捷命令

- `/meli` — 今日日报（默认，prompts/daily-self.md）
- `/meli 周报` — 本周汇总（需 7 天数据，未来启用 prompts/weekly-team.md）
- `/meli [品牌]` — 单品牌专项（如 `/meli samsung`）
- `/meli 不发邮件` — 只在 chat 展示，不投递

## 自定义主题或收件人

```bash
node deliver.js --md /tmp/meli-analysis.md \
  --subject "📊 Meli 周报 — W16" \
  --to "ben@huawei.com,team@huawei.com"
```

## 如果 skill 改了 prompt

改 `prompts/daily-self.md` 后，下次 `/meli` 立即生效——不需要重新部署 CI，不需要等明天。
这就是为什么分析链路放在本地而不是云端。
