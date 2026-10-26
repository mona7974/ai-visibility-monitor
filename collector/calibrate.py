#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
页面结构校准工具：当采集器抓不到回答（或抓错）时用它。

用法：
    python calibrate.py --platform doubao

流程：
    1) 弹出浏览器 → 你完成登录
    2) 在页面里手动提一个问题，等答案生成完
    3) 回到终端按回车 → 程序把页面上所有「文字块」按长度排序列出来
    4) 找到那条长度最大、内容就是回答的块，把它的 class 复制到 config.json
       对应平台的 answerSelectors 数组最前面（写成 [class*='xxx'] 形式）
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "config.json"

JS_DUMP = """
() => {
  const vis = el => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 20 && r.height > 10 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const out = [];
  for (const el of document.querySelectorAll('div,article,section,main,p')) {
    if (!vis(el)) continue;
    const t = (el.innerText || '').trim();
    if (t.length < 40) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: typeof el.className === 'string' ? el.className : '',
      id: el.id || '',
      len: t.length,
      links: el.querySelectorAll('a[href]').length,
      head: t.slice(0, 70).replace(/\\s+/g, ' ')
    });
  }
  out.sort((a, b) => b.len - a.len);
  const inputs = [];
  for (const s of ['textarea', "div[contenteditable='true']", "[role='textbox']", 'input']) {
    for (const el of document.querySelectorAll(s)) {
      if (!vis(el)) continue;
      inputs.push({ sel: s, cls: typeof el.className === 'string' ? el.className : '', id: el.id || '' });
    }
  }
  return { blocks: out.slice(0, 30), inputs: inputs.slice(0, 15) };
}
"""


def main():
    ap = argparse.ArgumentParser(description="页面结构校准")
    ap.add_argument("--platform", required=True, help="平台 key，如 doubao")
    args = ap.parse_args()

    cfg_all = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if args.platform not in cfg_all["platforms"]:
        print(f"[错误] 未知平台 {args.platform}，可用：{', '.join(cfg_all['platforms'])}")
        sys.exit(1)
    cfg = cfg_all["platforms"][args.platform]

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        profile = BASE / ".profiles" / args.platform
        profile.mkdir(parents=True, exist_ok=True)
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(profile),
            headless=False,
            locale="zh-CN",
            viewport={"width": 1440, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(cfg["url"], wait_until="domcontentloaded", timeout=60000)
        print(f"已打开 {cfg['name']}：{cfg['url']}")
        print("请完成登录，并在页面里手动提一个问题，等答案完整显示出来。")
        try:
            input("\n>>> 答案显示完整后，回到这里按【回车】开始分析页面结构…")
        except EOFError:
            pass

        data = page.evaluate(JS_DUMP)
        lines = []
        lines.append(f"页面结构分析  {cfg['name']}  {datetime.now():%Y-%m-%d %H:%M:%S}")
        lines.append("")
        lines.append("【输入框候选】 → 对应 config.json 的 inputSelectors")
        for it in data["inputs"]:
            lines.append(f"  {it['sel']:28s} id={it['id']:<16s} class={it['cls'][:80]}")
        lines.append("")
        lines.append("【文字块按长度排序】 → 找到那条就是 AI 回答的，把它的 class 写进 answerSelectors")
        lines.append("  长度     链接  标签   class / id                          开头内容")
        for b in data["blocks"]:
            cls = (b["cls"] or "")[:60]
            lines.append(f"  {b['len']:>7} {b['links']:>4}  {b['tag']:<6} id={b['id'][:18]:<18} {cls}")
            lines.append(f"            └─ {b['head']}")
        text = "\n".join(lines)
        print("\n" + text)

        out = BASE / f"calibration_{args.platform}.txt"
        out.write_text(text, encoding="utf-8")
        print(f"\n已保存到：{out}")
        print("把要用的 class 片段（例如 hyc-content-md）告诉我，我帮你改进 config.json。")
        try:
            input("\n>>> 按【回车】关闭浏览器…")
        except EOFError:
            pass
        ctx.close()


if __name__ == "__main__":
    main()
