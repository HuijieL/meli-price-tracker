# Mercado Livre 价格追踪系统 — 工程蓝图 v2.1

> **v2.1 在 v2 基础上修正：OAuth 为必须项、增加 catalog 多卖家真实最低价链路、增加截图+API原始响应存证、分析框架针对 GTM Manager 决策场景重设**
>
> 基于 GitHub Actions + ML OAuth API + Claude Skill 的全自动竞品价格监控方案
> 每日自动抓取 → 真实最低价获取 → 截图存证 → 历史记录 → Claude 分析 → 分级邮件推送

---

## 一、系统架构

```
┌───────────────────────────────────────────────────────────────────────┐
│                    GitHub Actions (免费)                                │
│              每天 UTC 00:00 运行 (巴西时间 21:00)                       │
│                                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  ┌────────────┐  │
│  │ 1. OAuth 刷新 │─▶│ 2. 抓取排行榜 │─▶│ 3. Catalog  │─▶│ 4. 截图    │  │
│  │ refresh token │  │ Search API   │  │ 多卖家报价  │  │ Puppeteer  │  │
│  │              │  │ 8 个品类      │  │ 真实最低价  │  │ 8 品类页面 │  │
│  └──────────────┘  └──────────────┘  └────────────┘  └────────────┘  │
│                                                            │          │
│  ┌──────────────────────────────────────────────────────────┘          │
│  │ 5. 存储                                                            │
│  │ ├── data/daily/{date}.json          ← 当日完整快照                  │
│  │ ├── data/history/{cat}.jsonl        ← 品类历史 (追加)               │
│  │ ├── data/raw/{date}/{cat}_raw.json  ← API 原始响应 (存证)           │
│  │ └── screenshots/{date}/             ← 页面截图 → 外部存储           │
│  └──────────────────────────────────────────────────────────┐          │
│                              git commit + push ◄────────────┘          │
└───────────────────────────────────────────────────────────────────────┘
                              │
                    GitHub 仓库（JSON + JSONL）
                    外部存储（截图 → Cloudflare R2 / GitHub Releases）
                              │
┌───────────────────────────────────────────────────────────────────────┐
│             Claude Code / claude.ai Skill — 分析 + 投递                │
│                                                                       │
│  ┌────────────────┐  ┌──────────────────┐  ┌────────────────────────┐│
│  │ 拉取 GitHub 数据│─▶│ Claude 分析       │─▶│ 分级邮件发送            ││
│  │ 今日+历史+原始  │  │ 竞品定价反应      │  │ 日报 → 自己             ││
│  │                │  │ 排名变化+信号     │  │ 周报 → 本地团队(中英)   ││
│  │                │  │ 定价建议          │  │ 月/季报 → 总部(正式+数据)││
│  └────────────────┘  └──────────────────┘  └────────────────────────┘│
└───────────────────────────────────────────────────────────────────────┘
```

### v1 → v2 → v2.1 演进

| 维度 | v1 | v2 | v2.1 修正 |
|------|----|----|-----------|
| OAuth | 必须 | 标为可选 ❌ | **必须** ✅ 真实最低价依赖 catalog API |
| 价格数据 | 搜索结果价格 | 排行榜展示价格 | **catalog 多卖家真实最低价** |
| 数据存证 | 无 | 无 | **截图 + API 原始响应** |
| 分析框架 | 通用 | 通用 | **GTM Manager 决策导向** |
| 报告受众 | 自己 | 自己 | **自己 + 本地团队 + 总部** |

---

## 二、追踪品类与 URL

### 2.1 品类 ID 对照表

Mercado Livre 品类树公开 API：`https://api.mercadolibre.com/categories/{CATEGORY_ID}`

| 品类 | 品类 ID | 层级路径 | Mais Vendidos URL |
|------|---------|----------|-------------------|
| 手机（大类，含配件） | `MLB1051` | Celulares e Telefones | https://www.mercadolivre.com.br/mais-vendidos/MLB1051 |
| 手机（纯手机） | `MLB1055` | Celulares e Telefones > Celulares e Smartphones | https://www.mercadolivre.com.br/mais-vendidos/MLB1055 |
| 智能穿戴（大类） | `MLB417704` | Celulares e Telefones > Smartwatches e Acessórios | https://www.mercadolivre.com.br/mais-vendidos/MLB417704 |
| 智能手表（纯手表） | `MLB135384` | Celulares e Telefones > Smartwatches e Acessórios > Smartwatches | https://www.mercadolivre.com.br/mais-vendidos/MLB135384 |
| 耳机（PC Gaming 下） | `MLB1664` | Informática > Acessórios para PC Gaming > Fones | https://www.mercadolivre.com.br/mais-vendidos/MLB1664 |
| 耳机（音频类下） | `MLB196208` | Eletrônicos, Áudio e Vídeo > Áudio > Fones de Ouvido | https://www.mercadolivre.com.br/mais-vendidos/MLB196208 |
| 平板电脑（大类） | `MLB91757` | Informática > Tablets e Acessórios | https://www.mercadolivre.com.br/mais-vendidos/MLB91757 |
| 平板电脑（纯平板） | `MLB99889` | Informática > Tablets e Acessórios > Tablets | https://www.mercadolivre.com.br/mais-vendidos/MLB99889 |

### 2.2 品类注意事项

- **MLB1051 是大类**：排名含耳机、手机壳等配件，需配合 MLB1055（纯手机）交叉验证
- **耳机分散在两个一级类目**：TWS 卖家上架选 PC Gaming 或 Áudio 随机，两个都必须抓
- **Smartwatch 挂在手机品类下**，不在 Eletrônicos 下
- 品类 ID 通过 API 遍历：`curl https://api.mercadolibre.com/categories/{ID}`，无需认证

---

## 三、关键问题：真实最低价获取

### 3.1 问题描述

ML 有 **catálogo（商品目录）** 机制：同一产品（如 Galaxy A56 256GB 黑色）有多个卖家共享一个 listing 页面。搜索结果或排行榜显示的价格是 **buy box 赢家的价格**（默认卖家），但点进商品页底部 "Ver mais opções de compra" 可能有更低价格。

如果只记录 buy box 价格，数据会系统性偏高，对定价决策有误导。

### 3.2 解决方案：Catalog API 链路

```
排行榜 Search API
    │
    ▼
item_id (如 MLB1234567890)
    │
    ▼
GET /items/{item_id}
    │ 返回 catalog_product_id (如 MLB20145678)
    ▼
GET /products/{catalog_product_id}/items
    │ 返回该 catalog 下所有卖家的 item 列表
    ▼
对每个卖家 item 获取价格
    │
    ▼
记录：
    ├── buy_box_price:     buy box 赢家价格（排行榜展示的）
    ├── true_lowest_price: 全卖家真实最低价
    ├── median_price:      全卖家中位价
    ├── seller_count:      卖家数量
    └── sellers:           各卖家价格列表
```

### 3.3 API 调用示例

```javascript
// Step 1: 从排行榜拿到 item_id
const item = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
  headers: { Authorization: `Bearer ${accessToken}` }
}).then(r => r.json());

const catalogId = item.catalog_product_id; // "MLB20145678"

// Step 2: 查 catalog 下所有卖家
if (catalogId) {
  const catalog = await fetch(
    `https://api.mercadolibre.com/products/${catalogId}/items?status=active&limit=20`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  ).then(r => r.json());

  const allPrices = catalog.results.map(r => r.price).sort((a, b) => a - b);

  return {
    buy_box_price: item.price,
    true_lowest_price: allPrices[0],
    median_price: allPrices[Math.floor(allPrices.length / 2)],
    highest_price: allPrices[allPrices.length - 1],
    seller_count: allPrices.length,
    price_spread: allPrices[allPrices.length - 1] - allPrices[0],
    sellers: catalog.results.map(r => ({
      seller_id: r.seller_id,
      price: r.price,
      shipping_free: r.shipping?.free_shipping
    }))
  };
}
```

### 3.4 日销量估算方法

ML API 的 `sold_quantity` 是累计销量，不是日销。通过每日记录差值可以估算：

```
日销量 ≈ 今日 sold_quantity − 昨日 sold_quantity
```

注意事项：
- 如果差值为负，说明卖家下架/重新上架了商品，应标记异常
- 新上榜产品无昨日数据，日销量留空
- 积累 7 天数据后可算周均日销
- 这是**估算值**，不是精确值——但对 GTM 决策够用

---

## 四、数据存证方案

### 4.1 为什么需要存证

长期运行后，上级或总部可能质疑数据准确性。需要两类证据：

- **视觉证据**：截图证明排行榜确实是这个排名和价格
- **数据证据**：API 原始响应证明数据来源可追溯

### 4.2 截图方案：Puppeteer + 外部存储

在 GitHub Actions 中用 Puppeteer 对每个 Mais Vendidos 页面截全屏长图：

```javascript
// scripts/screenshot.js
import puppeteer from 'puppeteer';

async function screenshotCategory(url, outputPath) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox']  // Actions 环境需要
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

  // 滚动到底部加载所有商品
  await autoScroll(page);

  // 全页面截图
  await page.screenshot({ path: outputPath, fullPage: true, type: 'jpeg', quality: 80 });
  await browser.close();
}
```

**存储策略（截图不存 Git 仓库）：**

| 方案 | 容量 | 费用 | 推荐 |
|------|------|------|------|
| Cloudflare R2 | 10 GB 免费 | 免费 | ✅ 首选 |
| GitHub Releases | 每个 release 2 GB | 免费 | ✅ 备选，每月打一个 release |
| AWS S3 | 5 GB 免费（12个月） | 免费→付费 | ⬜ 不推荐 |

每天 8 张截图 × 约 800KB/张 = 6.4 MB/天 ≈ **2.3 GB/年**。Cloudflare R2 免费够用 4 年。

截图文件命名：`screenshots/{date}/MLB1055-smartphones.jpg`

### 4.3 API 原始响应保存

每次 API 调用的原始 JSON 响应原封不动保存：

```
data/raw/2026-04-10/
├── MLB1055_search_raw.json       ← Search API 原始响应
├── MLB1055_items_raw.json        ← Items 批量查询原始响应
├── MLB1055_catalog_raw.json      ← Catalog 多卖家报价原始响应
├── MLB135384_search_raw.json
└── ...
```

原始响应是 JSON 文本，每天约 2-5 MB（8 品类 × 所有 item 详情 + catalog 报价）。用 gzip 压缩后约 300-500 KB/天，**一年约 150 MB**——Git 仓库可承受。

```yaml
# Actions 中压缩原始响应
- name: Compress raw responses
  run: |
    cd data/raw
    tar -czf ${DATE}.tar.gz ${DATE}/
    rm -rf ${DATE}/
```

### 4.4 存储空间预估

| 数据类型 | 每天 | 每年 | 存储位置 |
|----------|------|------|----------|
| 日快照 JSON | ~70 KB | ~25 MB | Git 仓库 |
| 历史 JSONL | ~40 KB | ~15 MB | Git 仓库 |
| API 原始响应（压缩） | ~400 KB | ~150 MB | Git 仓库 |
| 截图 | ~6 MB | ~2.2 GB | **外部存储**（R2） |
| **Git 仓库总计** | ~510 KB | **~190 MB** | ✅ 远低于 1 GB |

---

## 五、前置准备

### 5.1 需要的账号

| 账号 | 用途 | 费用 | 必须？ | 状态 |
|------|------|------|--------|------|
| GitHub | 托管代码 + Actions + 数据存储 | 免费 | ✅ | ✅ 已有 |
| Mercado Livre 开发者 | OAuth API（真实最低价 + 完整属性） | 免费 | ✅ **必须** | ⬜ 待注册 |
| Resend | 发送邮件 | 免费 (100封/天) | ✅ | ✅ 已有 |
| Cloudflare R2 | 截图存储 | 免费 (10 GB) | ✅ 推荐 | ⬜ 待注册 |

### 5.2 ML 开发者账号注册

1. 打开 https://developers.mercadolivre.com.br
2. 用你的巴西美客多买家账号登录
3. 进入 https://developers.mercadolivre.com.br/devcenter
4. 点击 **"Criar nova aplicação"**
5. 填写：
   - **Nome**: `Price Tracker`
   - **Descrição curta**: `Automated price monitoring for market intelligence`
   - **Redirect URI**: `https://localhost/callback`
   - **Scopes**: 勾选 `read`
6. 记录 **APP ID** 和 **Client Secret**

### 5.3 首次获取 OAuth Token

**步骤 1：浏览器授权**
```
https://auth.mercadolivre.com.br/authorization?response_type=code&client_id={APP_ID}&redirect_uri=https://localhost/callback
```

**步骤 2：从回调 URL 复制 code**
```
https://localhost/callback?code=TG-xxxxxxxx-xxxxxxxxx
```

**步骤 3：换取 token**
```bash
curl -X POST "https://api.mercadolibre.com/oauth/token" \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "client_id": "{APP_ID}",
    "client_secret": "{CLIENT_SECRET}",
    "code": "{TG-xxxxxxxx}",
    "redirect_uri": "https://localhost/callback"
  }'
```

返回 `access_token`（6 小时有效）和 `refresh_token`（6 个月有效）。保存到 GitHub Secrets。

---

## 六、仓库结构

```
meli-price-tracker/
├── .github/
│   └── workflows/
│       └── fetch-prices.yml              # 每日抓取（巴西 21:00）
├── config/
│   ├── categories.json                   # 品类配置
│   └── email.json                        # 邮件列表 + 分级推送
├── scripts/
│   ├── fetch-top-sellers.js              # 核心：排行榜抓取 + catalog 真实最低价
│   ├── screenshot.js                     # Puppeteer 截图
│   ├── upload-screenshots.js             # 上传截图到 R2
│   ├── deliver.js                        # 邮件发送（Resend）
│   └── package.json
├── data/
│   ├── daily/
│   │   └── 2026-04-10.json              # 每日快照
│   ├── history/
│   │   ├── MLB1055-smartphones.jsonl     # 品类历史（JSONL 追加）
│   │   ├── MLB135384-smartwatches.jsonl
│   │   ├── MLB1664-fones-gaming.jsonl
│   │   ├── MLB196208-fones-audio.jsonl
│   │   └── MLB99889-tablets.jsonl
│   └── raw/
│       └── 2026-04-10.tar.gz            # API 原始响应（压缩存证）
├── prompts/
│   ├── daily-self.md                     # 日报（给自己，快速可执行）
│   ├── weekly-team.md                    # 周报（给本地团队，中英双语）
│   ├── monthly-team.md                   # 月报（给本地团队 + 总部）
│   ├── quarterly-hq.md                   # 季报（给总部，正式+数据密集）
│   └── yearly-compare.md                # 年度同比
├── SKILL.md
└── README.md
```

---

## 七、核心数据结构

### 7.1 日快照 `data/daily/2026-04-10.json`

```json
{
  "date": "2026-04-10",
  "fetched_at": "2026-04-11T00:00:15Z",
  "categories": {
    "MLB1055": {
      "category_name_zh": "手机",
      "item_count": 30,
      "items": [
        {
          "rank": 1,
          "item_id": "MLB1234567890",
          "title": "Samsung Galaxy A07 256gb, 8gb, Câmera 50mp...",
          "brand": "Samsung",
          "buy_box_price": 1099.00,
          "true_lowest_price": 1029.00,
          "median_price": 1149.00,
          "seller_count": 12,
          "price_spread": 370.00,
          "currency": "BRL",
          "original_price": 1499.00,
          "discount_pct": 27,
          "sold_quantity": 15230,
          "sold_quantity_delta": 87,
          "condition": "new",
          "rating": 4.9,
          "rating_count": 10297,
          "official_store": null,
          "catalog_product_id": "MLB20145678",
          "permalink": "https://www.mercadolivre.com.br/...",
          "attributes": {
            "BRAND": "Samsung",
            "MODEL": "SM-A075M",
            "LINE": "Galaxy A",
            "MEMORY": "256 GB",
            "RAM": "8 GB",
            "COLOR": "Preto"
          },
          "top_sellers": [
            { "seller_id": 111, "nickname": "123Comprou", "price": 1029.00, "free_shipping": true },
            { "seller_id": 222, "nickname": "Samsung Oficial", "price": 1099.00, "free_shipping": true },
            { "seller_id": 333, "nickname": "MobCom", "price": 1149.00, "free_shipping": true }
          ]
        }
      ]
    }
  },
  "evidence": {
    "screenshots": {
      "MLB1055": "https://r2.yourdomain.com/screenshots/2026-04-10/MLB1055.jpg"
    },
    "raw_api_archive": "data/raw/2026-04-10.tar.gz"
  }
}
```

**关键字段说明：**
- `buy_box_price`：排行榜展示价格 / 默认卖家价格
- `true_lowest_price`：catalog 下所有卖家的真实最低价 ← **定价决策用这个**
- `sold_quantity_delta`：与昨日 sold_quantity 的差值 = **估算日销量**
- `price_spread`：最高价 − 最低价，反映卖家间竞争激烈度
- `top_sellers`：该 catalog 下前 3 个最低价卖家

### 7.2 历史记录 JSONL

每天追加一行，每行是一个日期的完整品类快照的精简版：

```jsonl
{"date":"2026-04-10","items":[{"rank":1,"item_id":"MLB123","brand":"Samsung","title":"Galaxy A07 256gb","buy_box_price":1099,"true_lowest_price":1029,"sold_quantity":15230,"sold_qty_delta":87}]}
{"date":"2026-04-11","items":[...]}
```

---

## 八、分析框架设计

### 8.1 设计原则

分析框架基于你的实际决策场景设计：

| 你的身份 | GTM Manager，有直接调价权 |
|----------|--------------------------|
| 核心需求 | 竞品价格变动 → 我要不要跟 |
| 决策速度 | 看完报告 5 分钟内要有结论 |
| 报告受众 | 日报→自己，周报→团队(中英)，月/季报→总部(正式) |

**分析四层模型：**

```
第一层：What        —— 今天市场长什么样（现状扫描）
第二层：What Changed —— 跟昨天/上周比有什么变化（变化检测）
第三层：So What     —— 这些变化对 Huawei 意味着什么（信号解读）
第四层：Now What    —— 具体要不要调价，调多少（行动建议）
```

### 8.2 `prompts/daily-self.md` — 日报（给自己）

```markdown
# Meli 日报 — GTM Manager 决策版

## 你的角色
你是一位资深消费电子市场分析师，为 Huawei Brazil 的 GTM Manager 提供每日竞品情报。
这位 GTM Manager 有直接调价权，需要可执行的结论，不需要废话。

## 报告结构（严格按此顺序）

### 🚨 紧急关注（如果有的话）
仅当以下情况发生时才出现此栏：
- 竞品（Samsung/Xiaomi/Apple/Motorola）主力产品降价 > 5%
- Huawei 产品跌出 Top 20
- 新产品空降 Top 10
如果没有紧急事项，跳过此栏。

### 📊 各品类 Top 5（表格形式）

每个品类一张表：
| 排名 | 品牌 | 产品 | 真实最低价 | 较昨日 | 估算日销 |
变化用符号：↑涨价 ↓降价 →持平 🆕新上榜

### 🏷️ 竞品价格变动（最重要的部分）

按品牌列出今日价格变动 > 2% 的产品：
- 产品名 + 配置
- 昨日价 → 今日价（变动金额 + 百分比）
- 该产品 catalog 下有几个卖家在卖
- 是否有官方店铺在打价格战

### 📱 Huawei 产品状态

列出所有在 Top 排名中出现的 Huawei 产品：
- 排名 + 排名变化
- 真实最低价 + 买家看到的价格（buy box）
- 同配置竞品的价格对标（自动匹配同价格段、同配置的 Samsung/Xiaomi 产品）
- 价差百分比

### 💡 定价建议（如果需要的话）

仅当 Huawei 产品与竞品价差发生显著变化时给出：
- 建议调价的产品 + 建议价格 + 理由
- 格式："建议将 [产品] 从 R$X 调至 R$Y（跟价 [竞品] 的 R$Z，保持 N% 价差）"

## 规则
- 价格用 R$ 格式，巴西格式（R$ 1.099,00）
- 真实最低价 = catalog 下所有卖家的最低报价，不是 buy box 价格
- 估算日销 = 今日 sold_quantity − 昨日 sold_quantity（如有负值标注异常）
- 不要编造数据，只使用 JSON 中的内容
- 全文中文，简洁直接
- 开头一句话总结今日最重要的事
```

### 8.3 `prompts/weekly-team.md` — 周报（给本地团队，中英双语）

```markdown
# Meli 周度市场情报 / Weekly Market Intelligence

## 角色
为 Huawei Brazil 本地团队生成中英双语周度市场情报。
内容需要同时给中国同事和国际同事看，关键结论双语呈现。

## 报告结构

### 1. 本周要点 / Key Highlights
3-5 条最重要的市场变化，中英双语。

### 2. 竞品价格趋势 / Competitor Price Trends
各品类主力竞品的周均真实最低价 vs 上周：
- 表格形式，按品牌分组
- 标注降价 > 5% 和涨价 > 5% 的产品
- 标注明显的促销活动信号（大面积折扣、官方店参与）

### 3. 排名稳定性分析 / Ranking Stability Analysis
- 本周 7 天都在 Top 10 的产品 = 市场常青款
- 排名波动最大的产品 = 可能在做促销或缺货
- 新上榜且连续 3 天以上在 Top 20 的 = 值得关注的新产品

### 4. Huawei 周度表现 / Huawei Weekly Performance
各品类 Huawei 产品的：
- 周均排名 vs 上周
- 周均真实最低价 vs 竞品
- 估算周销量（日销 × 7）
- 价格竞争力评分（同配置竞品价格 / Huawei 价格 × 100）

### 5. 市场机会 / Market Opportunities
- 本周是否有某个价格段只有少数品牌在卖但销量高（价格真空）
- 白牌产品占 Top 20 比例变化（如果白牌增多，说明品牌产品定价过高）

## 规则
- 关键结论用中文+英语双语
- 数据表格只用一种语言（中文），但列名附英文
- 价格用 R$ 格式
- 基于 7 天数据，不要外推或预测
```

### 8.4 `prompts/monthly-team.md` — 月报（给团队 + 总部参考）

```markdown
# Meli 月度市场回顾

## 角色
为 Huawei Brazil GTM 团队和总部产品线提供月度市场回顾。
这份报告需要正式、有数据支撑、结论清晰。总部可能用这份报告作为定价策略的输入。

## 报告结构

### 1. 月度执行摘要（200 字以内）
一段话总结本月市场最重要的 3 个变化。

### 2. 品牌份额变化
各品类 Top 20 中各品牌席位数：
- 本月 vs 上月（表格 + 变化）
- 计算品牌集中度 CR3（前 3 品牌占比）

### 3. 价格带分析
各品类按价格段分布：
- < R$500 | R$500-1000 | R$1000-2000 | R$2000-3000 | > R$3000
- 各价格段的产品数量 + 品牌构成
- 本月 vs 上月的价格带迁移

### 4. 渠道分析
- 官方店铺 vs 第三方卖家在 Top 20 中的席位
- 官方店铺定价 vs 第三方定价的价差中位数

### 5. Huawei 月度专项
- 各品类排名月度走势（月初 → 月中 → 月末）
- 真实最低价月度走势
- vs 竞品的价格指数（Huawei 价格 / 竞品均价 × 100）
- 估算月销量 vs 上月
- 本月调价回顾：调了什么价、效果如何（排名是否变化）

### 6. 下月建议
- 基于趋势的价格调整建议
- 需要关注的竞品动态（已知的新品上市、促销节点）

## 规则
- 全中文
- 所有结论必须有数据支撑
- 每个"建议"必须附带"依据"
- 如果数据不足以支撑某个结论，明确说明
```

### 8.5 `prompts/quarterly-hq.md` — 季报（给总部）

```markdown
# Meli 季度市场回顾 — 总部报告

## 角色
为 Huawei 总部产品线和区域管理层提供巴西 Mercado Livre 渠道的季度市场分析。
这份报告是正式文件，需要：数据准确、结论有证据链、建议可执行。

## 报告结构

### 1. 季度执行摘要

### 2. 市场份额变迁
- 各品类 Top 20 品牌席位的 3 个月走势
- CR3 / CR5 变化趋势
- 各品牌月均排名变化

### 3. 价格带迁移分析
- 各品类主力价格带是否发生移动（消费升级 or 降级信号）
- 三个月的价格分布变化可视化数据

### 4. 产品生命周期分析
- 本季稳定在 Top 10 的常青产品
- 本季退出 Top 10 的产品 + 退出原因推测
- 新品上市后的排名爬升曲线

### 5. Huawei 季度战略回顾
- 各品类排名季度走势
- 价格策略回顾：本季做了哪些调价、每次调价后排名变化的因果分析
- vs 主要竞品的 gap 分析（价格差 + 排名差 + 销量差）
- 渠道健康度：官方 vs 第三方卖家数量和价差

### 6. 宏观因素
- BRL/USD 汇率季度变化对进口成本的影响
- 关税政策变化（如有，引用 Gecex 决议编号）
- 巴西电商市场季节性因素

### 7. 下季度建议
- 价格策略建议（按产品线）
- 需要申请的资源或支持
- 风险提示

## 规则
- 全中文
- 所有百分比保留一位小数
- 每个结论标注数据来源（日期 + 品类 + 数据点）
- 存证截图链接附在附录中
- 如果是估算值，必须标注"估算"
```

### 8.6 `prompts/yearly-compare.md` — 年度同比

```markdown
# Meli 年度同比分析

## 分析要求

### 1. 同比排名对比
- 今年 vs 去年同期：各品类 Top 10 的品牌构成变化
- 哪些品牌进入 / 退出了 Top 10

### 2. 同比价格变化
- 各品类主力产品真实最低价 YoY 变化
- 巴西 IPCA 年度通胀率参考，标注剔除通胀后的实际价格变化

### 3. 市场结构变化
- 品牌集中度 CR3/CR5 YoY
- 白牌产品占比 YoY
- 官方渠道占比 YoY

### 4. Huawei 年度复盘
- 各品类排名 YoY
- 市场份额（排行榜席位占比）估算 YoY
- 全年调价动作回顾 + 效果评估
```

---

## 九、邮件分级推送配置

```json
{
  "from": "Meli Tracker <tracker@yourdomain.com>",
  "reports": {
    "daily": {
      "enabled": true,
      "recipients": ["ben@huawei.com"],
      "language": "zh",
      "prompt": "daily-self.md",
      "subject": "📊 Meli 日报 — {date}"
    },
    "weekly": {
      "enabled": true,
      "day_of_week": "monday",
      "recipients": ["ben@huawei.com", "team-brazil@huawei.com"],
      "language": "zh-en",
      "prompt": "weekly-team.md",
      "subject": "📈 Meli 周报 / Weekly Report — W{week}"
    },
    "monthly": {
      "enabled": true,
      "day_of_month": 1,
      "recipients": ["ben@huawei.com", "team-brazil@huawei.com"],
      "language": "zh",
      "prompt": "monthly-team.md",
      "subject": "📋 Meli 月报 — {year}年{month}月"
    },
    "quarterly": {
      "enabled": true,
      "recipients": ["ben@huawei.com", "hq-product@huawei.com"],
      "language": "zh",
      "prompt": "quarterly-hq.md",
      "subject": "📑 Meli 季报 — {year} Q{quarter}",
      "attach_evidence": true
    }
  }
}
```

---

## 十、GitHub Secrets 配置

| Secret 名称 | 值 | 必须？ | 说明 |
|---|---|---|---|
| `ML_APP_ID` | ML 应用 ID | ✅ | OAuth API |
| `ML_CLIENT_SECRET` | ML 应用密钥 | ✅ | OAuth API |
| `ML_REFRESH_TOKEN` | OAuth refresh token | ✅ | 脚本自动刷新 |
| `GH_PAT` | GitHub PAT | ✅ | 自动更新 refresh token |
| `RESEND_API_KEY` | Resend API Key | ✅ | 发送邮件 |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 Key | ✅ | 上传截图 |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 Secret | ✅ | 上传截图 |
| `R2_BUCKET_URL` | R2 Bucket URL | ✅ | 截图公开访问地址 |

---

## 十一、实施步骤

### 阶段一：账号准备（约 1 小时）

```
□ Step 1: 注册 ML 开发者账号 + 创建应用
□ Step 2: 完成 OAuth 授权，拿到 access_token + refresh_token
□ Step 3: 用 curl 测试 Search API 和 Items API
□ Step 4: 注册 Cloudflare R2（免费），创建 bucket
□ Step 5: 验证所有 token/key 有效
```

### 阶段二：核心抓取部署（约 1.5 小时）

```
□ Step 6: 创建 GitHub 仓库 meli-price-tracker
□ Step 7: 创建 config/categories.json
□ Step 8: 创建 scripts/fetch-top-sellers.js（含 catalog 链路）
□ Step 9: 创建 scripts/screenshot.js
□ Step 10: 创建 .github/workflows/fetch-prices.yml
□ Step 11: 配置所有 GitHub Secrets
□ Step 12: 手动触发 Actions，验证数据 + 截图
□ Step 13: 检查 data/daily/ 和 data/raw/ 是否正确生成
```

### 阶段三：分析 + 邮件（约 1 小时）

```
□ Step 14: 创建所有 prompts/
□ Step 15: 创建 scripts/deliver.js
□ Step 16: 创建 SKILL.md
□ Step 17: 手动运行完整流程：抓取 → 分析 → 发送
□ Step 18: 验证邮件内容质量
```

### 阶段四：积累 + 迭代

```
□ Step 19: 7 天后测试周报
□ Step 20: 30 天后测试月报
□ Step 21: 根据实际输出调优 prompts
□ Step 22: 90 天后测试季报
□ Step 23: 1 年后启用年度同比
```

---

## 十二、关键决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| OAuth | **必须** | catalog 多卖家真实最低价依赖认证 API |
| 价格取值 | 同时记录 buy_box + true_lowest | buy_box 是用户看到的，true_lowest 是定价决策用的 |
| 截图存储 | Cloudflare R2 | 免费 10GB 够用 4 年，不占 Git 空间 |
| API 原始响应 | Git 仓库（压缩） | 数据证据需要版本控制，压缩后 150MB/年 |
| 历史保留 | 永久 | 年度同比需要，JSONL 格式可持续追加 |
| 日报语言 | 纯中文 | 给自己看，效率最高 |
| 周报语言 | 中英双语 | 中国同事+国际同事都能看 |
| 季报 | 中文 + 附存证 | 给总部，需要专业+可验证 |
| 分析重心 | 竞品价格变动优先 | 你的 #1 需求；Huawei 排名变化放第二 |

---

## 十三、今日 MVP 执行计划（Phase 0）

> **目标：今天跑通完整链路——抓取 → 存储 → 发邮件。**
> 不含 OAuth、不含截图、不含 catalog 多卖家链路。这些后续升级加入。

### 13.1 今日范围

| 做 | 不做（后续升级） |
|----|------------------|
| ✅ Search API 无 token 抓取排行榜 | ❌ OAuth 认证 |
| ✅ 记录 buy_box 价格 + sold_quantity + attributes | ❌ catalog 多卖家真实最低价 |
| ✅ data/daily/ JSON 快照 | ❌ data/raw/ API 原始响应存证 |
| ✅ data/history/ JSONL 追加 | ❌ 截图 (Puppeteer + R2) |
| ✅ GitHub Actions 定时 + 手动触发 | ❌ token 自动刷新 |
| ✅ Resend 发邮件 (日报) | ❌ 周报/月报/季报自动化 |
| ✅ SKILL.md (`/meli` 触发) | — |

### 13.2 今日仓库结构（精简版）

```
meli-price-tracker/                       ← GitHub Public 仓库
├── .github/
│   └── workflows/
│       └── fetch-prices.yml              # 定时抓取 + 发邮件
├── config/
│   ├── categories.json                   # 8 个品类配置
│   └── email.json                        # 收件人 + 语言
├── scripts/
│   ├── fetch-top-sellers.js              # 无 OAuth 版抓取
│   ├── deliver.js                        # Resend 发邮件
│   └── package.json
├── data/
│   ├── daily/                            # 每日快照 (自动生成)
│   └── history/                          # 品类历史 (自动生成)
├── prompts/
│   └── daily-self.md                     # 日报分析指令
├── SKILL.md                              # /meli 触发
├── meli-price-tracker-blueprint-v2.1.md  # 本蓝图
└── README.md
```

### 13.3 今日 GitHub Secrets（只需 1 个）

| Secret 名称 | 值 | 说明 |
|---|---|---|
| `RESEND_API_KEY` | 你的 Resend API Key | 发送邮件 |

### 13.4 今日 Actions Workflow 设计

```yaml
name: Fetch Meli Top Sellers

on:
  schedule:
    - cron: '0 0 * * *'   # UTC 00:00 = 巴西 21:00
  workflow_dispatch:        # 手动触发

jobs:
  fetch-and-notify:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: cd scripts && npm install

      # 1. 抓取
      - name: Fetch top sellers
        run: cd scripts && node fetch-top-sellers.js

      # 2. 发邮件（把当日 JSON 作为邮件正文发送）
      - name: Send daily email
        env:
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
        run: cd scripts && node deliver.js

      # 3. 提交数据到仓库
      - name: Commit data
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/
          git diff --cached --quiet || git commit -m "data: $(date +%Y-%m-%d) [skip ci]"
          git push
```

### 13.5 SKILL.md（/meli 触发）

当你在 claude.ai 输入 `/meli` 时，Claude 会：
1. 从 GitHub 仓库拉取最新的 `data/daily/` JSON
2. 按 `prompts/daily-self.md` 分析
3. 直接在对话中输出报告
4. 如果你说"发邮件"，调用 deliver.js 发送

```yaml
---
name: meli-price-tracker
description: >
  巴西美客多 (Mercado Livre) 品类排行榜竞品价格追踪。
  覆盖手机、智能手表、耳机、平板四大品类 Mais Vendidos 排名。
  触发词：/meli、美客多价格、meli价格、今日排名、竞品价格、top seller。
---

# Mercado Livre 竞品价格追踪

## 数据源

GitHub 仓库: https://github.com/{YOUR_USERNAME}/meli-price-tracker

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
```

### 13.6 Claude Code 启动指令

把蓝图文件放到项目文件夹后，给 Claude Code 发这段话：

---

```
请阅读根目录的 meli-price-tracker-blueprint-v2.1.md，执行"十三、今日 MVP 执行计划（Phase 0）"。

具体要求：

1. 创建 config/categories.json — 用蓝图 5.1 的配置
2. 创建 scripts/fetch-top-sellers.js — 无 OAuth 版本：
   - 直接调用 ML Search API（不带 Authorization header）
   - 按 categories.json 中的品类，用 category + sort=sold_quantity_desc 查询
   - 对每个 item 再调用 /items/{id} 获取 attributes
   - 输出到 data/daily/{date}.json 和 data/history/{cat}.jsonl
   - 注意限流：每次请求间隔 500ms
3. 创建 scripts/deliver.js — 用 Resend API 发邮件：
   - 读取 data/daily/ 最新 JSON
   - 生成简洁的 HTML 邮件（各品类 Top 10 表格）
   - 通过 RESEND_API_KEY 环境变量发送
4. 创建 .github/workflows/fetch-prices.yml — 用蓝图 13.4 的设计
5. 创建 prompts/daily-self.md — 用蓝图 8.2 的内容
6. 创建 SKILL.md — 用蓝图 13.5 的内容
7. 创建 scripts/package.json — 依赖只需要 resend

仓库是 Public 的。不需要 OAuth、不需要截图、不需要 Cloudflare R2。
邮件收件人先写 {你的邮箱}。
```

---

### 13.7 升级路线图

| 阶段 | 内容 | 前置条件 | 预计时间 |
|------|------|----------|----------|
| Phase 0（今天） | 无 OAuth 抓取 + 发邮件 | Resend API Key | 今天 |
| Phase 1 | 注册 ML 开发者 + OAuth | ML 开发者账号 | 本周 |
| Phase 2 | catalog 多卖家真实最低价 | Phase 1 完成 | Phase 1 后 1 天 |
| Phase 3 | 截图存证 (Puppeteer + R2) | Cloudflare R2 账号 | 需要时再加 |
| Phase 4 | 周报/月报自动化 | 7-30 天数据积累 | 自然达成 |
| Phase 5 | 季报/年度同比 | 90-365 天数据积累 | 自然达成 |

---

*文档版本: v2.1 | 更新日期: 2026-04-10*
*v2.1 修正: OAuth 必须 + catalog 真实最低价 + 截图存证 + GTM Manager 分析框架*
*Phase 0 MVP: 无 OAuth 抓取 + Resend 邮件 + /meli Skill*
