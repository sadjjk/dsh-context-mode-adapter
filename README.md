# dsh-context-mode-adapter

DeepSeek Harness 插件：以独立插件形式接入 [context-mode](https://github.com/mksglu/context-mode)，实现工具输出 sandbox 化与上下文节省。

## 功能

- **工具层**：通过 `dsh-mcp-client` 接入 context-mode stdio MCP server，暴露 11 个 `mcp__context-mode__ctx_*` 工具（ctx_execute / ctx_batch_execute / ctx_index / ctx_search 等）
- **hook 层**：进程内 import context-mode 的 routing/session API，订阅 DSH cordis 工具事件，实现 PreToolUse 硬拦截（重定向大输出工具到 sandbox）+ PostToolUse 落库 + 会话连续性（PreCompact 快照 + SessionStart 恢复）
- **设置**：插件页可展开行，3 项可配（context-mode 路径自动检测 / 存储根 / 工具超时）

## 前置依赖

- context-mode 全局安装：`npm install -g context-mode`
- DSH desktop/web profile

## 安装

```bash
# 1. 构建插件
pnpm install
pnpm build

# 2. 注册到 DSH profile（link 到 node_modules）
pnpm register            # 默认 desktop profile
# 或: bash scripts/register.sh web

# 3. 重启 DSH，验证
dsh --dump-config | grep -E 'mcp-context-mode|dsh-context-mode-adapter'
```

重启后在 DSH 会话中应可调用 `mcp__context-mode__ctx_stats` 等工具。

## 运行时验证

```bash
node scripts/verify-runtime.mjs   # context-mode doctor + better-sqlite3 + API 可解析
node scripts/compat-check.mjs     # context-mode 升级后 API 签名回归检测
```

## 配置

插件页 → Context Mode Bridge 可展开行，3 项：

| 设置 | 默认 | 说明 |
|------|------|------|
| context-mode 可执行路径 | 自动检测 | stdio MCP server 启动命令，首次自动检测填充 |
| 存储根目录 | `~/.dsh/context-mode` | context-mode sessions/content/索引落点 |
| 工具调用超时(ms) | 60000 | 单次 callTool 超时 |

## 许可

本插件代码按其 LICENSE 发布。context-mode 本体为 Elastic License 2.0（ELv2），本插件仅 import 其 API，不修改其源码。
