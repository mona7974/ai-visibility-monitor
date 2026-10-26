#!/bin/bash
# ============================================================
#  AI 可见度监测台 · 本地版一键启动
#  双击本文件 → 自动启动本机服务 → 自动打开浏览器
#
#  和线上链接的区别：
#    · 本地版会自动读取 collector/out/ 里的采集结果，
#      采集器每跑完一次，刷新页面看板就是最新的（无需手动导入）；
#    · 数据只在你本机，外部访问不到。
#
#  关掉本窗口（或按回车）即停止服务。再双击本文件可随时再开。
# ============================================================

set -u
cd "$(dirname "$0")" 2>/dev/null || {
  echo "无法进入项目目录，请确认本文件没被移动。"
  read -n 1 -s -r -p "按任意键关闭…"; exit 1
}
ROOT="$(pwd)"
APP_DIR="$ROOT/monitor"
PORT="${GEO_MONITOR_PORT:-8765}"
URL="http://127.0.0.1:$PORT/"

GRN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; CYA=$'\033[36m'; BOLD=$'\033[1m'; RST=$'\033[0m'

# ---------- 找 Python ----------
PY=""
for c in "$HOME/.workbuddy/binaries/python/envs/default/bin/python" \
         "$(command -v python3 2>/dev/null || true)" \
         "/usr/local/bin/python3" "/opt/homebrew/bin/python3"; do
  [ -n "$c" ] && [ -x "$c" ] && { PY="$c"; break; }
done
if [ -z "$PY" ]; then
  echo "${RED}✗ 没找到可用的 Python。${RST}请把这条信息发我。"
  read -n 1 -s -r -p "按任意键关闭…"; exit 1
fi

# ---------- 端口占用检查（已开着就直接打开浏览器） ----------
if lsof -ti ":$PORT" >/dev/null 2>&1; then
  echo "${YEL}!${RST} 端口 $PORT 已有监测台在跑，直接为你打开页面。"
  open "$URL"
  echo
  echo "页面已在浏览器打开：$URL"
  read -n 1 -s -r -p "按任意键关闭这个窗口（服务继续在后台运行）…"
  exit 0
fi

if [ ! -f "$APP_DIR/server.py" ]; then
  echo "${RED}✗ 找不到 $APP_DIR/server.py${RST}，监测台文件可能被移动了。"
  read -n 1 -s -r -p "按任意键关闭…"; exit 1
fi

# ---------- 启动服务 ----------
PORT="$PORT" "$PY" "$APP_DIR/server.py" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

# 等服务就绪（最多 5 秒）
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/ping" 2>/dev/null; then break; fi
  sleep 0.5
done

# 打开浏览器
open "$URL" 2>/dev/null || echo "请手动在浏览器打开：$URL"

clear 2>/dev/null || true
echo
echo "${GRN}✓${RST} 监测台已在浏览器打开：${BOLD}$URL${RST}"
echo
echo "  使用说明："
echo "  · ${BOLD}采集器跑完后${RST}，回到这个页面${BOLD}刷新（Cmd+R）${RST}，数据自动进来"
echo "  · 页面顶部的黄色提示会变成「已连接本机采集器」"
echo "  · 这个窗口保持开着就行；关掉窗口服务即停止"
echo "  · 采集器用同目录下的 ${CYA}collector/运行采集.command${RST} 启动"
echo
echo "────────────────────────────────────────────────────────"
read -r -p "按回车键停止监测台服务并关闭… "
echo "服务已停止。"
