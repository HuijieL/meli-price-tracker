# 云端每日抓取的数据字典

**适用版本**：`schema_version: 2`（Phase 1+2，2026-04-17 起）
**来源**：Mercado Livre OAuth API（3 个端点组合）
**频率**：每天巴西时间 21:00（UTC 00:00）自动跑，GitHub Actions 触发
**产物**：`data/daily/{YYYY-MM-DD}.json`（完整快照）+ `data/history/{cat}-{slug}.jsonl`（品类历史行）

---

## 1. 采集范围

### 1.1 覆盖的 8 个品类

| Category ID | 品类 | 每日 Top N |
|---|---|---|
| `MLB1051` | 手机（大类，含配件） | 20 |
| `MLB1055` | 手机（纯手机） | 20 |
| `MLB417704` | 智能穿戴（大类） | 20 |
| `MLB135384` | 智能手表（纯手表） | 20 |
| `MLB1664` | 耳机（PC Gaming） | 20 |
| `MLB196208` | 耳机（音频类） | 20 |
| `MLB91757` | 平板（大类） | 20 |
| `MLB99889` | 平板（纯平板） | 20 |

**每日理论上限**：8 × 20 = **160 个商品**。
**实际产出**（以 2026-04-18 快照为例）：158 个（极少数 ITEM/USER_PRODUCT 类型会被跳过）。

### 1.2 调用的 3 个 API 端点

```
GET /highlights/MLB/category/{category_id}
    → Mais Vendidos 排行榜，返回 Top N 商品的 catalog ID + 排名

GET /products/{catalog_product_id}
    → 商品目录信息：品牌、型号、属性、图片、buy box 卖家

GET /products/{catalog_product_id}/items?limit=20
    → 该目录下所有在售 listings，每条含卖家 ID、售价、shipping、官方店标识
```

---

## 2. 每个商品采集的字段（23 个）

一条商品记录（`categories.{cat}.items[i]`）的完整字段：

### 2.1 身份标识

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `rank` | int | highlights | 当日排名（1-20） |
| `catalog_product_id` | string | highlights | ML 目录 ID，格式 `MLB54964804`。**跨天对比的稳定 key** |
| `item_id` | string / null | highlights | 极少数类型为 ITEM 时才有；PRODUCT 型为 null |
| `title` | string | products | 原始葡语标题（含属性，如 `Celular Samsung Galaxy A07 256gb...`） |
| `permalink` | string | products | ML 商品页 URL（目前经常返回空串） |

### 2.2 产品结构化属性

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `brand` | string | products/attributes | **权威品牌**（如 `Samsung` `Motorola`），不是启发式 |
| `model` | string | products/attributes | 型号（如 `A07` `Moto G06`） |
| `line` | string | products/attributes | 产品线（如 `Galaxy A07` `Moto G`） |
| `attributes` | object | products/attributes | 结构化属性字典（见 2.3） |
| `main_features` | string[] | products | ML 编辑写的卖点短句，最多 5 条 |
| `pictures` | string[] | products | 商品图片 URL，最多 3 张 |

### 2.3 `attributes` 字典里常见的 key（按覆盖率排序）

以 2026-04-18 的 158 条样本：

| 属性 ID | 出现次数 | 覆盖率 | 典型值 |
|---|---|---|---|
| `BRAND` | 151 | 96% | `Samsung`, `Motorola`, `Xiaomi` |
| `MODEL` | 150 | 95% | `A07`, `Moto G06` |
| `LINE` | 136 | 86% | `Galaxy A07`, `Redmi Note 12` |
| `COLOR` | 118 | 75% | `Violeta`, `Preto` |
| `MAIN_COLOR` | 109 | 69% | `Violeta`, `Preto` |
| `WITH_BLUETOOTH` | 107 | 68% | `Sim` / `Não` |
| `DISPLAY_SIZE` | 88 | 56% | `6.7 "`, `10.1 "` |
| `BATTERY_CAPACITY` | 85 | 54% | `5000 Ah` |
| `INTERNAL_MEMORY` | 59 | 37% | `256 GB`, `128 GB` |
| `CONNECTIVITY` | 24 | 15% | `Bluetooth`, `Wi-Fi` |

其他被抓取但覆盖率 < 10% 的：`RAM_MEMORY`、`MAIN_CAMERA_RESOLUTION`、`WATCH_TYPE`、`WITH_WI_FI`、`CATEGORY_ID`。

### 2.4 价格字段（核心卖点）

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `buy_box_price` | number / null | products | ML 默认橱窗价（用户打开页面看到的那个） |
| `buy_box_seller_id` | number / null | products | buy box 卖家 ID |
| `currency` | string | products | 永远 `BRL` |
| `min_price` | number / null | products/items | **多卖家真实最低价**（抓取该商品下最多 20 个 listings 后 min） |
| `max_price` | number / null | products/items | 多卖家最高价 |
| `price_spread_pct` | number / null | 计算字段 | `(max-min)/min*100`，价差百分比。> 20% 说明 catalog 内在打价格战 |
| `seller_count` | int | products/items | 该目录下抓到的卖家数量（上限 20） |

**覆盖率参考**（158 条中）：

| 品类 | 总数 | 多卖家（seller_count>1） | 价差≥20% |
|---|---|---|---|
| MLB1051 手机大类 | 20 | 13 | 10 |
| MLB1055 纯手机 | 20 | 19 | 13 |
| MLB417704 穿戴大类 | 20 | 12 | 8 |
| MLB135384 纯手表 | 20 | 13 | 11 |
| MLB1664 耳机 Gaming | 20 | 18 | 14 |
| MLB196208 耳机音频 | 20 | 13 | 7 |
| MLB91757 平板大类 | 20 | 11 | 11 |
| MLB99889 纯平板 | 18 | 17 | 13 |

意思是：**大多数 Top 20 商品都有多卖家比价数据**，而且**每个品类都有 10 条左右出现 ≥20% 价差**——这些就是价格战、一级供应链出货、折扣窗口的信号。

### 2.5 卖家明细

| 字段 | 类型 | 说明 |
|---|---|---|
| `official_sellers` | array | 只含 `official_store_id` 不为 null 的卖家（三星官方店、小米官方店等） |
| `top_prices` | array | 最低价前 5 家的明细（price + seller_id + official_store_id + free_shipping） |

**`official_sellers` 每项**：`{seller_id, official_store_id, price}`
**`top_prices` 每项**：`{price, seller_id, official_store_id, free_shipping}`

这是 **GTM 最高价值数据**：能直接看到 Samsung 官方店今天挂 R$919，而某第三方卖家同货 R$1631——价差 77% 就是从这里算出来的。

### 2.6 时序字段（有昨日快照时才填）

| 字段 | 类型 | 说明 |
|---|---|---|
| `price_delta` | number / null | `今日 min_price - 昨日 min_price`，单位 R$（绝对值） |
| `prev_rank` | int / null | 昨日该商品的 rank，用来算 ↑↓ 排名变化 |

### 2.7 抓取错误

| 字段 | 类型 | 说明 |
|---|---|---|
| `_fetch_errors` | string[] | 该条记录在 fetch 过程中遇到的错误（如 `product:404:not found`）。正常为 `[]` |
| `skipped_reason` | string | 仅当 highlights 返回非 PRODUCT 类型时出现，记录跳过原因 |

---

## 3. 快照级元数据

每个 `data/daily/*.json` 顶层字段：

```json
{
  "date": "2026-04-18",                    // 巴西时区的当日
  "fetched_at": "2026-04-19T02:51:50Z",    // UTC ISO 时间戳
  "source": "mercadolivre-oauth-api",
  "oauth": true,
  "schema_version": 2,
  "note": "Phase 1 OAuth pipeline: ...",
  "categories": { ... }
}
```

每个 `categories.{cat}` 下：

```json
{
  "category_id": "MLB1051",
  "slug": "celulares-telefones",
  "category_name_pt": "Celulares e Telefones",
  "category_name_zh": "手机（大类，含配件）",
  "mais_vendidos_url": "https://www.mercadolivre.com.br/mais-vendidos/MLB1051",
  "item_count": 20,
  "items": [ ... ]
}
```

---

## 4. 历史文件（每天追加 1 行）

`data/history/{cat}-{slug}.jsonl` 是按品类切分的每日精简快照，便于时序分析。
**每行一条当日记录**，字段是完整快照的子集：

```json
{
  "date": "2026-04-18",
  "items": [
    {
      "rank": 1,
      "catalog_product_id": "MLB54964804",
      "brand": "Samsung",
      "model": "A07",
      "title": "Celular Samsung Galaxy A07 256gb...",
      "buy_box_price": 919,
      "min_price": 919,
      "max_price": 1631.9,
      "price_spread_pct": 77.57,
      "seller_count": 20,
      "price_delta": null,
      "prev_rank": null
    },
    ...
  ]
}
```

8 个品类各一个 JSONL 文件，每天增长 8 行。**7 天后可做周报**、30 天后可做月报。

---

## 5. 能直接跑出来的 GTM 分析

基于以上字段，不需要加新抓取即可输出：

### 5.1 竞品价格情报
- **谁在 Top 20**：按品牌分组数排名趋势
- **真实最低价 vs 橱窗价**：`min_price` 和 `buy_box_price` 的差
- **价格战监测**：`price_spread_pct ≥ 20%` 的商品列表 → 卖家间砍单
- **官方店价位**：`official_sellers` 里各大厂的自营价 → 建议跟价线
- **昨日对比**：`price_delta` + `prev_rank` → 谁降价、谁上升、谁跌出

### 5.2 品类结构
- **价格带分布**：按 `min_price` 分桶，看每个品类的"量价甜区"
- **品牌份额**：每品类 Top 20 内的品牌占位比
- **属性趋势**：Top 20 里 128GB vs 256GB 的占比、6.7" vs 6.1" 屏的占比

### 5.3 华为机会识别
- **Huawei 在/不在榜**：扫 `brand == "Huawei"` 的所有条目
- **缺位价格带**：统计每个价格档里的品牌，指出 Huawei 缺席的档位
- **对标竞品**：找 Huawei 机型最近的价位 + 属性对标（如 Band 11 vs Mi Band 9）

### 5.4 新品发现
- **今日上榜明日不在**：对比 `prev_rank` 发现短命空降榜
- **catalog_product_id 首次出现**：全新 SKU 进 Top 20 的时间点

---

## 6. 暂未捕获的数据（需要时可扩）

这些字段 ML API 有，我们当前没抓（都是一次代码改动的事）：

| 数据 | 来源端点 | 为何没抓 |
|---|---|---|
| 商品评价 / 评分 | `/reviews/item/{item_id}` | Phase 1 聚焦价格，评价需额外 call |
| 销量估算 | `/items/{item_id}` → `sold_quantity` | 目录层没有，需对每个 item 单独 call（成本 × 20） |
| 货架日期 | `/items/{item_id}` → `date_created` | 同上 |
| 商品问答 | `/questions/search?item=...` | 信号噪音比低 |
| 卖家信誉 | `/users/{seller_id}` | 单独 call，未接入 |
| 地区库存 | `/items/{item_id}/available_quantity` | ML 不一定对所有 scope 开放 |

**如果要加**：改 `scripts/lib/ml-api.js` 增一个方法 + `fetch-top-sellers.js` 里在 `enrichProduct` 里串一个 call 即可。预计改动 < 50 行。

---

## 7. 数据体量参考

| 项目 | 大小 |
|---|---|
| 单日 JSON | ~80-120 KB（158 条 × 每条 ~500 字段字节） |
| 单日 JSONL 追加量 | 8 个文件 × 每文件 ~6 KB / 行 ≈ 50 KB |
| 年度估算 | 365 × 120 KB ≈ 44 MB JSON + 18 MB JSONL = 62 MB/年 |
| ML API 调用 | 8 highlights + 160 products + 160 items = **328 次/天**。日配额 1000+，充裕 |

**结论**：至少能在 GitHub repo 里无压力存 5+ 年历史。
