# dsh-context-mode-adapter

[context-mode](https://github.com/mksglu/context-mode) 没有官方 DSH 插件——本仓库补上这个空缺：把 context-mode 的沙箱工具与 hook 路由接入 DeepSeek Harness（DSH），实现会话上下文节省。

## 它做什么

| 层 | 能力 |
|---|---|
| 工具 | 11 个 `ctx_*` 工具进程内注册：`ctx_execute` 沙箱执行只回摘要、`ctx_index`/`ctx_search` FTS5 知识库、`ctx_batch_execute` 并行批量、`ctx_fetch_and_index` 网页抓取入库；大输出原文不进对话 |
| hook | 工具调用前置硬拦截（引导大输出走沙箱）、每轮 routing block 注入（presence 窗口防重）、工具结果落库、compaction 快照续接 |
| 设置卡 | 接入状态展示、doctor 一键验证、工具启停开关 |

## 与自带 openclaw adapter 的区别

context-mode 自带 openclaw adapter（ELv2 许可内），没有 DSH 对应实现，两者接入方式不同：

| | openclaw adapter | 本插件（DSH） |
|---|---|---|
| 工具执行 | 11 个工具为 stub 占位，不执行；真实执行依赖外挂独立 stdio MCP server | 宿主进程内直调核心 handler，零额外子进程 |
| 事件接入 | openclaw 事件总线 | DSH cordis 事件（tools/execute、agent/pre-step、compaction/start） |
| 设置界面 | 无 | DSH 设置卡 |

## 安装

前置：全局安装 context-mode。

```bash
npm install -g context-mode
```

DSH 桌面版：插件管理 → 添加插件 → 输入仓库地址 `https://github.com/sadjjk/dsh-context-mode-adapter` → 确认。

![在 DSH 桌面版添加插件](https://webp.sadjjk.cn/dsh-context-mode-adapter/2026-10-09-install.jpg)

## 设置

插件页 → Context Mode Bridge：显示 context-mode 检测路径与接入状态，可 doctor 验证、按工具启停。

![插件设置卡](https://webp.sadjjk.cn/dsh-context-mode-adapter/2026-10-09-settings.jpg)

## 许可

本插件按 LICENSE 发布；context-mode 本体为 Elastic License 2.0（ELv2），本插件仅 import 其 API，不修改其源码。
