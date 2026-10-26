#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 2 轮结果判定：把采集到的原始回答判成「是否提到目标品牌」，并输出对比报告。

跟第 1 轮口径保持一致：
  · 提到 = 回答正文出现品牌中文名或简称
  · 首现位次 = 在同一段回答里，目标品牌在「被点名的公司」中排第几
  · 引用来源 = 采集器已抽好的 sources 字段
用法：python judge_round2.py 答案_deepseek_第2轮_20261021.json
"""
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
OUT = BASE / "out"

BRAND = ["示例品牌"]  # 改成你要监测的品牌
COMPETITORS = [
    # 按你的行业替换为真实竞品名
    "竞品A", "竞品B", "竞品C", "阿里云", "腾讯云", "华为云",
]


def first_index(text, names):
    hits = []
    for n in names:
        i = text.find(n)
        if i >= 0:
            hits.append((i, n))
    return hits


def judge(rec):
    txt = rec.get("rawAnswer") or ""
    hit_brand = [n for n in BRAND if n in txt]
    rec["mentioned"] = "是" if hit_brand else "否"

    if hit_brand:
        brand_pos = min(txt.find(n) for n in hit_brand)
        comp_hits = first_index(txt, COMPETITORS)
        rank = 1 + sum(1 for pos, _ in comp_hits if pos < brand_pos)
        rec["firstRank"] = str(rank)
        rec["competitors"] = "、".join(n for _, n in sorted(comp_hits)[:6])
    else:
        rec["firstRank"] = ""
        comp_hits = first_index(txt, COMPETITORS)
        rec["competitors"] = "、".join(n for _, n in sorted(comp_hits)[:6])
    rec["sentiment"] = "不适用" if not hit_brand else "中性"
    rec["hasError"] = "无"
    return rec


def main():
    fname = sys.argv[1] if len(sys.argv) > 1 else "答案_deepseek_第2轮_20261021.json"
    src = OUT / fname
    data = json.loads(src.read_text(encoding="utf-8"))
    recs = [judge(r) for r in data.get("records", [])]
    data["records"] = recs

    dst = src.with_name(src.stem + "_已判定.json")
    dst.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    total = len(recs)
    hit = sum(1 for r in recs if r["mentioned"] == "是")
    print(f"文件：{fname}    条数：{total}    提到：{hit}    提及率：{hit/total*100:.0f}%" if total else "无记录")
    print()
    print(f"{'问题':46s} {'提及':4s} {'位次':4s} 引用来源")
    print("-" * 110)
    for r in recs:
        srcs = (r.get("sources") or "（无链接）").split(";")
        srcs = "、".join(s.strip() for s in srcs[:3] if s.strip())
        print(f"{(r['keyword'])[:44]:46s} {r['mentioned']:4s} {r.get('firstRank') or '-':4s} {srcs}")
    print()
    yes = [r for r in recs if r["mentioned"] == "是"]
    if yes:
        print("命中详情：")
        for r in yes:
            print(f"  · {r['keyword']} → 第 {r['firstRank']} 位；同现：{r.get('competitors') or '无'}")
    print()
    print(f"已判定结果另存：{dst.name}")


if __name__ == "__main__":
    main()
