# Phase 1 进度 & 续作手册

**Session Date**: 2026-04-16
**仓库**: <https://github.com/HuijieL/meli-price-tracker>
**下一步**: 改代码，本地跑通 8 品类，推 GitHub Secrets，上线 Actions

---

## ✅ 已完成

### 1. ML Developer App 注册

应用名：**PriceTracker**
状态：`Aplicativo não certificada`（个人开发者，免审核，正常可用）

| 字段 | 值 |
|---|---|
| App ID / Client ID | `1599168458123024` |
| Redirect URI | `https://oauth.pstmn.io/v1/callback` |
| 授权流程 | Authorization Code + Refresh Token |
| Business Unit | Mercado Livre（非 VIS） |
| PKCE | 未启用 |
| Webhook 主题 | 全关（Pull 架构不需要 push） |
| 权限（UI 强制至少 Leitura） | 全部 `Leitura`（只读，代码实际只调公共资源） |
| Client Secret | 在 [.env.local](./.env.local)（**未轮换**，本次 session 明文过一次，用户已知风险，read-only scope 低危） |

### 2. OAuth 凭证已获取

首次 Authorization Code 流程走通。token 详情在 [.env.local](./.env.local)：

- `ML_ACCESS_TOKEN` — 6 小时有效，生成时间 2026-04-16
- `ML_REFRESH_TOKEN` — 6 个月有效，**每次 refresh 会轮换新值**
- `ML_USER_ID` = `1747120514`
- Scope 包含 `offline_access` + 全 `read-only`

⚠️ **access_token 很快会过期**，后续代码必须先用 refresh_token 换新 token 再调 API，不要直接依赖 .env.local 里的这个值。

### 3. API 能力验证（关键发现）

| Endpoint | Auth 必需 | 状态 | 用途 |
|---|---|---|---|
| `GET /sites/MLB/search?category={CAT}` | ✅ | ❌ **403 forbidden** | 不可用，放弃 |
| `GET /items/{MLB_ID}` | ✅ | ⚠️ 需已知 item ID 且存在 | 非核心路径 |
| `GET /categories/{CAT}` | ❌（公开） | ✅ | 品类元数据 |
| `GET /users/me` | ✅ | ✅ | 健康检查用 |
| **`GET /highlights/MLB/category/{CAT}`** | ✅ | ✅ **核心** | **官方 Mais Vendidos 排行，返回 catalog product ID + position** |
| **`GET /products/{PID}`** | ✅ | ✅ **核心** | 商品详情：品牌/型号/attributes/图片 |
| **`GET /products/{PID}/items?limit=N`** | ✅ | ✅ **核心** | 多卖家真实最低价，支持发现隐藏底价 |

### 4. 真实数据样本（2026-04-16 手机 Top 1）

**Motorola Moto G06** (128GB, 12GB RAM, 6.9" 屏) — product ID `MLB61424002`
- 5 个卖家同时在卖
- MIN: **R$799** ← → MAX: **R$989.9**
- **价差 23.9%**

这正是 Phase 2 需要的数据：橱窗价（buy box）≠ 真实底价，必须走 catalog 多卖家才能发现。

---

## 🚧 待办（下次 session 续作）

### Step A — 改代码（90 分钟）

**新增**：

- [ ] `scripts/lib/ml-oauth.js` — 封装 refresh 逻辑
  - `refreshAccessToken(refreshToken, appId, secret) → { accessToken, newRefreshToken, expiresIn }`
  - ML 每次 refresh 会返回新的 refresh_token，必须写回 GitHub Secret
- [ ] `scripts/lib/ml-api.js` — 3 个核心端点封装
  - `getHighlights(categoryId, token) → [{id, position, type}]`
  - `getProduct(productId, token) → {name, brand, model, attributes, pictures, buy_box_winner, ...}`
  - `getProductSellers(productId, token, limit=20) → [{price, seller_id, official_store_id, shipping, ...}]`
  - 内置 rate limit（ML 限制 ~1000 req/hour，我们 8 类 × 20 商品 × 2 API = 320 req，够用但要加 100ms 间隔防限流）

**重构**：

- [ ] `scripts/fetch-top-sellers.js` —— 从 HTML 抓取改为 API 三段式
  - Input: `config/categories.json` 的 8 个品类
  - Pipeline：
    1. highlights → Top 20 product IDs
    2. 并发（concurrency=3）调 `/products/{pid}` 拿结构化属性
    3. 并发调 `/products/{pid}/items` 拿多卖家价格，计算 `min_price` / `max_price` / `price_spread_pct` / `seller_count`
  - Output schema（new fields 加粗）：
    ```json
    {
      "date": "2026-04-17",
      "categories": [{
        "id": "MLB1055",
        "name": "Celulares e Smartphones",
        "items": [{
          "rank": 1,
          "catalog_product_id": "MLB61424002",
          "name": "Smartphone Motorola Moto G06 ...",
          "brand": "Motorola",
          "model": "Moto G06",
          "attributes": {
            "INTERNAL_MEMORY": "128 GB",
            "RAM_MEMORY": "12 GB",
            "COLOR": "Preto",
            "DISPLAY_SIZE": "6.9 \""
          },
          "buy_box_price": 849,
          "min_price": 799,
          "max_price": 989.9,
          "price_spread_pct": 23.9,
          "seller_count": 5,
          "official_sellers": []
        }]
      }]
    }
    ```

- [ ] `scripts/deliver.js` —— 邮件模板升级
  - 展示真实最低价（不只是 buy box）
  - 标注价差百分比（> 15% 飘红：说明有价格战）
  - 显示 attributes（内存/颜色），便于辨认是哪个版本

### Step B — 本地验证（15 分钟）

```bash
cd "/Users/li/Desktop/Meli- tracker/scripts"
# 从 ../.env.local 加载
source <(grep -v '^#' ../.env.local | sed 's/^/export /')
node fetch-top-sellers.js    # 应该生成 data/daily/2026-04-17.json
node deliver.js               # 邮件预览
```

检查点：
- [ ] 8 品类全部拿到 Top 20
- [ ] 每个商品有 `attributes`（品牌、内存、颜色）
- [ ] `min_price` 存在且 ≤ `buy_box_price`
- [ ] 邮件渲染正常

### Step C — 推 GitHub Secrets + 上线 Actions（20 分钟）

需要的 4 个新 Secret：

```
ML_APP_ID=1599168458123024
ML_CLIENT_SECRET=<从 .env.local 复制>
ML_REFRESH_TOKEN=<本地跑完最新一次 refresh 后的值>
GH_PAT=<需要新创建：github.com/settings/tokens，scope=repo>
```

GH_PAT 用途：每天跑完 `refresh` 后把新 refresh_token 写回 repo secret。用 `gh` CLI 或 `octokit` 的 `PATCH /repos/{owner}/{repo}/actions/secrets/{name}`。

Workflow 改动：
- [ ] `.github/workflows/fetch-prices.yml`
  - job 开头先 `node scripts/refresh-token.js`（拿新 access_token，写到 `$GITHUB_ENV`）
  - fetch-top-sellers.js 读环境变量 `ML_ACCESS_TOKEN`
  - 最后 commit 数据 + 如果 refresh_token 有变化，用 GH_PAT 更新 secret

### Step D — 考虑项（不阻塞但要想清楚）

- **MLB1051（手机大类含配件）仍依赖 Phase 0 HTML**？—— 需要测 `/highlights/MLB/category/MLB1051` 能不能返回。如果返回的是混合内容（手机 + 配件），那它在 GTM 视角意义不大，可以干脆删掉这个品类只保留 MLB1055。
- **buy_box_winner 不总是最低价**：ML 的 buy box 算法综合了价格 + 评分 + 配送 + 信誉，所以"真实最低价 ≠ buy box 价"是常态，不是 bug。邮件里两个都展示。
- **Client Secret 未轮换**：本次 session 明文过一次。用户评估后选择不换（read-only scope 低危）。**如果后续任何时候疑似泄露扩大，立刻去 devcenter 点 Renove agora**。
- **Phase 3 截图**：推迟。Phase 1 + Phase 2 的 API 数据已经比截图信息量大，截图留作审计存证用，不是核心数据源。

---

## 📂 凭证与文件索引

| 文件 | 内容 | Git 状态 |
|---|---|---|
| [`.env.local`](./.env.local) | ML_APP_ID / ML_CLIENT_SECRET / ML_ACCESS_TOKEN / ML_REFRESH_TOKEN / ML_USER_ID | gitignored ✅ |
| [`.gitignore`](./.gitignore) | `.env.local`, `node_modules/`, `.DS_Store`, `*.log`, `.env` | 已提交 |
| [`logo.png`](./logo.png) | 512×512 PriceTracker logo（上传到 ML 开发者平台用的） | 已提交 |
| [`make-logo.py`](./make-logo.py) | Logo 生成脚本（PIL） | 已提交 |
| [`meli-price-tracker-blueprint-v2.1_2.md`](./meli-price-tracker-blueprint-v2.1_2.md) | 完整设计蓝图 | 已提交 |

## 🔗 关键文档链接

- ML Dev Center: https://developers.mercadolivre.com.br/devcenter
- ML API 文档（products）: https://developers.mercadolivre.com.br/en_us/products-management
- ML OAuth 文档: https://developers.mercadolivre.com.br/en_us/authentication-and-authorization
- Postman callback (我们用的 redirect URI): https://oauth.pstmn.io/v1/callback

## 🧪 快速重新授权（如果 refresh_token 失效）

```bash
# Step 1: 浏览器打开（拿新 code）
open "https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=1599168458123024&redirect_uri=https://oauth.pstmn.io/v1/callback"

# Step 2: 从 pstmn callback 页面复制 code=TG-xxx
# Step 3: 换 token（替换 CODE 和 SECRET）
curl -X POST "https://api.mercadolibre.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "client_id=1599168458123024" \
  -d "client_secret=$ML_CLIENT_SECRET" \
  -d "code=TG-xxxxxxxxxxxxxxxxxxx" \
  -d "redirect_uri=https://oauth.pstmn.io/v1/callback"
```

## 🧪 快速 refresh（access_token 过期时）

```bash
source .env.local
curl -X POST "https://api.mercadolibre.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "client_id=$ML_APP_ID" \
  -d "client_secret=$ML_CLIENT_SECRET" \
  -d "refresh_token=$ML_REFRESH_TOKEN"
# 返回的新 refresh_token 必须写回 .env.local（每次都会换）
```
