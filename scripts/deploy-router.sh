#!/usr/bin/env bash
# 将 dist/chksz.jsplugin.zip 更新到路由器中的 Songloft lite。
#
# 用法:
#   ./scripts/deploy-router.sh
#
# 可用环境变量覆盖:
#   ROUTER_HOST=192.168.31.1    路由器/Songloft 地址
#   ROUTER_PORT=58091           Songloft 端口
#   ADMIN_USER=admin            Songloft 管理员用户名
#   ADMIN_PASSWORD=admin        Songloft 管理员密码
#   ZIP=dist/chksz.jsplugin.zip 本地插件包路径
#
# 依赖: curl + python3
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIP_PATH="${ZIP:-$ROOT_DIR/dist/chksz.jsplugin.zip}"
ROUTER_HOST="${ROUTER_HOST:-192.168.31.1}"
ROUTER_PORT="${ROUTER_PORT:-58091}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
BASE_URL="http://${ROUTER_HOST}:${ROUTER_PORT}"

for cmd in curl python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "缺少依赖命令: $cmd" >&2
    exit 1
  fi
done

if [ ! -f "$ZIP_PATH" ]; then
  echo "找不到插件包: $ZIP_PATH" >&2
  echo "请先执行 npm run build" >&2
  exit 1
fi

echo "==> 目标服务: $BASE_URL"
echo "==> 插件包:   $ZIP_PATH"

echo "==> 检查服务健康状态"
health="$(curl -fsS -m 10 "$BASE_URL/api/v1/health")"
if ! echo "$health" | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("status")=="ok" else 1)'; then
  echo "Songloft 健康检查失败: $health" >&2
  exit 1
fi

echo "==> 登录 Songloft"
login_json="$(curl -fsS -m 10 -X POST "$BASE_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASSWORD}\"}")"
TOKEN="$(echo "$login_json" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("access_token") or "")')"
if [ -z "$TOKEN" ]; then
  echo "登录失败: $login_json" >&2
  exit 1
fi

echo "==> 上传并安装插件"
upload_json="$(curl -fsS -m 120 -X POST "$BASE_URL/api/v1/jsplugins/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@${ZIP_PATH}")"

echo "$upload_json" | python3 -m json.tool

echo "$upload_json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if int(d.get("success") or 0) != 1:
    print("上传失败", file=sys.stderr); sys.exit(1)
results = d.get("results") or []
for r in results:
    if not r.get("success"):
        print("插件安装失败:", r, file=sys.stderr); sys.exit(1)
print("上传成功，共安装/更新 %d 个插件" % len(results))
for r in results:
    p = r.get("plugin") or {}
    print("  %s -> v%s" % (p.get("entry_path") or r.get("file_name"), p.get("version")))
'

echo "==> 校验远端插件版本"
plugins_json="$(curl -fsS -m 10 "$BASE_URL/api/v1/jsplugins" -H "Authorization: Bearer $TOKEN")"
echo "$plugins_json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for p in d.get("plugins") or []:
    if p.get("entry_path") == "chksz":
        print("  远端 chksz: v%s (%s)" % (p.get("version"), p.get("status")))
        sys.exit(0)
print("  未在远端找到 chksz 插件", file=sys.stderr); sys.exit(1)
'

echo "==> 更新完成"
