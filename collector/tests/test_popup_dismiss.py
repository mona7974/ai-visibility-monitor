"""回归测试：弹窗遮挡输入框时，采集器能否自动清掉并成功发送。

复现的是 2026-10-13 文心一言真实故障：
  第1、2题 → <div class="cos-dialog-body"> intercepts pointer events → 点击超时
  加了 dismiss_popups 后应能自动关弹窗并成功输入。

用法：python tests/test_popup_dismiss.py
"""
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import collector as C  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

FIXTURE = (ROOT / "tests" / "popup_block.html").as_uri()
CFG = {"name": "复现页", "inputSelectors": ["#chat-textarea"], "newChatTexts": []}

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  ✓ " if ok else "  ✗ ") + name + (f"  {detail}" if detail else ""))


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)

    # --- 场景 A：不加处理，直接点 → 应该被弹窗挡住（复现原 bug） ---
    print("\n[场景 A] 原行为：弹窗挡路时直接点输入框")
    page = browser.new_page()
    page.goto(FIXTURE)
    page.wait_for_timeout(300)
    blocked = False
    try:
        page.locator("#chat-textarea").first.click(timeout=3000)
    except Exception as exc:
        blocked = "intercepts pointer events" in str(exc)
    check("弹窗确实会拦住点击（bug 可复现）", blocked)
    page.close()

    # --- 场景 B：加了 dismiss_popups → 应能关掉弹窗并成功输入 ---
    print("\n[场景 B] 新行为：先清弹窗，再点输入框")
    page = browser.new_page()
    page.goto(FIXTURE)
    page.wait_for_timeout(300)

    acted = C.dismiss_popups(page, quiet=True)
    check("dismiss_popups 报告清掉了遮挡", acted is True)
    gone = page.locator(".cos-dialog").count() == 0
    check("引导弹窗已从页面移除", gone)

    decoy = page.locator("#decoy-dialogue").is_visible()
    check("诱饵 agent-dialogue（对话正文）未被误藏", decoy,
          "元宝事故回归点：dialogue ≠ dialog")

    inp, _ = C.find_input_wait(page, CFG, timeout=5)
    check("能找到输入框", inp is not None)

    sent = False
    try:
        inp.click(timeout=3000)
        inp.type("数据中心机柜租赁价格", delay=5)
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        sent = page.locator("#answer").inner_text().startswith("已收到问题")
    except Exception as exc:
        print("    出错：", str(exc).splitlines()[0])
    check("输入并回车成功（原来这一步会超时）", sent,
          page.locator("#answer").inner_text()[:30])

    # --- 场景 C：不能让 dismiss 误伤含输入框的正常界面 ---
    print("\n[场景 C] 安全性：dismiss 不能把含输入框的主体藏掉")
    page2 = browser.new_page()
    page2.goto(FIXTURE)
    page2.locator(".close-x").click()          # 先手动关掉弹窗
    page2.wait_for_timeout(200)
    C.dismiss_popups(page2, quiet=True)
    still = page2.locator("#chat-textarea").is_visible()
    check("输入框仍可见（未被误藏）", still)
    page2.close()

    browser.close()

print("\n" + "=" * 52)
failed = [r for r in results if not r[1]]
print(f"结果：{len(results) - len(failed)} / {len(results)} 通过")
if failed:
    print("失败项：" + "、".join(r[0] for r in failed))
    sys.exit(1)
print("全部通过 ✅")
