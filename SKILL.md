---
name: meli-price-tracker
description: >
  巴西美客多 (Mercado Livre) 品类排行榜竞品价格追踪。
  覆盖手机、智能手表、耳机、平板四大品类 Mais Vendidos 排名。
  触发词：/meli、美客多价格、meli价格、今日排名、竞品价格、top seller。
---

# Mercado Livre 竞品价格追踪

## 数据源

GitHub 仓库: https://github.com/HuijieL/meli-price-tracker

- 最新快照: `data/daily/{今日日期}.json`
- 昨日快照: `data/daily/{昨日日期}.json`（用于对比）
- 历史: `data/history/{category}.jsonl`

## 工作流

1. 下载今日 + 昨日的 daily JSON
2. 按 prompts/daily-self.md 的格式生成分析
3. 重点：竞品价格变动 → Huawei 排名 → 定价建议
4. 如果用户要求发邮件，调用 deliver.js

## 快捷命令

- `/meli` — 今日日报
- `/meli 周报` — 本周汇总（需要 7 天数据）
- `/meli [品牌]` — 单品牌分析（如 `/meli samsung`）
