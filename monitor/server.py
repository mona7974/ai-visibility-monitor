#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 可见度监测台 · 本地服务

干什么：
    1) 托管监测台页面（monitor/ 目录，纯静态）；
    2) 提供两个只读接口，让页面自动读取采集器的结果：
         /api/collector-files        列出 collector/out/ 里可同步的 JSON
         /api/collector-data?file=x  返回某个文件的内容
    3) 提供采集任务接口，让页面上的「开始自动测试」按钮真的能跑起来：
         POST /api/run-collector     启动一次采集（平台/轮次/范围/是否重采）
         GET  /api/run-status        查询进度与实时日志
         POST /api/run-stop          停止当前采集
    这样采集器每次跑完，刷新页面看板就是最新的，不用手动「导入备份」。

安全：
    · 只监听 127.0.0.1，外部访问不到；
    · 只读接口只读 collector/out/ 下的 .json，文件名经严格校验，防目录穿越；
    · 采集接口只允许固定白名单参数（平台 key 取自 config.json），不接受任意命令；
    · 同一时刻只允许一个采集任务，防止重复开浏览器。

用法：
    python3 server.py            # 默认端口 8765（可用环境变量 PORT 覆盖）
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent                 # monitor/
COLLECTOR_DIR = ROOT.parent / "collector"
COLLECTOR_OUT = COLLECTOR_DIR / "out"                  # 采集结果目录
COLLECTOR_PY = COLLECTOR_DIR / "collector.py"
COLLECTOR_CFG = COLLECTOR_DIR / "config.json"
PORT = int(os.environ.get("PORT", "8765"))
LOG_KEEP = 400          # 内存里保留的日志行数


def preferred_files() -> list[str]:
    """列出可同步的采集结果：排除备份与测试桩。

    同一份结果可能同时存在「原始」与「_已判定」两个文件，取较新的那个——
    否则重采后旧的已判定文件会把新数据顶掉。
    """
    if not COLLECTOR_OUT.exists():
        return []
    groups: dict[str, Path] = {}
    for f in sorted(COLLECTOR_OUT.glob("*.json")):
        name = f.name
        if "备份" in name or "试跑" in name or "stub" in name.lower():
            continue
        base = name.replace("_已判定", "")
        prev = groups.get(base)
        if prev is None or f.stat().st_mtime > prev.stat().st_mtime:
            groups[base] = f
    ordered = sorted(groups.items(), key=lambda kv: kv[1].stat().st_mtime)
    return [p.name for _, p in ordered]


def platform_options() -> list[dict]:
    """采集器支持的平台（key + 中文名），排除本地测试桩。"""
    try:
        cfg = json.loads(COLLECTOR_CFG.read_text(encoding="utf-8"))
        out = []
        for k, v in (cfg.get("platforms") or {}).items():
            if k == "stub":
                continue
            out.append({"key": k, "name": (v or {}).get("name") or k})
        return out
    except Exception:
        return []


def platform_keys() -> list[str]:
    """平台 key 白名单（防注入任意命令参数）。"""
    return [p["key"] for p in platform_options()]


# ============================================================
#  采集任务
# ============================================================

JOB_LOCK = threading.Lock()
JOB: dict = {
    "running": False,
    "platform": "",
    "round": "",
    "startedAt": 0.0,
    "finishedAt": 0.0,
    "returncode": None,
    "lines": deque(maxlen=LOG_KEEP),
    "index": 0,        # 当前第几条
    "total": 0,        # 共几条
    "question": "",
    "done": 0,         # 已抓取成功条数
    "logPath": "",
    "error": "",
    "proc": None,
    "thread": None,
}


def _parse_line(line: str) -> None:
    """从采集器输出里解析进度，供页面显示进度条。"""
    s = line.strip()
    if s.startswith("[") and "]" in s:
        head = s[1:s.index("]")]
        if "/" in head:
            a, _, b = head.partition("/")
            try:
                JOB["index"] = int(a.strip())
                JOB["total"] = int(b.strip())
            except ValueError:
                pass
        if "提问：" in s:
            JOB["question"] = s.split("提问：", 1)[1].strip()
    elif "✓ 已抓取" in s:
        JOB["done"] += 1
    elif s.startswith("[跳过]") or s.startswith("[失败]"):
        JOB["error"] = s
    elif "全部完成" in s:
        JOB["question"] = ""


def _pump(proc: subprocess.Popen, log_path: Path) -> None:
    """实时收集采集器输出，写日志文件并更新进度。"""
    try:
        fh = log_path.open("w", encoding="utf-8")
    except Exception:
        fh = None
    try:
        for raw in proc.stdout:                      # type: ignore[union-attr]
            line = raw.rstrip("\n")
            JOB["lines"].append(line)
            _parse_line(line)
            if fh:
                fh.write(line + "\n")
                fh.flush()
    finally:
        if fh:
            fh.close()
        proc.wait()
        with JOB_LOCK:
            JOB["running"] = False
            JOB["returncode"] = proc.returncode
            JOB["finishedAt"] = time.time()
            JOB["proc"] = None


def start_job(platform: str, round_label: str, reset: bool, limit: int,
              dry_run: bool = False):
    keys = platform_keys()
    if platform != "all" and platform not in keys:
        return None, f"未知平台：{platform}"
    if platform == "all" and not keys:
        return None, "读不到采集器平台配置（config.json）"
    if reset and limit and not dry_run:
        return None, "重采 + 限条数会把正式结果截断，已阻止。试跑请用「只采 1 条（试跑）」。"
    with JOB_LOCK:
        if JOB["running"]:
            return None, "已有采集任务正在运行，等它结束或先点停止"
        if not COLLECTOR_PY.exists():
            return None, f"找不到采集器：{COLLECTOR_PY}"
        args = [sys.executable, str(COLLECTOR_PY), "--platform", platform]
        if round_label:
            args += ["--round", round_label]
        if reset:
            args.append("--reset")
        if limit:
            args += ["--limit", str(limit)]
        if dry_run:
            args.append("--dry-run")
        try:
            COLLECTOR_OUT.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        log_path = COLLECTOR_OUT / ("运行日志_%s_%s.log" % (
            platform, time.strftime("%Y%m%d_%H%M%S")))
        JOB.update({
            "running": True, "platform": platform, "round": round_label,
            "startedAt": time.time(), "finishedAt": 0.0, "returncode": None,
            "index": 0, "total": 0, "question": "", "done": 0,
            "error": "", "logPath": str(log_path),
        })
        JOB["lines"].clear()
        try:
            proc = subprocess.Popen(
                args, cwd=str(COLLECTOR_DIR),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
            )
        except Exception as e:
            JOB["running"] = False
            return None, f"启动失败：{e}"
        JOB["proc"] = proc
        t = threading.Thread(target=_pump, args=(proc, log_path), daemon=True)
        JOB["thread"] = t
        t.start()
        return snapshot(), None


def stop_job():
    with JOB_LOCK:
        if not JOB["running"] or JOB["proc"] is None:
            return False, "当前没有在跑的采集任务"
        proc = JOB["proc"]
    try:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
        return True, "已停止"
    except Exception as e:
        return False, f"停止失败：{e}"


def snapshot() -> dict:
    """给页面的任务快照（不含进程对象）。"""
    now = time.time()
    started = JOB["startedAt"] or now
    elapsed = (JOB["finishedAt"] or now) - started if started else 0
    return {
        "running": bool(JOB["running"]),
        "platform": JOB["platform"],
        "round": JOB["round"],
        "index": JOB["index"],
        "total": JOB["total"],
        "question": JOB["question"],
        "done": JOB["done"],
        "error": JOB["error"],
        "returncode": JOB["returncode"],
        "elapsed": round(elapsed, 1),
        "logPath": JOB["logPath"],
        "lines": list(JOB["lines"])[-24:],
    }


class Handler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):  # 安静一点，别刷屏
        sys.stderr.write("· %s\n" % (fmt % args))

    def end_headers(self):
        # 页面与脚本都禁缓存：改版后刷新一定是最新代码，不会出现"改了没生效"
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception:
            return {}

    def do_GET(self):
        parts = urlparse(self.path)
        if parts.path == "/api/collector-files":
            files = preferred_files()
            self._json({"files": files, "count": len(files)})
            return
        if parts.path == "/api/collector-data":
            qs = parse_qs(parts.query)
            name = unquote(qs.get("file", [""])[0])
            path = (COLLECTOR_OUT / name).resolve()
            # 只允许 out/ 下的 .json 文件，防目录穿越
            if (not name.endswith(".json")
                    or ".." in name or "/" in name or "\\" in name
                    or path.parent != COLLECTOR_OUT.resolve()
                    or not path.exists()):
                self._json({"error": "文件不存在或不可访问"}, status=404)
                return
            try:
                self._json(json.loads(path.read_text(encoding="utf-8")))
            except Exception as e:
                self._json({"error": f"文件解析失败：{e}"}, status=500)
            return
        if parts.path == "/api/run-status":
            self._json(snapshot())
            return
        if parts.path == "/api/ping":
            self._json({
                "ok": True,
                "app": "AI 可见度监测台本地服务",
                "platforms": platform_options(),
            })
            return
        super().do_GET()

    def do_POST(self):
        parts = urlparse(self.path)
        if parts.path == "/api/run-collector":
            body = self._read_json_body()
            platform = str(body.get("platform") or "").strip()
            round_label = str(body.get("round") or "").strip()
            reset = bool(body.get("reset"))
            try:
                limit = int(body.get("limit") or 0)
            except (TypeError, ValueError):
                limit = 0
            limit = max(0, min(limit, 999))
            dry_run = bool(body.get("dryRun"))
            snap, err = start_job(platform, round_label, reset, limit, dry_run)
            if err:
                self._json({"error": err, "status": snapshot()}, status=409)
            else:
                self._json({"ok": True, "status": snap})
            return
        if parts.path == "/api/run-stop":
            ok, msg = stop_job()
            self._json({"ok": ok, "message": msg, "status": snapshot()},
                       status=200 if ok else 409)
            return
        self._json({"error": "未知接口"}, status=404)


def _shutdown(*_a):
    """窗口被关掉 / Ctrl+C 时，连带把还在跑的采集任务收掉，别留孤儿浏览器。"""
    try:
        stop_job()
    except Exception:
        pass
    print("\n已停止。")
    os._exit(0)


def main():
    keys = platform_keys()
    addr = ("127.0.0.1", PORT)
    httpd = ThreadingHTTPServer(addr, Handler)
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _shutdown)
        except Exception:
            pass
    print()
    print("=" * 60)
    print("  AI 可见度监测台 · 本地服务已启动")
    print(f"  地址：http://127.0.0.1:{PORT}/")
    print(f"  页面目录：{ROOT}")
    print(f"  采集结果：{COLLECTOR_OUT}")
    print(f"  可用平台：{'、'.join(keys) if keys else '（读不到 config.json）'}")
    print("  （只监听本机 127.0.0.1，外部访问不到；关掉这个窗口即停止）")
    print("=" * 60)
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _shutdown()
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
