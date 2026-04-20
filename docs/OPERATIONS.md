# 运维手册

**状态**：每日定时跑（巴西 20:01 / UTC 23:01），无需人工介入
**仓库**：<https://github.com/HuijieL/meli-price-tracker>

---

## 正常情况

啥都不做。Actions 有两个 cron：

- **主**：`1 23 * * *` = UTC 23:01 = 巴西 20:01（每晚按时跑）
- **备**：`33 2 * * *` = UTC 02:33 = 巴西 **同一天** 23:33（主若被 GH 丢弃则兜底）

备份 cron 会先检查 `data/daily/{今日巴西日期}.json` 是否已存在：存在则所有 step 全 skip 空跑退出；不存在才完整抓一遍。幂等，零成本。

邮件由 `/meli` skill 本地触发时发送。

> **历史注**：2026-04-19 前用的是 `0 0 * * *`（UTC 00:00 / 巴西 21:00）。该时段是 GitHub Actions 调度高峰，scheduled workflows 常被静默丢弃，4-17/4-18 都碰过。改到 `1 23 * * *` 避开整点 + 加 backup cron 双保险。

## 凭证索引

| Secret / 文件 | 内容 | 位置 |
|---|---|---|
| `RESEND_API_KEY` | Resend API Key（Meli Tracker 专用） | GH Secret + `.env.local` |
| `ML_APP_ID` | `1599168458123024` | GH Secret + `.env.local`（公开信息） |
| `ML_CLIENT_SECRET` | ML 应用密钥 | GH Secret + `.env.local` |
| `ML_REFRESH_TOKEN` | OAuth refresh token，6 个月有效，**每次用会轮换** | GH Secret + `.env.local`（workflow 自动写回 secret） |
| `GH_PAT` | Fine-grained PAT，用于 workflow 回写 `ML_REFRESH_TOKEN` | GH Secret |
| `ML_USER_ID` | `1747120514` | `.env.local` |

ML 应用配置：redirect URI `https://oauth.pstmn.io/v1/callback`，authorization code + refresh token 流程，全 Leitura 只读权限，PKCE 未启用。

---

## 如果哪天邮件没来

1. 看 <https://github.com/HuijieL/meli-price-tracker/actions>
2. 找红叉那条 run → 点进去看哪步红了
3. 看 **`Fetch top sellers`** 步骤：
   - `ML API 401/403` → refresh_token 失效，走下面「6 个月重新授权」
   - `All categories returned 0 items` → ML API 端侧故障，第二天再看
4. 看 **`Rotate ML_REFRESH_TOKEN secret`** 步骤：
   - `HTTP 403: Resource not accessible` → GH_PAT 权限或过期了，重生成 PAT 并 `gh secret set GH_PAT`

## 手动触发 Actions

```bash
cd "/Users/li/Desktop/Meli- tracker"
gh workflow run fetch-prices.yml
gh run watch
```

## 本地跑一次（调试用）

```bash
cd "/Users/li/Desktop/Meli- tracker/scripts"
node fetch-top-sellers.js   # 读 ../.env.local，跑完回写新 refresh_token
node deliver.js --md /tmp/meli-analysis.md  # 发邮件
```

⚠️ **本地跑会踩坑**：refresh_token 轮换后只写回 `.env.local`，GitHub secret 不会同步。下次 Actions 会拿旧 token → 401。
补救：

```bash
cd "/Users/li/Desktop/Meli- tracker"
source .env.local && gh secret set ML_REFRESH_TOKEN --body "$ML_REFRESH_TOKEN"
```

想避开这个坑 → 用 `gh workflow run fetch-prices.yml` 让 Actions 跑，自己会处理轮换。

---

## 🔑 6 个月重新授权（refresh_token 彻底到期）

refresh_token 6 个月硬性上限。到期时间 ≈ **2026-10-16**。到期后必须走一次浏览器授权。

```bash
# Step 1: 浏览器拿 authorization code
open "https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=1599168458123024&redirect_uri=https://oauth.pstmn.io/v1/callback"

# Step 2: 从 pstmn callback 页面 URL 复制 code=TG-xxx

# Step 3: 换 token（替换 CODE）
source "/Users/li/Desktop/Meli- tracker/.env.local"
curl -X POST "https://api.mercadolibre.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "client_id=$ML_APP_ID" \
  -d "client_secret=$ML_CLIENT_SECRET" \
  -d "code=TG-xxxxxxxxxxxxxxxxxxx" \
  -d "redirect_uri=https://oauth.pstmn.io/v1/callback"

# Step 4: 新 refresh_token 写到两处
cd "/Users/li/Desktop/Meli- tracker"
# a) 编辑 .env.local 替换 ML_REFRESH_TOKEN
# b) 同步到 GitHub
gh secret set ML_REFRESH_TOKEN --body "TG-新值"
```

## access_token 过期但 refresh_token 还在

正常情况 workflow / 脚本会自动处理。手动验证：

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

## GH_PAT 权限（坑过一次，存档）

Fine-grained PAT at <https://github.com/settings/tokens?type=beta>

必选权限（缺一不可）：

| 类别 | 权限 | 级别 |
|---|---|---|
| Repository access | Only `HuijieL/meli-price-tracker` | — |
| Repository permissions → Metadata | （默认） | Read |
| Repository permissions → **Secrets** | **必须手动添加** | **Read and write** |

验证 PAT 够用：`gh secret set TEST_KEY --body "x" && gh secret delete TEST_KEY` 不报 403 即 OK。

---

## 关键链接

- ML Dev Center: <https://developers.mercadolivre.com.br/devcenter>
- ML Products API: <https://developers.mercadolivre.com.br/en_us/products-management>
- ML OAuth: <https://developers.mercadolivre.com.br/en_us/authentication-and-authorization>
- GH fine-grained PAT: <https://github.com/settings/tokens?type=beta>
- Postman callback: <https://oauth.pstmn.io/v1/callback>
