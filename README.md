# AI 可见度监测台（GEO Monitor）

> 自动向多个国产 AI 对话平台提问 → 采集回答 → 自动判定「品牌是否被提及、首现位次、引用了哪些来源」→ 本地看板可视化。
>
> 一句话：把「AI 到底怎么谈论我们的品牌」这件主观的事，变成**可采样、可量化、可对比的数据**。

![License](https://img.shields.io/badge/license-MIT-blue)
![Python](https://img.shields.io/badge/python-3.10%2B-blue)
![Platform](https://img.shields.io/badge/platforms-DeepSeek%20%7C%20%E8%B1%86%E5%8C%85%20%7C%20Kimi%20%7C%20%E5%85%83%E5%AE%9D%20%7C%20%E6%96%87%E5%BF%83%E4%B8%80%E8%A8%80-green)

---

## ✨ 功能特性

| 模块 | 能力 |
|---|---|
| **多平台自动化采集** | 覆盖 DeepSeek、豆包、Kimi、腾讯元宝、文心一言 5 个平台，各平台选择器 / 等待策略 / 延迟参数全部配置化 |
| **拟人化采集节奏** | 单条串行、随机间隔、打字速度模拟；检测到验证码 / 风控提示时**自动暂停**，等待人工处理 |
| **登录态本地复用** | 浏览器会话保存在本地 `.profiles/`，登录一次长期可用；程序**不接触账号密码** |
| **效果自动判定** | 按品牌 / 竞品首现位置自动判定 `mentioned`、`firstRank`、`sources`，口径统一 |
| **本地数据看板** | 整体 / 关键词 / 平台三级联动筛选、引用来源排行、趋势图表；数据本地持久化，打开即看历史 |
| **实验能力** | `--questions` 参数切换问题组，支持 A/B 措辞实验与多轮次对比 |

## 🚀 快速开始

```bash
# 1. 环境要求：Python 3.10+
pip install playwright
playwright install chromium

# 2. 准备配置（复制示例文件并改成你的品牌与问题）
cp collector/config.example.json collector/config.json
cp collector/questions.example.json collector/questions.json
# 编辑 config.json：把 targetBrand 改成你要监测的品牌

# 3. 试跑采集（先在 DeepSeek 上跑 3 条）
cd collector
python collector.py --platform deepseek --limit 3

# 4. 启动看板
cd ../monitor
python server.py          # 默认 http://127.0.0.1:8765
```

macOS 用户可直接双击根目录的 `启动监测台.command` 与 `collector/运行采集.command`。

## 🧠 工作原理

```
questions.json（问题清单）
        │
        ▼
collector.py ──Playwright──▶ 各 AI 平台网页（开新对话、逐条提问、等待答案稳定、抓取原文与链接）
        │
        ▼
collector/out/答案_*.json（原始回答，含引用链接）
        │
        ▼
monitor/（导入 + 一键判定：mentioned / firstRank / sources）
        │
        ▼
本地看板（联动筛选、来源排行、趋势图）
```

- 判定逻辑集中在看板侧统一执行，采集器只存原始回答——**避免两端口径不一致**。
- 每次采集跑完刷新看板即是最新数据，无需手动导入。

## 📏 数据口径与方法论（这套方法论比代码更值钱）

在真实跑了两轮（10 关键词 × 5 平台、13 问题 × 5 平台）后沉淀的口径：

1. **单次采样不可比**：AI 输出有波动性，同一问题必须 **≥3 次采样取均值**（实测三次「否/是/是」≈67%，与五平台 60% 吻合）。
2. **AI 是「入榜优化」不是「排名优化」**：一旦被提及，位次基本在前 2；名单通常只有 2~3 席。
3. **各平台信源池不同**：同一品牌在不同平台提及率差异可达数倍，一篇通稿全平台发等于白发。
4. **决策题才点名**：「哪家好 / 推荐几家」这类要名单的问题才会提及品牌；概念题 AI 只做解释。

## 🕳 踩过的坑（工程侧）

- **登录态过期** → 整轮失败。已内置 `probe_doubao.py` 自动诊断。
- **新对话未生效，抓到上一条回答** → 必须做**开头去重校验**，否则脏数据会让结论完全反掉。
- **平台风控** → 检测到「人机验证 / 操作频繁」等关键词立即暂停，冷却后人工处理。

## 📁 目录结构

```
ai-visibility-monitor/
├── collector/                # 采集器（Playwright）
│   ├── collector.py          # 主采集程序
│   ├── config.example.json   # 平台与品牌配置（复制为 config.json 使用）
│   ├── questions.example.json# 问题清单示例
│   ├── judge_round2.py       # 判定脚本（mentioned/firstRank/sources）
│   ├── judge_collected.js    # 判定辅助（页面侧）
│   ├── summarize.py          # 汇总统计
│   ├── calibrate.py          # 选择器校准
│   ├── probe_doubao.py       # 豆包登录态诊断
│   └── tests/                # 本地测试桩与弹窗测试
├── monitor/                  # 本地看板（纯静态 + 只读 API）
│   ├── server.py             # 仅监听 127.0.0.1，含采集任务接口（白名单参数）
│   ├── index.html
│   ├── css/  js/             # app / store / analyzer / stats / charts
└── 启动监测台.command
```

## ⚠️ 免责声明

本工具仅供个人学习与研究用途。自动化访问第三方平台可能触发人机验证或账号限制，风险由使用者自行判断与承担。请遵守各平台的服务条款，控制采集频率，勿用于商业抓取。

本仓库**不包含任何真实采集数据、账号信息或登录凭证**；配置与问题清单均为示例。

## License

MIT
