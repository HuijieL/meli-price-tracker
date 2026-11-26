#!/usr/bin/env bash
# Mercado Livre 重新授权（一键版）
# 用法：bash scripts/reauth.sh
# 你只需：浏览器登录 ML → 点同意 → 把跳转后网址里的 code 粘贴回终端。
set -euo pipefail
cd "$(dirname "$0")/.."
# Don't `source` .env.local: ML_SCOPES has unquoted spaces (e.g. "... read ...") that bash would execute.
ML_APP_ID=$(grep -E '^ML_APP_ID=' .env.local | head -1 | cut -d= -f2-)
ML_CLIENT_SECRET=$(grep -E '^ML_CLIENT_SECRET=' .env.local | head -1 | cut -d= -f2-)
[ -z "$ML_APP_ID" ] || [ -z "$ML_CLIENT_SECRET" ] && { echo "❌ .env.local 缺 ML_APP_ID / ML_CLIENT_SECRET"; exit 1; }
REDIRECT="https://oauth.pstmn.io/v1/callback"

echo "① 正在打开浏览器，请用你的 Mercado Livre 账号登录并点「Permitir / 允许」"
open "https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_APP_ID}&redirect_uri=${REDIRECT}"
echo
echo "② 登录后浏览器会跳到一个 Postman 页面，地址栏网址里有一段 code=TG-xxxx"
read -r -p "   把整个网址（或只是 TG- 开头那段）粘贴到这里，回车： " INPUT
CODE=$(printf '%s' "$INPUT" | grep -oE 'TG-[A-Za-z0-9-]+' | head -1)
[ -z "$CODE" ] && { echo "❌ 没找到 TG- 开头的 code，请重来"; exit 1; }

echo "③ 换取新 token…"
RESP=$(curl -s -X POST "https://api.mercadolibre.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "client_id=${ML_APP_ID}" \
  --data-urlencode "client_secret=${ML_CLIENT_SECRET}" \
  --data-urlencode "code=${CODE}" \
  --data-urlencode "redirect_uri=${REDIRECT}")
ACCESS=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))')
REFRESH=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("refresh_token",""))')
if [ -z "$REFRESH" ]; then
  echo "❌ 换 token 失败（code 只能用一次、10 分钟内有效）：" >&2
  printf '%s\n' "$RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("message"),d.get("error"))' >&2
  exit 1
fi

echo "④ 写回 .env.local 和 GitHub secret…"
python3 - "$ACCESS" "$REFRESH" <<'PY'
import sys,re
a,r=sys.argv[1],sys.argv[2]
s=open('.env.local').read()
for k,v in (('ML_ACCESS_TOKEN',a),('ML_REFRESH_TOKEN',r)):
    s=re.sub(rf'^{k}=.*$',f'{k}={v}',s,flags=re.M) if re.search(rf'^{k}=',s,re.M) else s.rstrip('\n')+f'\n{k}={v}\n'
open('.env.local','w').write(s)
PY
gh secret set ML_REFRESH_TOKEN --body "$REFRESH" >/dev/null
echo "   ✅ 已更新"

echo "⑤ 测试价格接口…"
CODE_HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${ACCESS}" \
  "https://api.mercadolibre.com/products/MLB54982411/items?limit=1")
if [ "$CODE_HTTP" = "200" ]; then
  echo "🎉 价格接口恢复了（HTTP 200）！回 Claude 说一声即可。"
else
  echo "⚠️  价格接口仍返回 HTTP ${CODE_HTTP}。授权本身已更新成功，但 ML 那边还在限制，回 Claude 说一声。"
fi
