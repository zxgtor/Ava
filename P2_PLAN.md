# P2 — MCP 客户端 + Filesystem Server

_Draft: 2026-04-24 · 待 Jason review_

> 本文档是 P2 的实施清单。范围、决策已与用户对齐；动工前这份计划是唯一真相。

---

## 范围（已与 Jason 对齐）

- **通用 MCP 框架** + **只挂一个** `@modelcontextprotocol/server-filesystem`
- Agent **tool-use 循环** 一起做（主进程执行 + renderer 增量渲染）
- 官方 npm 包 `spawn`，**白名单在 Ava 侧控制**（启动参数）
- Settings 里加 **MCP 配置区**（server 列表 + 启用 toggle + 目录白名单）
- **MessageBubble 渲染 tool-call 气泡**
- **工具执行全自动**（靠白名单兜底，无确认 UI）
- **白名单改完立即 kill + respawn**
- **工具命名带 namespace**：`servername.toolname`（e.g. `filesystem.read_file`）
- **Abort = 停 LLM fetch + 取消正在跑的 tool call + 不进入下一轮**
- **Tool-call 格式自动识别 + 缓存**（见下节）
- **Task boundary**：最新用户请求优先；旧失败请求不自动重试；工具调用必须服务于当前最新请求
- **P1 旧 conversations.json 清空**（bump schema version）

---

## Tool-call 格式识别机制

维护 `settings.modelToolFormatMap: { [providerId:modelId]: 'openai' | 'hermes' | 'none' }`。

**主进程双重解析**（always-on 的 fallback）：
1. 先读 SSE 里 `delta.tool_calls[...]` → 有 → `openai`
2. 没有就扫累积的 content，匹配 `<tool_call>{...}</tool_call>` 或 `<|tool_call|>` 类 Hermes 风格 → 有 → `hermes`
3. 两样都无 + 用户问题明显应该用工具 → 本轮记 `none`（第一次记录而已，继续当纯文本收尾）

**命中后写缓存**：下次同一 `providerId:modelId` 直接按缓存走那一种解析（省 CPU + 避免误判）；但 fallback 通道保留，缓存只是 hint。

**none 的模型**：Settings 的 provider 行给个小灰标 "no tool-use"；聊天时仍允许用，但不带 `tools` 参数。

---

## 数据结构变更

### `types.ts`

```ts
// Message.content 从 string → parts 数组
export type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call'
      id: string                 // matches the OpenAI tool_call id
      name: string               // 'filesystem.read_file'
      args: Record<string, unknown>
      status: 'pending' | 'running' | 'ok' | 'error' | 'aborted'
      result?: unknown           // JSON serializable
      error?: string
      startedAt?: number
      endedAt?: number
    }

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'   // 加 tool role
  content: ContentPart[]                            // ← 破坏性改动
  toolCallId?: string                               // role === 'tool' 时用
  createdAt: number
  streaming?: boolean
  error?: string
  aborted?: boolean
}

// 新：MCP server 配置
export interface McpServerConfig {
  id: string                     // 'filesystem' 是预置
  name: string
  command: string                // 'npx' / 绝对路径
  args: string[]                 // ['-y', '@modelcontextprotocol/server-filesystem', ...dirs]
  env?: Record<string, string>
  enabled: boolean
  // filesystem 专属：保存用户选的目录列表；保存时拼进 args
  allowedDirs?: string[]
  builtin?: boolean              // 预置条目不可整行删除
}

// Settings 加两个字段
export interface Settings {
  version: 2                                           // ← bump 1 → 2
  modelProviders: ModelProvider[]
  primaryModelChain: string[]
  persona: { userName: string; assistantName: string }
  mcpServers: McpServerConfig[]                        // 新
  modelToolFormatMap: Record<string, 'openai' | 'hermes' | 'none'>  // 新
}
```

### 持久化迁移

- `storage.ts` 加载时：若 `version !== 2` → **全部清空并写默认值**（含 conversations.json 归零）
- 不做内容迁移（Jason 确认旧对话可丢）

---

## 新增文件

### 主进程

```
electron/
├── services/
│   ├── mcpSupervisor.ts   — 管 stdio 子进程生命周期（spawn/kill/restart/crash 重拉）
│   └── mcpClient.ts       — @modelcontextprotocol/sdk 封装，list_tools / call_tool / cancel
├── ipc/
│   └── mcpIpc.ts          — registerMcpIpc(webContents)：list/restart/callTool 对 renderer
├── agent/
│   └── toolLoop.ts        — tool-use 循环控制器（新）
└── llm.ts                 — 改：支持 tools 参数 + 双重解析 + 返回结构化 tool_calls
```

### Renderer

```
src/
├── components/
│   └── ToolCallBubble.tsx      — 新：折叠/展开 + 状态色
├── lib/
│   └── mcp/
│       └── client.ts           — window.ava.mcp.* 薄封装
└── （改动）types.ts / store.tsx / MessageBubble.tsx / SettingsView.tsx / lib/agent/chat.ts / lib/llm/providers.ts
```

---

## IPC 新增

```ts
window.ava.mcp.listServers(): Promise<McpServerRuntime[]>
  // McpServerRuntime = config + { status, pid?, tools?: ToolDescriptor[], lastError? }

window.ava.mcp.restart(serverId): Promise<boolean>
window.ava.mcp.callTool({ serverId, toolName, args }): Promise<ToolResult>
window.ava.mcp.onServerStatus(cb): Unsubscribe   // status 变化推送

// llm.stream 返回的 result 扩展：
type StreamResult = {
  fullContent: string                // 仅文本部分（兼容老返回）
  parts: ContentPart[]               // 新：含 tool_call 的完整 parts
  toolCallsIssued: number
  loopRounds: number
  ...
}

// 新增 IPC event 推送给 renderer：
'ava:llm:part' { streamId, messageId, partIndex, part }   // 新 part 出现
'ava:llm:partUpdate' { streamId, messageId, partIndex, patch }  // tool_call status 变化
'ava:llm:chunk'（已有）表示 text part 的增量
```

---

## Tool-use 循环（主进程 `agent/toolLoop.ts`）

```
for round in 0..MAX_LOOP (10):
  stream LLM with messages + tools
  accumulate text parts + tool_calls (双重解析)
  if no tool_calls:
    emit final parts → break
  for each tool_call:
    namespaced name 'server.tool' → 找 serverId
    emit part { type: 'tool_call', status: 'running' }
    try:
      result = await mcpClient.callTool(...)
      emit partUpdate { status: 'ok', result }
      append role:'tool' message with result
    catch (err | abort):
      emit partUpdate { status: 'error'|'aborted', error }
      if abort: break outer loop
```

**Abort 机制**：
- `activeStreams.set(streamId, { controller, activeMcpCall?: McpCall })`
- `abort(streamId)`:
  1. `controller.abort()` → 停 LLM fetch
  2. `activeMcpCall?.cancel()` → 让 MCP client 发 cancel notification（SDK 支持）
  3. 设 `loopAborted = true`，当前 round 收尾后不再进下一轮
- 所有已出 part 标为 `status:'aborted'`

**MAX_LOOP = 10**，触顶时塞一条 system message `"tool loop exceeded, stopping"` 返回。

---

## P2.1 Task Boundary / Context Management

目标：防止模型在完整会话历史里看到旧失败请求后，自动继续执行旧任务。

规则：
- 最新用户消息是当前任务边界。
- 如果最新消息给了新的目标、路径、文件或 scope，新目标覆盖旧未完成请求。
- 因权限、白名单、工具不可用失败的旧请求，不会在后续轮次自动重试，除非最新消息明确要求继续或重试。
- 每次工具调用前必须服务于最新用户消息，而不是仅仅和历史旧请求相关。

实现：
- `lib/agent/chat.ts` 在 system prompt 中加入 task boundary rules。
- 每轮请求额外插入 `Current task boundary` system message，明确 latest user request。
- `electron/llm.ts` 在 filesystem tool call 前做保守路径范围检查：如果最新请求明确提到路径/scope，而工具调用路径不在该范围内，则拦截并把错误作为 tool result 回流给模型。

限制：
- 当前路径检查只覆盖 Windows 路径和 drive scope（例如 `D:` / `D:\Apps\Ava\package.json`）。
- 语义级“旧任务”判断仍主要靠 prompt；后续可引入 task id / intent tracker / context compaction。

---

## P2.2 Tool-use Reliability Pass

目标：让 filesystem tool-use 在失败、中断、重试时更可解释、更稳定。

完成项：
- `ToolCallBubble` 显示错误类别：任务边界拦截、白名单/权限、工具服务、用户中断、工具错误。
- `ToolCallBubble` 显示耗时和结果摘要，避免所有失败都只显示成笼统的“失败”。
- Stop 后 renderer 立即把当前 streaming assistant message 里的 running/pending tool-call 标成 `aborted`。
- Retry 支持“assistant message 本身没有 error，但其中 tool-call 失败/中断”的情况。

限制：
- Stop 的 UI 状态会立即更新，但底层 MCP call 是否及时停止取决于 server/SDK 对 AbortSignal 的支持。
- Retry 仍只允许重试最后一条 assistant message，避免中间轮次重试导致后续历史错位。

---

## P2.3 Active Task Context Filtering

目标：防止旧失败工具调用和旧未完成 intent 在后续轮次里被模型当作待办继续执行。

完成项：
- `lib/agent/chat.ts` 不再把旧 `role: 'tool'` 消息原样送入后续 LLM 请求。
- 旧 assistant 消息如果包含失败/中断 tool-call，会被替换成一条历史摘要，明确“不要自动重试”。
- 只保留最新用户请求前有限窗口的历史文本，减少旧 intent 对当前任务的干扰。
- `electron/llm.ts` 拦截与最新请求无关的 `filesystem.list_allowed_directories`，除非最新请求明确询问白名单/允许目录。

限制：
- 这是上下文过滤，不是完整 planner；模型仍可能用自然语言误解当前任务。
- 更强方案需要 task id、显式任务状态机或自动 compact/summary。

---

## Settings UI（SettingsView.tsx 新区块）

**MCP Servers** 区，放在 Providers 下方。

```
┌─ MCP Servers ──────────────────────────┐
│                                         │
│ ● Filesystem          [●────] enabled   │
│   npx -y @modelcontextprotocol/…        │
│   Allowed directories:                  │
│     D:\Apps\Ava              [×]        │
│     D:\Notes                 [×]        │
│     [+ Add directory]                   │
│   Status: running · 12 tools            │
│   [Restart]                             │
│                                         │
│ (P3：[+ Add custom server])             │
└─────────────────────────────────────────┘
```

- filesystem 条目 `builtin: true` → 不显示删除按钮，只能 toggle + 改目录
- 目录白名单改动 → debounce 500ms 之后保存 → 自动 kill/respawn，显示短暂 loading
- "Add directory" 按钮用 `dialog.showOpenDialog` 选目录（主进程暴露 `window.ava.dialog.pickDirectory`）
- Status 行实时显示 supervisor 上报的状态

---

## MessageBubble 改造

`content` 从 string 变 parts 数组，需要按 part 类型分别渲染：
- `text` part → `MarkdownContent`（跟现在一样）
- `tool_call` part → `<ToolCallBubble>`

**ToolCallBubble**：
- 折叠态：`⚙️ filesystem.read_file(path="D:\Notes\foo.md")` + 状态圆点
- 展开态：
  - `args` JSON（pretty）
  - `result` JSON（text/json 切换），过长自动截断 + 点开完整
- 状态色：running=蓝 / ok=绿 / error=红 / aborted=灰

---

## 我自己拍板的细节（review 时驳回也行）

| 项 | 决定 | 理由 |
|---|---|---|
| SDK 版本 | `@modelcontextprotocol/sdk` 锁当前 stable (^1.x) | 协议迭代快，lock 避免惊喜 |
| server 包 | `@modelcontextprotocol/server-filesystem` 预装到 dev dep；运行时用 `npx -y` 调用 | 省去装机检查；Windows `npx.cmd` 要处理 |
| Windows 路径 | 白名单 `path.resolve()` 规范化为绝对路径，保存前检查目录存在 | 避免路径相对解释错 |
| 多对话共享 server | 是，supervisor 是进程级单例 | 一般客户端都这么做 |
| server crash 重启 | 自动重启一次，再挂就标 error + 停止 | 避免无限 restart loop |
| system prompt 工具说明 | OpenAI 格式走 `tools` 参数**不注入 prompt**；Hermes 格式**注入**一段 tool list prompt（Hermes 协议要求） | 按协议走 |
| Namespace 分隔符 | `.`（例：`filesystem.read_file`）；模型输出 `read_file` 时按"当前唯一匹配"兜底解析 | 让老模型调用更宽松 |
| 空 result | 显示 "(empty result)" | UX |

---

## 开工顺序（每步完成 = 可 typecheck + 可手测）

1. **schema bump + 清空旧数据**（`storage.ts` + `types.ts` 只动 version）
2. **Message parts 改造**：store / MessageBubble / MarkdownContent 接 parts 数组，纯文本对话先跑通（还没 MCP）
3. **McpSupervisor + McpClient**：命令行可 spawn filesystem server、list_tools 跑通（main-only，无 UI）
4. **mcpIpc + preload 暴露 window.ava.mcp.***
5. **Settings UI 的 MCP 区块**（listServers / toggle / 白名单改动 → restart）
6. **toolLoop.ts + llm.ts 接 tools 参数**（OpenAI 格式先，单轮跑通）
7. **双重解析 + 缓存**（Hermes fallback）
8. **ToolCallBubble** + renderer 监听 `part` / `partUpdate` 事件
9. **Abort 接线**（LLM 停 + MCP cancel + 循环旗帜）
10. **清理 + typecheck + 更新 STATUS.md**

时间预估：5-7 天（比 STATUS.md 原估的 3-5 天多，主要是 tool_format 双重解析 + parts UI 改造比想象复杂）。

---

## 风险 / 未解

- **npx 首次拉包慢**：用户第一次启用 filesystem 时要等 `@modelcontextprotocol/server-filesystem` 下载（几秒到几十秒）。UI 要有 "installing…" 状态。是否改为预装（`npm install --workspace=@ava/shell @modelcontextprotocol/server-filesystem`）让启动即用？—— **推荐预装**，之后 P3 第三方 server 才走 npx。
- **LM Studio 小模型 tool-use 质量**：Qwen2.5-Instruct-7B 级别对 tool-use 的调用格式有时不稳。验收时要在 Jason 常用模型上手测一轮。
- **PowerShell 沙箱跑不动 Electron**：所有验收仍然在 Jason 的 Windows 机器上手测。
