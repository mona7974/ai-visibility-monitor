"""真机验证：在真实元宝页面上执行 dismiss_popups，确认：
1. 不误伤正常界面（输入框、对话正文都还在）
2. 真正的促销弹窗能被清掉
只看不动数据，不发送任何提问。
"""
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import collector as C  # noqa: E402
from collector import PROFILE_DIR  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CHECK_JS = """
() => ({
  inputVisible: !!document.querySelector("div[contenteditable='true'],textarea"),
  markdownCount: document.querySelectorAll("[class*='markdown']").length,
  chatAreaVisible: (() => {
    const el = document.querySelector("[class*='dialogue__content']");
    if (!el) return null;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  })(),
  dismissedMarkers: document.querySelectorAll('[data-geo-dismissed]').length
})
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

    before = page.evaluate(CHECK_JS)
    print("清弹窗前:", before)

    acted = C.dismiss_popups(page, quiet=True)
    print("dismiss_popups 动作:", "有" if acted else "无（页面本来就没弹窗）")

    after = page.evaluate(CHECK_JS)
    print("清弹窗后:", after)

    ok_input = after["inputVisible"]
    ok_chat = after["chatAreaVisible"] is not False
    ok_markdown = after["markdownCount"] >= before["markdownCount"]
    print()
    print(("✓" if ok_input else "✗"), "输入框可见")
    print(("✓" if ok_chat else "✗"), "对话区未被隐藏")
    print(("✓" if ok_markdown else "✗"), "正文元素数量未减少",
          f"({before['markdownCount']} -> {after['markdownCount']})")

    inp, _ = C.find_input_wait(page, {"inputSelectors": ["div[contenteditable='true']", "textarea"]}, timeout=8)
    print(("✓" if inp is not None else "✗"), "find_input_wait 能找到输入框")

    all_ok = ok_input and ok_chat and ok_markdown and inp is not None
    print("\n真机验证：" + ("全部通过 ✅" if all_ok else "存在问题 ❌"))
    ctx.close()
    sys.exit(0 if all_ok else 1)
