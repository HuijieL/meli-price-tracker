# Phase 1 上线纪要 + 日常运维手册

**上线日期**: 2026-04-17
**仓库**: <https://github.com/HuijieL/meli-price-tracker>
**状态**: ✅ 每日定时跑（巴西 21:00 / UTC 00:00），无需人工介入

---

## ✅ 已完成

### 1. ML Developer App 注册

应用名：**PriceTracker**（`Aplicativo não certificada`，个人开发者免审核）

| 字段 | 值 |
|---|---|
| App ID / Client ID | `1599168458123024` |
| Redirect URI | `https://oauth.pstmn.io/v1/callback`（Postman 公共 callback） |
| 授权流程 | Authorization Code + Refresh Token |
| PKCE | 未启用 |
| Webhook 主题 | 全关（Pull 架构不需要 push） |
| 权限 | 全 Leitura（只读） |
| Client Secret | 在 [.env.local](./.env.local)（**未轮换**，session 中明文过一次；read-only scope 低危） |

### 2. OAuth 凭证

- `ML_USER_ID` = `1747120514`
- Scope 包含 `offline_access` + 全 `read-only`
- **access_token**：6 小时有效，每次 fetch 前自动刷
- **refresh_token**：6 个月有效，**每次 refresh 会轮换**，workflow 自动写回 secret

### 3. Phase 1 + 2 代码落地

**新增**：
- [`scripts/lib/ml-oauth.js`](./scripts/lib/ml-oauth.js) — token refresh + 轮换持久化
  - 本地：直接改写 `.env.local`
  - Actions：emit `::set-env-local::ML_REFRESH_TOKEN=...` stdout marker，workflow 解析后用 `gh secret set` 写回
- [`scripts/lib/ml-api.js`](./scripts/lib/ml-api.js) — `MLClient`，封装 3 个核心端点
  - 150 ms 内置 throttle，指数退避重试
  - `normalizeProduct()` 提取 BRAND/MODEL/INTERNAL_MEMORY 等属性
  - `summarizeSellers()` 计算 min/max/spread_pct/seller_count

**重构**：
- [`scripts/fetch-top-sellers.js`](./scripts/fetch-top-sellers.js) — 3 段式 pipeline（highlights → products → items）
  - concurrency = 3，TOP_N = 20
  - schema_version: 2 — key 从 `item_id` 迁到 `catalog_product_id`
  - 所有品类全 0 条时 exit 2（防空快照）
- [`scripts/deliver.js`](./scripts/deliver.js) — 邮件模板升级
  - `<meta charset="utf-8">` + 中文字体 fallback（解决乱码）
  - 🔥 badge：`price_spread_pct >= 20%`
  - 排名变化 ↑↓ 徽章
  - Huawei 品牌高亮 ★

**Workflow**：
- [`.github/workflows/fetch-prices.yml`](./.github/workflows/fetch-prices.yml) — 4 个新 env + rotate-secret 步骤

### 4. GitHub Secrets 全部配置

| Secret | 来源 | 备注 |
|---|---|---|
| `RESEND_API_KEY` | 专门给 Meli Tracker 的 Resend key（`re_dCK...`） | 发送权限 |
| `ML_APP_ID` | `1599168458123024` | 公开 |
| `ML_CLIENT_SECRET` | `.env.local` | 私密 |
| `ML_REFRESH_TOKEN` | 每日自动轮换 | 私密，写回靠 GH_PAT |
| `GH_PAT` | fine-grained PAT | 见下 |

### 5. GH_PAT 细节（踩过的坑，下次别忘）

**Fine-grained PAT** at <https://github.com/settings/tokens?type=beta>

必选权限（缺一不可，第一次创建漏了 Secrets 就是白做）：

| 类别 | 权限 | 级别 |
|---|---|---|
| Repository access | Only `HuijieL/meli-price-tracker` | — |
| Repository permissions → Metadata | （默认） | Read |
| Repository permissions → **Secrets** | **必须手动添加** | **Read and write** |

**验证 PAT 是否够用**：本地跑 `gh secret set TEST_KEY --body "x" && gh secret delete TEST_KEY` 不报 403 就 OK。

---

## 🔧 日常运维

### 正常情况：啥都不做

Actions 每天 UTC 00:00 自动跑。看邮箱就行。

### 如果哪天邮件没来

1. 看 <https://github.com/HuijieL/meli-price-tracker/actions>
2. 找红叉那条 run → 点进去看哪步红了
3. 看 `Fetch top sellers` 步骤：
   - 如果是 `ML API 401/403` → refresh_token 失效了，走下面"6 个月重新授权"
   - 如果是 `All categories returned 0 items` → ML API 端侧故障，第二天再看
4. 看 `Rotate ML_REFRESH_TOKEN secret` 步骤：
   - `HTTP 403: Resource not accessible` → GH_PAT 权限或过期了，重生成 PAT 并 `gh secret set GH_PAT`

### 手动触发

```bash
cd "/Users/li/Desktop/Meli- tracker"
gh workflow run fetch-prices.yml
gh run watch  # 看实时进度
```

### 本地跑一次（调试用）

```bash
cd "/Users/li/Desktop/Meli- tracker/scripts"
node fetch-top-sellers.js   # 读 ../.env.local，跑完回写新 refresh_token
node deliver.js              # 发邮件
```

⚠️ 本地跑完 refresh_token 也会轮换，但只写回本地 `.env.local`，**GitHub secret 不会同步**。
下次 Actions 跑时会失败（secret 里的是旧 token，已被 ML 作废）。
补救方法：复制 `.env.local` 里的新值，`gh secret set ML_REFRESH_TOKEN --body "TG-..."`。

---

## 🔑 6 个月后重新授权（refresh_token 彻底到期时）

refresh_token 的 6 个月有效期是 ML 硬性上限，到期必须走一次浏览器授权。到期时间 ≈ **2026-10-16**。

```bash
# Step 1: 浏览器打开（拿新 code）
open "https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=1599168458123024&redirect_uri=https://oauth.pstmn.io/v1/callback"

# Step 2: 从 pstmn callback 页面复制 code=TG-xxx（URL 里）

# Step 3: 换 token（替换 CODE）
source "/Users/li/Desktop/Meli- tracker/.env.local"
curl -X POST "https://api.mercadolibre.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "client_id=$ML_APP_ID" \
  -d "client_secret=$ML_CLIENT_SECRET" \
  -d "code=TG-xxxxxxxxxxxxxxxxxxx" \
  -d "redirect_uri=https://oauth.pstmn.io/v1/callback"

# Step 4: 把返回的新 refresh_token 同时写到两处
cd "/Users/li/Desktop/Meli- tracker"
# a) 本地
#    编辑 .env.local，替换 ML_REFRESH_TOKEN 的值
# b) GitHub
gh secret set ML_REFRESH_TOKEN --body "TG-新值"
```

## 🔄 如果 access_token 过期但 refresh_token 还在

正常情况下 workflow / 本地脚本会自动处理。手动验证用：

```bash
source "/Users/li/Desktop/Meli- tracker/.env.local"
curl -X POST "https://api.mercadolibre.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "client_id=$ML_APP_ID" \
  -d "client_secret=$ML_CLIENT_SECRET" \
  -d "refresh_token=$ML_REFRESH_TOKEN"
# 返回的新 refresh_token 必须写回 .env.local + GitHub secret
```

---

## 📂 凭证与文件索引

| 文件 | 内容 | Git 状态 |
|---|---|---|
| [`.env.local`](./.env.local) | ML_APP_ID / CLIENT_SECRET / ACCESS_TOKEN / REFRESH_TOKEN / USER_ID / RESEND_API_KEY | gitignored ✅ |
| [`.gitignore`](./.gitignore) | 含 `.env.local`、`data/email-preview-*.html` | 已提交 |
| [`logo.png`](./logo.png) | ML 开发者平台的应用 logo（512×512） | 已提交 |
| [`make-logo.py`](./make-logo.py) | Logo 生成脚本 | 已提交 |

## 🔗 关键文档链接

- ML Dev Center: <https://developers.mercadolivre.com.br/devcenter>
- ML API 文档（products）: <https://developers.mercadolivre.com.br/en_us/products-management>
- ML OAuth 文档: <https://developers.mercadolivre.com.br/en_us/authentication-and-authorization>
- GitHub fine-grained PAT: <https://github.com/settings/tokens?type=beta>
- Postman callback（redirect URI）: <https://oauth.pstmn.io/v1/callback>
