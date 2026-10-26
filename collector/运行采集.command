#!/bin/bash
# ============================================================
#  AI 可见度监测台 · 网页回答采集器（一键启动器）
#  双击本文件即可运行；也可以在终端里执行：
#     bash "运行采集.command" kimi      # 直接采某个平台
#     bash "运行采集.command" all       # 依次采全部平台
#     bash "运行采集.command" list      # 只看平台与问题清单
#     bash "运行采集.command" cali kimi # 校准某平台的抓取选择器
#
#  说明：本脚本只负责选平台、开浏览器、调 collector.py。
#        不涉及任何账号密码，登录由你自己在浏览器里扫码完成。
# ============================================================

set -u
cd "$(dirname "$0")" 2>/dev/null || {
  echo "无法进入采集器目录，请确认本文件没被移动。"
  read -n 1 -s -r -p "按任意键关闭…"; exit 1
}
DIR="$(pwd)"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YEL=$'\033[33m'
RED=$'\033[31m'; CYA=$'\033[36m'; RST=$'\033[0m'

pause_exit() {
  echo
  read -n 1 -s -r -p "按任意键关闭这个窗口…"
  echo
  exit "${1:-0}"
}

hr() { printf '%s\n' "────────────────────────────────────────────────────────"; }

clear 2>/dev/null || true
hr
echo "${BOLD}  AI 可见度监测台 · 网页回答采集器${RST}"
echo "${DIM}  本机运行 · 有头浏览器 · 登录由你自己完成${RST}"
hr
echo

# ---------- 1. 找可用的 Python（必须带 playwright） ----------
PY=""
CANDIDATES=(
  "$HOME/.workbuddy/binaries/python/envs/default/bin/python"
  "$(command -v python3 2>/dev/null || true)"
  "$(command -v python 2>/dev/null || true)"
  "/usr/local/bin/python3"
  "/opt/homebrew/bin/python3"
)
for c in "${CANDIDATES[@]}"; do
  [ -n "$c" ] || continue
  [ -x "$c" ] || continue
  if "$c" -c "import playwright" >/dev/null 2>&1; then PY="$c"; break; fi
done

if [ -z "$PY" ]; then
  echo "${RED}✗ 没找到装好 Playwright 的 Python 环境。${RST}"
  echo
  echo "修复办法（复制这一行到终端执行，然后重新双击本文件）："
  echo "  ${CYA}python3 -m pip install playwright${RST}"
  echo "  ${CYA}python3 -m playwright install chromium${RST}"
  pause_exit 1
fi
echo "${GRN}✓${RST} Python 环境就绪  ${DIM}($PY)${RST}"

# ---------- 2. 找 Chromium（Playwright 自带的那份） ----------
if ! compgen -G "$HOME/Library/Caches/ms-playwright/chromium-*" >/dev/null 2>&1; then
  echo "${YEL}!${RST} 还没装浏览器内核，正在自动安装（约 150MB，只装一次）…"
  "$PY" -m playwright install chromium || {
    echo "${RED}✗ 浏览器内核安装失败。${RST}请把上面的报错发我。"
    pause_exit 1
  }
fi
echo "${GRN}✓${RST} 浏览器内核就绪"

# ---------- 3. 读平台清单（从 config.json 动态取，避免菜单和配置打架） ----------
MENU_KEYS=(); MENU_NAMES=()
while IFS='|' read -r k n; do
  [ -n "$k" ] || continue
  [ "$k" = "stub" ] && continue          # 本地测试桩，不对外暴露
  MENU_KEYS+=("$k"); MENU_NAMES+=("$n")
done < <("$PY" - <<'PYEOF' 2>/dev/null
import json, pathlib
try:
    d = json.loads(pathlib.Path("config.json").read_text(encoding="utf-8"))
    for k, v in d.get("platforms", {}).items():
        print(f'{k}|{v.get("name", k)}')
except Exception:
    pass
PYEOF
)

if [ "${#MENU_KEYS[@]}" -eq 0 ]; then
  echo "${RED}✗ 读不到 config.json 里的平台列表。${RST}"
  echo "请确认 ${DIR}/config.json 存在且格式没被改坏。"
  pause_exit 1
fi

QCOUNT="$("$PY" - <<'PYEOF' 2>/dev/null
import json, pathlib
try:
    q = json.loads(pathlib.Path("questions.json").read_text(encoding="utf-8"))
    print(len([x for x in q.get("questions", []) if str(x).strip()]))
except Exception:
    print(0)
PYEOF
)"
echo
echo "问题清单：${BOLD}${QCOUNT}${RST} 条   ${DIM}（想改问题就编辑 questions.json，不用动代码）${RST}"
echo

# ---------- 4. 命令行参数直达（不走菜单） ----------
ACTION=""; TARGET="${1:-}"
case "$TARGET" in
  "")            ACTION="menu" ;;
  list)          ACTION="list" ;;
  cali|calibrate) ACTION="cali" ;;
  *)             ACTION="run" ;;
esac

run_collect() {
  local key="$1"; shift
  echo
  hr
  echo "${CYA}▶ 开始采集：${key}${RST}"
  hr
  echo "${DIM}浏览器窗口会自己弹出来。第一次用某个平台时，请在弹出的窗口里扫码登录，"
  echo "登好之后程序会自动开始逐条提问。中途出现验证码会自动暂停等你处理。${RST}"
  echo
  "$PY" collector.py --platform "$key" "$@"
  local rc=$?
  echo
  if [ $rc -eq 0 ]; then
    echo "${GRN}✓ 采集流程结束。${RST}结果已写入：${BOLD}${DIR}/out/${RST}"
  else
    echo "${YEL}! 采集退出码 ${rc}${RST}（中途 Ctrl+C，或某个平台登录超时都可能是这个结果）"
    echo "已抓到的部分同样会保存到 out/ 目录，按进度续采即可。"
  fi
  return $rc
}

case "$ACTION" in
  list)
    "$PY" collector.py --list
    pause_exit 0
    ;;

  cali)
    KEY="${2:-}"
    if [ -z "$KEY" ]; then
      echo "校准哪个平台？填 key，例如：kimi"
      printf "> "; read -r KEY
    fi
    echo
    echo "${DIM}校准模式：会打开 ${KEY} 并等你手动问一句，"
    echo "然后把页面上能抓到的文本块全部列出来，用来修 config.json 里的选择器。${RST}"
    "$PY" calibrate.py --platform "$KEY"
    pause_exit 0
    ;;

  run)
    if [ "$TARGET" = "all" ]; then
      rc=0
      for k in "${MENU_KEYS[@]}"; do
        run_collect "$k" "${@:2}" || rc=$?
        echo
        echo "${DIM}—— 换下一个平台，稍等几秒 ——${RST}"
        sleep 5
      done
    else
      run_collect "$TARGET" "${@:2}"; rc=$?
    fi
    echo
    printf "现在就打开结果文件夹看看吗？(y/N) "; read -r yn
    case "$yn" in y|Y) open "$DIR/out" ;; esac
    pause_exit $rc
    ;;

  menu)
    while true; do
      hr
      echo " 选一个平台开始采集："
      echo
      i=1
      for k in "${MENU_KEYS[@]}"; do
        printf "   ${BOLD}%d${RST}) %s  ${DIM}（%s）${RST}\n" "$i" "${MENU_NAMES[$((i-1))]}" "$k"
        i=$((i+1))
      done
      echo "   ${BOLD}a${RST}) 依次采集全部平台"
      echo "   ${BOLD}t${RST}) 试跑模式（每个平台只采 1 条，先看抓得对不对）"
      hr
      echo "   ${BOLD}l${RST}) 只看平台与问题清单（不开浏览器）"
      echo "   ${BOLD}c${RST}) 校准选择器（页面上抓不到内容时用）"
      echo "   ${BOLD}o${RST}) 打开已采集结果文件夹"
      echo "   ${BOLD}q${RST}) 退出"
      hr
      printf " 请输入编号或字母，回车确认： "
      read -r choice

      case "$choice" in
        q|Q|"") echo "已退出。"; pause_exit 0 ;;
        l|L) "$PY" collector.py --list; echo; read -n 1 -s -r -p "按任意键回到菜单…"; clear 2>/dev/null || true ;;
        o|O) open "$DIR/out"; echo "${GRN}已打开 out 文件夹${RST}"; sleep 1 ;;
        c|C)
          echo
          printf "要校准哪个平台？填 key（例如 kimi）： "; read -r ck
          [ -n "$ck" ] && "$PY" calibrate.py --platform "$ck"
          echo; read -n 1 -s -r -p "按任意键回到菜单…"; clear 2>/dev/null || true
          ;;
        a|A)
          rc=0
          for k in "${MENU_KEYS[@]}"; do
            run_collect "$k" || rc=$?
            echo; echo "${DIM}—— 换下一个平台，稍等几秒 ——${RST}"; sleep 5
          done
          echo; printf "打开结果文件夹？(y/N) "; read -r yn
          case "$yn" in y|Y) open "$DIR/out" ;; esac
          pause_exit $rc
          ;;
        t|T)
          echo
          printf "试跑哪个平台？填编号或 key： "; read -r tk
          case "$tk" in
            ''|*[!0-9]*) key="$tk" ;;
            *) if [ "$tk" -ge 1 ] && [ "$tk" -le "${#MENU_KEYS[@]}" ]; then key="${MENU_KEYS[$((tk-1))]}"; else key=""; fi ;;
          esac
          if [ -z "$key" ]; then echo "${RED}没认出这个编号/平台。${RST}"; sleep 2; clear 2>/dev/null || true; continue; fi
          run_collect "$key" --limit 1 --dry-run
          echo; printf "打开结果文件夹？(y/N) "; read -r yn
          case "$yn" in y|Y) open "$DIR/out" ;; esac
          pause_exit 0
          ;;
        *)
          key=""
          if [ "$choice" -ge 1 ] 2>/dev/null && [ "$choice" -le "${#MENU_KEYS[@]}" ] 2>/dev/null; then
            key="${MENU_KEYS[$((choice-1))]}"
          fi
          if [ -z "$key" ]; then
            echo "${RED}没认出这个选项，重新选一次。${RST}"; sleep 2; clear 2>/dev/null || true; continue
          fi
          run_collect "$key"
          echo; printf "打开结果文件夹？(y/N) "; read -r yn
          case "$yn" in y|Y) open "$DIR/out" ;; esac
          pause_exit 0
          ;;
      esac
    done
    ;;
esac
