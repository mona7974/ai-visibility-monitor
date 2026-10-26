"""5 平台采集结果汇总 + 数据体检。

用法：
    python summarize.py                 # 汇总 out/ 下各平台最新一轮
读的是「已判定」文件（没有就用原始文件，原始文件里的判定字段是空的）。

输出：每个平台的提及数/提及率/首次位次、合计、
      引用来源 TOP、竞品 TOP、按关键词提及分布，并对可疑数据（思考过程/框架文字）报警。
"""
from __future__ import annotations

import json
import pathlib
import re
from collections import Counter, defaultdict

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "out"

PLATFORMS = [
    ("deepseek", "DeepSeek"),
    ("doubao", "豆包"),
    ("kimi", "Kimi"),
    ("yuanbao", "腾讯元宝"),
    ("yiyan", "文心一言"),
]

COMPETITORS = [
    # 按你的行业替换为真实竞品名
    "示例品牌", "竞品A", "竞品B", "竞品C", "阿里云", "腾讯云", "华为云",
]

# 可疑内容特征（思考过程 / 页面框架）
SUSPECT = re.compile(
    r"用户问的是|我需要考虑|是否需要联网搜索|用户位置是|问题比较宽泛|"
    r"让我(思考|组织|先)|我应该(先|给出)|我已有足够数据|内容要点：|"
    r"用户在[^，。]{0,8}(台北|台湾|中国台湾)|扫码登录|微信登录|用户服务协议"
)


def pick_file(key: str) -> pathlib.Path | None:
    """优先用「已判定」，否则用原始文件；都排除 备份/试跑。"""
    cands = []
    for pat in (f"答案_{key}_*_已判定.json", f"答案_{key}_*.json"):
        for p in OUT.glob(pat):
            if any(t in p.name for t in ("备份", "试跑", "stub")):
                continue
            cands.append(p)
    cands.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return cands[0] if cands else None


def load(p: pathlib.Path) -> list[dict]:
    data = json.loads(p.read_text(encoding="utf-8"))
    recs = data.get("records", data) if isinstance(data, dict) else data
    return [r for r in recs if isinstance(r, dict)]


def main() -> None:
    src_total = Counter()
    comp_total = Counter()
    kw_stat: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    tot_n = tot_m = 0
    rows = []

    for key, label in PLATFORMS:
        p = pick_file(key)
        if p is None:
            rows.append((label, None, 0, 0, None, 0))
            continue
        recs = load(p)
        n = len(recs)
        m = sum(1 for r in recs if str(r.get("mentioned")).strip() == "是")
        ranks = [float(r["firstRank"]) for r in recs
                 if str(r.get("mentioned")).strip() == "是"
                 and str(r.get("firstRank", "")).strip() not in ("", "None", "无")]
        suspect = [r["keyword"] for r in recs if SUSPECT.search(r.get("rawAnswer") or "")]

        tot_n += n
        tot_m += m
        for r in recs:
            kw = (r.get("keyword") or "").strip()
            if kw:
                kw_stat[kw][1] += 1
                if str(r.get("mentioned")).strip() == "是":
                    kw_stat[kw][0] += 1
            text = (r.get("rawAnswer") or "")
            for c in COMPETITORS:
                if c in text:
                    comp_total[c] += 1
            for x in re.split(r"[;;，,、]", r.get("sources") or ""):
                x = x.strip()
                if x:
                    src_total[x] += 1

        rows.append((label, m, n, (m / n * 100 if n else 0),
                     (sum(ranks) / len(ranks) if ranks else None), len(suspect)))
        if suspect:
            print(f"  ⚠️ {label} 有 {len(suspect)} 条可疑（思考过程/框架文字）：{suspect}")

    print()
    print(f"{'平台':<10}{'提及':>8}{'提及率':>8}{'首次位次':>10}")
    print("-" * 40)
    for label, m, n, rate, rank, _ in rows:
        if m is None:
            print(f"{label:<10}{'—':>9}{'未采集':>9}")
            continue
        rk = f"{rank:.1f}" if rank else "—"
        print(f"{label:<10}{f'{m}/{n}':>9}{f'{rate:.0f}%':>9}{rk:>11}")
    print("-" * 40)
    print(f"{'合计':<10}{f'{tot_m}/{tot_n}':>9}{f'{tot_m/tot_n*100:.0f}%':>9}")

    print()
    print("引用来源 TOP10：", "、".join(f"{k} ×{v}" for k, v in src_total.most_common(10)))
    print("竞品提及 TOP8：", "、".join(f"{k} ×{v}" for k, v in comp_total.most_common(8)))

    print()
    print("按关键词提及（全部平台）：")
    for kw, (m, n) in sorted(kw_stat.items(), key=lambda kv: -kv[1][0] / max(kv[1][1], 1)):
        print(f"  {m}/{n}  {kw}")


if __name__ == "__main__":
    main()
