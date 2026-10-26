# -*- coding: utf-8 -*-
"""豆包采集失败诊断：打开豆包、截图、列出页面上文字最多的元素，判断是登录墙还是选择器变了。"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parent
PROFILE = BASE / ".profiles" / "doubao"
SHOT = BASE.parent / ".workbuddy" / "probe-doubao.png"

JS_BLOCKS = """() => {
  const out = [];
  document.querySelectorAll('div,section,article').forEach(el => {
    const t = (el.innerText || '').trim();
    if (t.length < 60) return;
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 30) return;
    out.push({ len: t.length, cls: (el.className || '').toString().slice(0, 120),
               tag: el.tagName.toLowerCase(), head: t.slice(0, 60).replace(/\\n/g, ' ') });
  });
  out.sort((a, b) => b.len - a.len);
  return out.slice(0, 10);
}"""

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(str(PROFILE), headless=False,
                                              viewport={"width": 1280, "height": 900})
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto("https://www.doubao.com/chat/", wait_until="domcontentloaded")
    page.wait_for_timeout(9000)
    print("URL:", page.url)
    print("TITLE:", page.title())
    body = page.evaluate("() => (document.body.innerText || '').length")
    print("正文字数:", body)
    page.screenshot(path=str(SHOT), full_page=False)
    print("截图:", SHOT)
    blocks = page.evaluate(JS_BLOCKS)
    for b in blocks:
        print(f"  len={b['len']:5d} <{b['tag']}> cls={b['cls']!r} | {b['head']}")
    print("输入框候选:", page.evaluate(
        "() => [...document.querySelectorAll('textarea,[contenteditable=true],[role=textbox]')]"
        ".filter(e=>e.getBoundingClientRect().width>100).map(e=>e.tagName+'.'+(e.className||'').toString().slice(0,60))"))
    ctx.close()
