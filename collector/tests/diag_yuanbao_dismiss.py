"""诊断：用真实元宝登录态打开页面，看 JS_DISMISS 会隐藏哪些元素（只报告，不真正执行）。
用法：python tests/diag_yuanbao_dismiss.py
"""
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from collector import PROFILE_DIR  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

REPORT_JS = """
() => {
  const DIALOG_HINT = /(dialog|modal|popup|guide|tip|notice|mask|overlay)/i;
  const HOLD_INPUT = 'textarea, input, [contenteditable="true"], [role="textbox"]';
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05;
  }
  const out = { candidates: [], masks: [] };

  document.querySelectorAll('div,section,aside').forEach(el => {
    const cls = (el.className && typeof el.className === 'string') ? el.className : '';
    const role = el.getAttribute('role') || '';
    if (!DIALOG_HINT.test(cls) && role !== 'dialog' && role !== 'alertdialog') return;
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 80) return;
    out.candidates.push({
      cls: cls.slice(0, 110),
      role: role,
      size: Math.round(r.width) + 'x' + Math.round(r.height),
      hasInput: !!el.querySelector(HOLD_INPUT),
      hasMarkdown: !!el.querySelector("[class*='markdown'],[class*='message'],[class*='chat'],[class*='content']"),
      closeBtns: Array.from(el.querySelectorAll('button,[role="button"],svg,[aria-label],[class*="close"]'))
        .filter(c => /关闭|close/i.test((c.getAttribute && (c.getAttribute('aria-label') || '')) + ' ' + ((c.className && typeof c.className === 'string') ? c.className : '')))
        .length,
      textHead: (el.innerText || '').trim().slice(0, 60).replace(/\\n/g, ' | ')
    });
  });

  document.querySelectorAll('div[class*="mask"],div[class*="overlay"],div[class*="backdrop"]').forEach(el => {
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < innerWidth * innerHeight * 0.35) return;
    const cls = (el.className && typeof el.className === 'string') ? el.className : '';
    out.masks.push({
      cls: cls.slice(0, 110),
      size: Math.round(r.width) + 'x' + Math.round(r.height),
      hasInput: !!el.querySelector(HOLD_INPUT),
      hasMarkdown: !!el.querySelector("[class*='markdown'],[class*='message'],[class*='chat'],[class*='content']"),
      textHead: (el.innerText || '').trim().slice(0, 60).replace(/\\n/g, ' | ')
    });
  });
  return out;
}
"""

with sync_playwright() as pw:
    ctx = pw.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE_DIR / "yuanbao"),
        headless=True,
        locale="zh-CN",
        viewport={"width": 1440, "height": 900},
        args=["--disable-blink-features=AutomationControlled"],
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto("https://yuanbao.tencent.com/chat/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(6000)

    res = page.evaluate(REPORT_JS)
    print("== 弹窗类候选（JS_DISMISS 会处理的） ==")
    for c in res["candidates"]:
        print(f"  class={c['cls']}")
        print(f"    role={c['role'] or '-'} size={c['size']} 含输入框={c['hasInput']} 含正文={c['hasMarkdown']} 关闭按钮={c['closeBtns']}")
        print(f"    文字: {c['textHead']}")
    print("\n== 大遮罩（会被隐藏的） ==")
    for m in res["masks"]:
        print(f"  class={m['cls']}")
        print(f"    size={m['size']} 含输入框={m['hasInput']} 含正文={m['hasMarkdown']}")
        print(f"    文字: {m['textHead']}")

    inp_visible = page.locator("div[contenteditable='true'],textarea").first.is_visible()
    print(f"\n输入框可见: {inp_visible}")
    print("页面标题:", page.title())
    ctx.close()
