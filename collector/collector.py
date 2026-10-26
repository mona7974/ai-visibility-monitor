#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 可见度监测台 · 网页回答采集器（有头模式）

干什么：
    打开浏览器 → 你手动扫码登录 → 程序按问题清单逐条提问 → 等答案生成完 → 抓取回答原文与其中的链接
    → 存成一份 JSON → 到监测台「记录」页点「导入备份」→ 再点「一键判定未判定记录」→ 看板出数。

安全与分寸（请先读完）：
    1) 这是一次自动化访问，平台可能触发人机验证甚至限制账号，风险由你自行判断与承担，建议只用于个人研究。
    2) 程序不接触你的账号密码：登录完全由你在弹出的浏览器窗口里自己完成，程序只负责之后读取答案。
    3) 单条串行 + 每条随机间隔（默认 12~22 秒），模拟人的节奏；检测到验证码/风控会立刻暂停让你手动处理。
    4) 浏览器会话（cookies）保存在本目录 .profiles/ 下，只在你本机；不想留就删掉这个目录。
    5) 采集结果是"原始回答"，判定逻辑仍在监测台里统一执行，避免两边口径不一致。

用法：
    python collector.py --platform deepseek            # 采某个平台
    python collector.py --platform all                 # 依次采全部平台
    python collector.py --platform deepseek --limit 5  # 先试 5 条
    python collector.py --platform kimi --round 第2轮  # 采第二轮
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "config.json"
QUESTIONS_PATH = BASE / "questions.json"
OUT_DIR = BASE / "out"
PROFILE_DIR = BASE / ".profiles"

RISK_MARKERS = [
    "人机验证", "安全验证", "验证码", "拖动滑块", "环境异常", "操作过于频繁",
    "请求过于频繁", "请稍后再试", "当前人数过多", "访问受限", "账号异常",
    "Verify you are human", "unusual traffic", "captcha", "Too many requests",
]

JS_RISK = "(markers) => markers.find(m => (document.body.innerText || '').includes(m)) || ''"
JS_TEXT_LEN = "() => (document.body.innerText || '').length"

# 域名 → 站点名（用于把引用链接变成可读的「引用来源」）
SITE_LABELS = {
    "zhihu.com": "知乎", "zhuanlan.zhihu.com": "知乎专栏",
    "baike.baidu.com": "百度百科", "baidu.com": "百度",
    "36kr.com": "36氪", "idcquan.com": "中国IDC圈", "idcquan.cn": "中国IDC圈",
    "eastmoney.com": "东方财富", "10jqka.com.cn": "同花顺", "xueqiu.com": "雪球",
    "sina.com.cn": "新浪", "sina.cn": "新浪", "sohu.com": "搜狐", "163.com": "网易",
    "qq.com": "腾讯网", "mp.weixin.qq.com": "微信公众号", "weixin.qq.com": "微信公众号",
    "thepaper.cn": "澎湃新闻", "jiemian.com": "界面新闻", "yicai.com": "第一财经",
    "cnstock.com": "上海证券报", "cs.com.cn": "中国证券报", "stcn.com": "证券时报",
    "cls.cn": "财联社", "caixin.com": "财新", "21jingji.com": "21世纪经济报道",
    "gov.cn": "政府网站", "miit.gov.cn": "工信部", "ndrc.gov.cn": "发改委",
    "caict.ac.cn": "中国信通院", "iresearch.com.cn": "艾瑞咨询",
    "leadleo.com": "头豹研究院", "askci.com": "中商情报网", "qianzhan.com": "前瞻产业研究院",
    "analysys.cn": "易观分析", "questmobile.com.cn": "QuestMobile",
    "donews.com": "DoNews", "c114.com.cn": "C114通信网", "cnw.com.cn": "网络世界",
    "tmtpost.com": "钛媒体", "huxiu.com": "虎嗅", "leiphone.com": "雷锋网",
    "chinadaily.com.cn": "中国日报", "xinhuanet.com": "新华网", "people.com.cn": "人民网",
    "cnblogs.com": "博客园", "csdn.net": "CSDN", "juejin.cn": "掘金",
}


def label_for_url(url: str) -> str:
    """把引用链接转成可读的站点名；认不出就用裸域名。"""
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return ""
    if not host:
        return ""
    host = host.split("@")[-1].split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    # 精确 → 后缀 两级匹配
    if host in SITE_LABELS:
        return SITE_LABELS[host]
    for dom, label in SITE_LABELS.items():
        if host == dom or host.endswith("." + dom):
            return label
    return host


def build_sources(links, limit: int = 8) -> str:
    """把引用链接整理成 '站点A; 站点B' 形式的「引用来源」，并去重。"""
    out, seen = [], set()
    for u in links or []:
        lab = label_for_url(u)
        if not lab or lab in seen:
            continue
        seen.add(lab)
        out.append(lab)
        if len(out) >= limit:
            break
    return "; ".join(out)


JS_EXTRACT = """
(args) => {
  const [selectors, maxLen] = args;
  const vis = el => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 20 && r.height > 10 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const seen = [];
  for (const s of selectors) {
    let cand = null;
    for (const n of Array.from(document.querySelectorAll(s))) {
      if (!vis(n)) continue;
      const t = (n.innerText || '').trim();
      seen.push({ sel: s, len: t.length });
      if (t.length >= 60 && t.length <= maxLen) cand = n;
    }
    if (cand) {
      const links = Array.from(cand.querySelectorAll('a[href]'))
        .map(a => a.href).filter(u => /^https?:/i.test(u));
      return { ok: true, sel: s, text: cand.innerText.trim(), links: links, seen: seen };
    }
  }
  return { ok: false, sel: '', text: '', links: [], seen: seen };
}
"""

JS_FALLBACK = """
(question) => {
  const t = document.body.innerText || '';
  const i = t.lastIndexOf(question);
  return i < 0 ? '' : t.slice(i + question.length).trim();
}
"""


JS_DISMISS = """
() => {
  // 关掉挡路的引导/公告弹窗（文心一言的"任务模式引导"、元宝的新功能弹窗等）
  // 保守策略 1：只匹配「独立成词」的 dialog/modal/popup——
  //   绝不能匹配 agent-dialogue（对话）这类正常类名（元宝因此被误伤过）。
  // 保守策略 2：容器里含输入框或聊天正文（markdown/message/chat/answer）的一律不动。
  const DIALOG_HINT = /(^|[^a-zA-Z])(dialog|modal|popup)([^a-zA-Z]|$)/i;
  const CLOSE_TEXT = /^(×|✕|✖|x|X|关闭|我知道了|知道了|跳过|稍后再说|暂不|不用了|下次再说)$/;
  const HOLD_INPUT = 'textarea, input, [contenteditable="true"], [role="textbox"]';
  const CONTENT_GUARD = "[class*='markdown'], [class*='message'], [class*='chat'], [class*='answer'], [class*='dialogue'], [class*='conversation']";
  const out = { closed: [], hidden: 0 };

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05;
  }

  // 1) 找弹窗类容器（严格词匹配 + 双重内容守卫）
  const boxes = [];
  document.querySelectorAll('div,section,aside').forEach(el => {
    const cls = (el.className && typeof el.className === 'string') ? el.className : '';
    const role = el.getAttribute('role') || '';
    if (!DIALOG_HINT.test(cls) && role !== 'dialog' && role !== 'alertdialog') return;
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 80) return;
    if (el.querySelector(HOLD_INPUT)) return;      // 含输入框 → 可能是主界面，不动
    if (el.querySelector(CONTENT_GUARD)) return;   // 含聊天正文 → 主界面，绝不动
    boxes.push(el);
  });

  // 2) 优先点里面的关闭按钮
  boxes.forEach(box => {
    let clicked = false;
    const cands = box.querySelectorAll('button,[role="button"],svg,[aria-label],[class*="close"],[class*="Close"]');
    for (const c of cands) {
      const label = (c.getAttribute && (c.getAttribute('aria-label') || '')) || '';
      const txt = (c.textContent || '').trim();
      const cls = (c.className && typeof c.className === 'string') ? c.className : '';
      const looksClose = /关闭|关闭弹窗|close/i.test(label + ' ' + cls) || CLOSE_TEXT.test(txt);
      if (!looksClose || !visible(c)) continue;
      try {
        (c.closest('button,[role="button"]') || c).click();
        clicked = true;
        out.closed.push((txt || label || 'close').slice(0, 12));
        break;
      } catch (e) { /* 点不动就继续找 */ }
    }
    if (!clicked) {
      // 3) 没有关闭按钮 → 直接把弹窗容器藏掉
      try {
        box.style.display = 'none';
        box.setAttribute('data-geo-dismissed', '1');
        out.hidden += 1;
      } catch (e) { /* 忽略 */ }
    }
  });

  // 4) 兜底：全屏遮罩只「解除点击拦截」，绝不 display:none（保渲染安全）
  document.querySelectorAll('div[class*="mask"],div[class*="overlay"],div[class*="backdrop"]').forEach(el => {
    const cls = (el.className && typeof el.className === 'string') ? el.className : '';
    if (!/(^|[^a-zA-Z])(mask|overlay|backdrop)([^a-zA-Z]|$)/i.test(cls)) return;
    if (!visible(el) || el.querySelector(HOLD_INPUT) || el.querySelector(CONTENT_GUARD)) return;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < innerWidth * innerHeight * 0.5) return;  // 只要真正全屏的
    const s = getComputedStyle(el);
    if (s.pointerEvents === 'none') return;
    try {
      el.style.pointerEvents = 'none';
      el.style.visibility = 'hidden';
      out.hidden += 1;
    } catch (e) {}
  });

  return out;
}
"""


# 兜底抽取的垃圾特征：抓到这些字样说明抓的是登录页/页面框架，不是回答
GARBAGE_RE = re.compile(
    r"扫码登录|微信登录|请使用微信扫描|用户服务协议|隐私协议|短信登录|验证码登录"
)

# 「深度思考 / 推理过程」特征：元宝会先流式输出思考，再输出正式回答。
# 此时抽到的内容虽然相关，但不是最终回答，品牌提及判定会失真。
THINKING_RE = re.compile(
    r"用户问的是|我需要考虑|是否需要联网搜索|用户位置是|问题比较宽泛|"
    r"让我(思考|组织|先)|我应该(先|给出)|我已有足够数据|内容要点：|"
    r"用户在[^，。]{0,8}(台北|台湾|中国台湾)"
)


def looks_like_thinking(text: str) -> bool:
    return bool(text) and bool(THINKING_RE.search(text))


def log(msg: str = "") -> None:
    print(msg, flush=True)


def load_json(path: Path, what: str):
    if not path.exists():
        log(f"[错误] 找不到{what}：{path}")
        sys.exit(1)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        log(f"[错误] {what} 不是合法的 JSON（第 {exc.lineno} 行）：{exc.msg}")
        sys.exit(1)


def find_input(page, selectors):
    """从候选里找当前可见的输入框"""
    allsel = list(selectors) + ["textarea", "div[contenteditable='true']", "[role='textbox']"]
    for sel in allsel:
        try:
            loc = page.locator(sel)
            n = loc.count()
        except Exception:
            continue
        for i in range(n - 1, -1, -1):
            try:
                node = loc.nth(i)
                if node.is_visible():
                    return node
            except Exception:
                continue
    return None


def dismiss_popups(page, quiet: bool = False) -> bool:
    """关掉挡路的引导弹窗：先按 Esc，再点关闭按钮，最后隐藏弹窗容器。
    返回是否清掉了东西（用于决定要不要重试点击）。"""
    acted = False
    # 1) Esc 通常能关掉大部分引导层
    try:
        page.keyboard.press("Escape")
        page.wait_for_timeout(180)
    except Exception:
        pass
    # 2) 结构化清理（点关闭按钮 / 隐藏弹窗）
    for _ in range(2):
        try:
            res = page.evaluate(JS_DISMISS) or {}
        except Exception:
            break
        closed = res.get("closed") or []
        hidden = int(res.get("hidden") or 0)
        if closed or hidden:
            acted = True
            if not quiet:
                bits = []
                if closed:
                    bits.append("点掉「" + "、".join(closed[:3]) + "」")
                if hidden:
                    bits.append(f"隐藏 {hidden} 层遮挡")
                log("  · 清掉弹窗：" + "，".join(bits))
        else:
            break
        page.wait_for_timeout(220)
    return acted


def find_input_wait(page, cfg, timeout: float = 18.0):
    """等输入框出现，期间反复清弹窗（元宝/文心常被弹窗顶掉输入框）"""
    selectors = cfg.get("inputSelectors", [])
    deadline = time.time() + timeout
    dismissed = False
    while True:
        inp = find_input(page, selectors)
        if inp is not None:
            return inp, dismissed
        if time.time() >= deadline:
            return None, dismissed
        if dismiss_popups(page, quiet=dismissed):
            dismissed = True
        page.wait_for_timeout(900)


def wait_for_ready(page, cfg, timeout=300):
    """等页面可用：输入框出现即认为登录完成"""
    selectors = cfg.get("inputSelectors", [])
    name = cfg.get("name", "该平台")
    t0 = time.time()
    tick = 0
    while time.time() - t0 < timeout:
        if find_input(page, selectors) is not None:
            return True
        tick += 1
        # 登录页/首页常有引导弹窗，边等边关掉，否则会一直找不到输入框
        dismiss_popups(page, quiet=True)
        if tick % 4 == 1:
            left = int(timeout - (time.time() - t0))
            log(f"  · 等待登录/页面加载中… 请在浏览器窗口里完成登录 {name}（剩余等待 {left}s）")
        time.sleep(3)
    return False


def start_new_chat(page, cfg):
    for txt in cfg.get("newChatTexts", []):
        try:
            loc = page.get_by_text(txt, exact=False)
            n = min(loc.count(), 4)
        except Exception:
            continue
        for i in range(n):
            try:
                node = loc.nth(i)
                if node.is_visible():
                    node.click(timeout=2500)
                    page.wait_for_timeout(1500)
                    log(f"  · 已点击「{txt}」新建对话")
                    return True
            except Exception:
                continue
    return False


def risk_marker(page) -> str:
    try:
        return page.evaluate(JS_RISK, RISK_MARKERS) or ""
    except Exception:
        return ""


def wait_for_answer(page, cfg, base_len):
    max_wait = cfg.get("maxWaitSeconds", 150)
    stable_need = cfg.get("stableSeconds", 3)
    t0 = time.time()
    last = -1
    stable = 0
    grew = False
    while time.time() - t0 < max_wait:
        page.wait_for_timeout(1000)
        marker = risk_marker(page)
        if marker:
            return "risk", marker
        try:
            cur = page.evaluate(JS_TEXT_LEN)
        except Exception:
            cur = last
        if cur > base_len + 30:
            grew = True
        if grew and cur == last:
            stable += 1
            if stable >= stable_need:
                return "ok", ""
        else:
            stable = 0
        last = cur
    return "timeout", ""


def handle_risk(page, marker: str) -> bool:
    log("")
    log("!" * 60)
    log(f"!!! 检测到验证码 / 风控提示：{marker}")
    log("!!! 请立刻切到浏览器窗口手动处理（完成验证或刷新页面）。")
    log("!!! 处理完成后这里会自动继续；300 秒内未恢复则停止采集，已采到的数据不受影响。")
    log("!" * 60)
    for _ in range(100):
        page.wait_for_timeout(3000)
        if not risk_marker(page):
            log("  已恢复，继续采集。")
            return True
    return False


def extract_answer(page, cfg, question, max_len=12000):
    try:
        res = page.evaluate(JS_EXTRACT, [cfg.get("answerSelectors", []), max_len])
    except Exception:
        res = {"ok": False, "text": "", "links": [], "sel": ""}
    if res.get("ok") and res.get("text"):
        return res["text"], res.get("links") or [], res.get("sel", ""), False
    # 兜底：从页面全文里截取「问题之后」的部分
    try:
        fb = page.evaluate(JS_FALLBACK, question) or ""
    except Exception:
        fb = ""
    if fb:
        return fb[:max_len], [], "(兜底:页面全文)", True
    return "", [], "", True


def out_file(platform_key: str, cfg, round_label: str, dry_run: bool = False) -> Path:
    if not OUT_DIR.exists():
        OUT_DIR.mkdir(parents=True, exist_ok=True)
    day = datetime.now().strftime("%Y%m%d")
    safe = platform_key.replace("/", "_")
    tag = "_试跑" if dry_run else ""
    return OUT_DIR / f"答案_{safe}_{round_label}{tag}_{day}.json"


def load_done(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    done = {}
    for r in data.get("records", []):
        done[r.get("keyword", "")] = r
    return done


def save_records(path: Path, records, brand: str, round_label: str) -> None:
    payload = {
        "schema": 1,
        "app": "AI 可见度监测台（网页采集器）",
        "exportedAt": datetime.now().isoformat(timespec="seconds"),
        "brand": brand,
        "round": round_label,
        "records": records,
    }
    # 先写临时文件再原子替换：监测台可能在采集过程中同步读取，
    # 直接覆盖会读到"写了一半"的 JSON 而报解析错误。
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        tmp.replace(path)
    except OSError:
        path.write_text(tmp.read_text(encoding="utf-8"), encoding="utf-8")
        try:
            tmp.unlink()
        except OSError:
            pass


def collect_one(playwright, platform_key: str, cfg_all: dict, questions, args):
    cfg = cfg_all["platforms"][platform_key]
    name = cfg.get("name", platform_key)
    round_label = args.round or cfg_all.get("round", "第1轮")
    path = out_file(platform_key, cfg, round_label, dry_run=args.dry_run)
    done = {} if args.reset else load_done(path)
    records = list(done.values())

    todo = [q for q in questions if q not in done]
    if args.limit:
        todo = todo[: args.limit]

    log("")
    log("=" * 60)
    log(f"平台：{name}    轮次：{round_label}")
    log(f"输出：{path}")
    if done:
        log(f"续采：已完成 {len(done)} 条，本次待采 {len(todo)} 条")
    log("=" * 60)

    profile = PROFILE_DIR / platform_key
    if not profile.exists():
        profile.mkdir(parents=True, exist_ok=True)
    ctx = playwright.chromium.launch_persistent_context(
        user_data_dir=str(profile),
        headless=False,
        locale="zh-CN",
        timezone_id="Asia/Shanghai",          # 避免平台按错误时区/位置判定用户所在地
        geolocation={"longitude": 121.4737, "latitude": 31.2304},   # 上海
        permissions=["geolocation"],
        viewport={"width": 1440, "height": 900},
        args=["--disable-blink-features=AutomationControlled", "--lang=zh-CN"],
    )
    ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    ok_count = 0
    try:
        page.goto(cfg["url"], wait_until="domcontentloaded", timeout=60000)
        log(f"已打开 {cfg['url']}")
        if find_input(page, cfg.get("inputSelectors", [])) is None:
            log(f"没有检测到输入框 → 需要登录 {name}")
            log("👉 请在弹出的浏览器窗口里完成登录（扫码 / 手机号 / 已有会话都行）")
        if not wait_for_ready(page, cfg, timeout=args.login_timeout):
            log(f"[跳过] {name}：{args.login_timeout}s 内没等到输入框，未登录或页面结构变化。")
            return ok_count, len(todo)

        for idx, q in enumerate(todo, 1):
            log("")
            log(f"[{idx}/{len(todo)}] 提问：{q}")
            dismiss_popups(page)
            start_new_chat(page, cfg)
            inp, _ = find_input_wait(page, cfg, timeout=20)
            if inp is None:
                log("  [跳过] 等 20 秒仍找不到输入框（页面结构变了，或需你手动处理一下页面）。")
                continue
            try:
                base_len = page.evaluate(JS_TEXT_LEN)
            except Exception:
                base_len = 0

            sent = False
            for attempt in (1, 2):
                try:
                    inp.click(timeout=5000)
                    try:
                        inp.fill("")
                    except Exception:
                        pass
                    lo, hi = cfg_all.get("typingDelayMs", [25, 70])
                    inp.type(q, delay=random.randint(lo, hi))
                    page.wait_for_timeout(random.randint(200, 500))
                    page.keyboard.press("Enter")
                    sent = True
                    break
                except Exception as exc:
                    if attempt == 1:
                        # 绝大多数是弹窗/遮罩盖住了输入框：清一遍再试
                        log("  · 点不动输入框（多半被弹窗挡住）→ 清弹窗后重试")
                        dismiss_popups(page, quiet=True)
                        inp2, _ = find_input_wait(page, cfg, timeout=10)
                        if inp2 is not None:
                            inp = inp2
                            continue
                    log(f"  [失败] 输入/发送出错：{str(exc).splitlines()[0]}")
            if not sent:
                continue

            status, marker = wait_for_answer(page, cfg_all, base_len)
            if status == "risk":
                if not handle_risk(page, marker):
                    log("[停止] 风控未恢复，已保存当前进度。")
                    break
                status, _ = wait_for_answer(page, cfg_all, page.evaluate(JS_TEXT_LEN))
            if status == "timeout":
                log("  [注意] 等答案超时，仍尝试提取当前页面内容")

            text, links, sel, fallback = extract_answer(page, cfg, q)

            # 元宝等平台会先流式输出「思考过程」，此刻抽到的是推理而非最终回答。
            # 这里等一会儿再抽，直到拿到正式回答为止。
            if looks_like_thinking(text):
                log("  · 抽到的是「思考过程」，等最终回答…")
                for _ in range(16):          # 最多再等 40 秒
                    page.wait_for_timeout(2500)
                    t2, l2, s2, f2 = extract_answer(page, cfg, q)
                    if t2 and not looks_like_thinking(t2):
                        text, links, sel, fallback = t2, l2, s2, f2
                        log("  · 已拿到最终回答")
                        break
                else:
                    log("  [跳过] 一直是思考过程，没等到最终回答；这条不写入，重跑会再采。")
                    continue

            if text and fallback:
                # 兜底抓的是全文，最容易混入登录页/侧栏等框架文字——先验一验
                if GARBAGE_RE.search(text):
                    log("  [失败] 兜底抓到的是登录页/页面框架文字，已丢弃（不写入数据）")
                    continue
                if len(text) < 120:
                    log(f"  [失败] 兜底内容只有 {len(text)} 字，多半不是回答，已丢弃")
                    continue
            if not text:
                log("  [失败] 没抓到回答文本，跳过这条（可运行 calibrate.py 校准页面结构）")
                continue

            note = "采集器自动获取"
            if fallback:
                note += "；用兜底方式抽取（可能含页面其他文字，请核对）"
            src_text = build_sources(links)
            if src_text:
                note += f"；引用链接 {len(links)} 个（已去重整理）"

            rec = {
                "keyword": q,
                "platform": name,
                "round": round_label,
                "testedAt": datetime.now().strftime("%Y-%m-%d"),
                "mentioned": "",
                "firstRank": "",
                "competitors": "",
                "sources": src_text,
                "sentiment": "",
                "hasError": "",
                "rawAnswer": text,
                "note": note,
                "links": links,
            }
            records.append(rec)
            save_records(path, records, cfg_all.get("targetBrand", ""), round_label)
            ok_count += 1
            log(f"  ✓ 已抓取 {len(text)} 字" + (f"，命中选择器 {sel}" if sel else "，用兜底抽取")
                + (f"，引用来源 {len(links)} 个 → {src_text}" if src_text else "，无引用链接"))

            if idx < len(todo):
                # 平台可单独覆盖间隔（百度系风控紧，配更长间隔）
                lo, hi = cfg.get("delaySeconds") or cfg_all.get("delaySeconds", [12, 22])
                if args.delay_min is not None:
                    lo = args.delay_min
                if args.delay_max is not None:
                    hi = args.delay_max
                gap = random.uniform(min(lo, hi), max(lo, hi))
                log(f"  · 等待 {gap:.1f} 秒后继续（模拟人工节奏）")
                time.sleep(gap)

        log("")
        log(f"{name} 本次完成 {ok_count} 条，文件：{path}")
    except KeyboardInterrupt:
        log("\n[中断] 已保存当前进度。")
    finally:
        if args.keep_open:
            log("按回车关闭浏览器…")
            try:
                input()
            except Exception:
                pass
        ctx.close()
    return ok_count, len(todo)


def main():
    ap = argparse.ArgumentParser(description="AI 可见度监测台 · 网页回答采集器")
    ap.add_argument("--platform", default="deepseek",
                    help="平台 key（deepseek/doubao/kimi/yuanbao/yiyan）或 all")
    ap.add_argument("--round", default="", help="轮次标签，如 第1轮（默认取 config.json）")
    ap.add_argument("--limit", type=int, default=0, help="本次最多采几条（试跑用）")
    ap.add_argument("--login-timeout", type=int, default=300, help="等待登录的秒数")
    ap.add_argument("--reset", action="store_true", help="忽略已有进度，重新采")
    ap.add_argument("--delay-min", type=float, default=None, help="覆盖每条之间的最小间隔秒数")
    ap.add_argument("--delay-max", type=float, default=None, help="覆盖每条之间的最大间隔秒数")
    ap.add_argument("--keep-open", action="store_true", help="结束后不自动关浏览器")
    ap.add_argument("--dry-run", action="store_true",
                    help="试跑：结果写到「_试跑」文件，不碰正式结果（配 --limit 用）")
    ap.add_argument("--list", action="store_true", help="只列出平台与问题，不启动浏览器")
    ap.add_argument("--questions", default="",
                    help="指定问题清单文件（默认读 questions.json；做对照实验时用来换一套问题）")
    args = ap.parse_args()

    # 允许临时换一份问题清单，不必覆盖 questions.json（避免 A/B 两组实验互相污染）
    global QUESTIONS_PATH
    if args.questions:
        QUESTIONS_PATH = Path(args.questions).expanduser().resolve()
        if not QUESTIONS_PATH.exists():
            print(f"✗ 找不到问题清单：{QUESTIONS_PATH}")
            return 2

    # 防呆：重采 + 限条数会把正式结果截断成几条，必须先说清楚
    if args.reset and args.limit and not args.dry_run:
        print("✗ --reset 和 --limit 不能一起用：重采会清空进度，再限条数会把正式结果截断。")
        print("  要试跑请用：--limit 1 --dry-run（结果写到「_试跑」文件，不动正式数据）")
        return 2

    cfg_all = load_json(CONFIG_PATH, "配置文件 config.json")
    qdata = load_json(QUESTIONS_PATH, "问题清单 questions.json")
    questions = [q.strip() for q in qdata.get("questions", []) if q.strip()]
    if not questions:
        log("[错误] questions.json 里没有问题。")
        sys.exit(1)

    keys = list(cfg_all["platforms"].keys())
    if args.list:
        log("可用平台：")
        for k in keys:
            log(f"  - {k:10s} {cfg_all['platforms'][k]['name']}")
        log(f"问题清单（{len(questions)} 条）：")
        for q in questions:
            log(f"  · {q}")
        return

    targets = keys if args.platform == "all" else [args.platform]
    for k in targets:
        if k not in cfg_all["platforms"]:
            log(f"[错误] 未知平台 {k}，可用：{', '.join(keys)}")
            sys.exit(1)

    log("AI 可见度监测台 · 采集器")
    log(f"  目标品牌：{cfg_all.get('targetBrand', '')}    轮次：{args.round or cfg_all.get('round')}")
    log(f"  本次平台：{', '.join(cfg_all['platforms'][k]['name'] for k in targets)}    问题数：{len(questions)}")
    log("  提示：浏览器会自己弹出，登录动作由你完成；遇到验证码程序会暂停等你处理。")
    if args.dry_run:
        log("  试跑模式：本次结果写到「_试跑」文件，不会动正式结果。")
    if not OUT_DIR.exists():
        OUT_DIR.mkdir(parents=True, exist_ok=True)

    from playwright.sync_api import sync_playwright

    total_ok = 0
    total_todo = 0
    with sync_playwright() as p:
        for k in targets:
            ok, todo = collect_one(p, k, cfg_all, questions, args)
            total_ok += ok
            total_todo += todo

    log("")
    log("=" * 60)
    log(f"全部完成：本次抓取 {total_ok} / {total_todo} 条")
    log("下一步：")
    log("  1) 打开监测台 → 「记录」页 → 「导入备份」→ 选择 out/ 目录下刚生成的 JSON")
    log("  2) 在同一页点「一键判定未判定记录」，程序会自动填入是否提及/位次/来源")
    log("  3) 回「看板」看结果；有疑问的条目到「记录」页点「编辑」核对")
    log("=" * 60)


if __name__ == "__main__":
    main()
