# Ava — Current Status

_Last updated: 2026-04-23 · end of P1_

> 这个文件是"当前进度"的事实清单。要长期方案看 `ARCHITECTURE.md`。
> 新 code agent 接手：**先读这个文件**，再读 ARCHITECTURE.md，再看代码。

---

## TL;DR — 现在能干什么

- [x] 启动 Electron 窗口，系统边框，标题 "Ava"
- [x] 跟 LM Studio / Ollama / vLLM / llama.cpp / OpenAI / Groq / OpenRouter / Google AI Studio / Azure OpenAI 聊天
  - 走 OpenAI `/v1/chat/completions` 协议；**Anthropic 当前会炸**（它走 `/v1/messages`，需要单独 adapter）
- [x] 流式输出（SSE 解析在 main 进程里）
- [x] 多 provider fallback（chain 顺序，失败降级）
- [x] 设置里：provider 列表 / 启用开关 / baseUrl / apiKey / 默认模型 / 链顺序 / 连通性探测
- [x] 对话 + 设置持久化到 `%APPDATA%\Ava\*.json`
- [x] 多对话（用 header 的"新对话"按钮），**但还没侧边栏，旧对话不能切回**

---

## 怎么跑

```
cd D:\Apps\Ava
npm install                              # 只需第一次 / 依赖变化
npm run dev --workspace=@ava/shell       # 开发模式
```

改 main / preload 代码 → **必须 `Ctrl+C` 再重启**（renderer HMR 不覆盖主进程）。
改 renderer 代码 → 自动热更。

数据落盘位置：`%APPDATA%\Ava\` → `settings.json` + `conversations.json`。

**类型检查**：`npm run typecheck --workspace=@ava/shell`

---

## 文件地图（P1 写入的全部代码）

### 主进程 `apps/shell/electron/`

| 文件 | 责任 |
|---|---|
| `main.ts` | 启动窗口；注册 IPC handler（ping / paths / settings / conversations / llm stream / llm abort / llm probe） |
| `preload.ts` | `contextBridge.exposeInMainWorld('ava', …)` 暴露 API |
| `storage.ts` | `loadSettings/saveSettings/loadConversations/saveConversations`，原子写（`.tmp` → `rename`） |
| `llm.ts` | Node 端 `streamChat`：按 providers 顺序 fetch SSE，失败降级。chunk 通过 `webContents.send('ava:llm:chunk', ...)` 推给 renderer。支持 abort |

### Renderer `apps/shell/src/`

| 文件 | 责任 |
|---|---|
| `App.tsx` | `StoreProvider` + 根据 `viewMode` 切 ChatView / SettingsView |
| `main.tsx` | React 入口 |
| `index.css` | Tailwind 4 `@theme inline` tokens + 滚动条 + `gradient-text` + `streaming-dot` 动画 |
| `env.d.ts` | `window.ava: AvaApi`（从 preload 类型推导） |
| `types.ts` | `Message` / `Conversation` / `ModelProvider` / `Settings` / `ViewMode` |
| `store.tsx` | `useReducer` + Context。Actions：HYDRATE / SET_VIEW / CREATE/SELECT/DELETE/RENAME_CONVERSATION / ADD/UPDATE/APPEND_DELTA/DELETE_MESSAGE / UPDATE_SETTINGS。Mount 时 hydrate，state 变更 debounce 300-400ms 后 save |
| `lib/llm/providers.ts` | 10 家 provider 默认配置；`mergeModelProviders` / `normalizeProviderChain` / `getEnabledProviders` / `chatCompletionsEndpoint` / `modelsEndpoint` / `defaultSettings` |
| `lib/agent/chat.ts` | `sendChat`：拼 system prompt + 消息 → 调 `window.ava.llm.stream` → onDelta 回调。提供 `makeStreamId` / `makeMessageId` / `makeUserMessage` / `makeAssistantPlaceholder` |
| `components/ChatView.tsx` | 消息列表 + 自动滚动 + 调度 sendChat（发送、流式、停止、删除消息、删除对话、新对话、进设置） |
| `components/ChatHeader.tsx` | 顶部 bar：标题 / 删对话 / 新对话 / 进设置。高度 `h-11`，无自绘窗控（系统边框） |
| `components/MessageBubble.tsx` | 单条消息渲染。streaming 时右侧三个点动画。支持 delete（hover 出现）。**纯文本，无 Markdown** |
| `components/PromptInput.tsx` | textarea 自增高（max 220px）+ Enter 发送 / Shift+Enter 换行 + streaming 时切 StopCircle。禁用态显示 reason |
| `components/EmptyState.tsx` | 首次进入：gradient "你好 {userName}" + 4 个快速 prompt chips |
| `components/SettingsView.tsx` | 三段：Persona（用户/助手名字）/ Chain（链顺序 ↑↓ + 删 + 添加）/ Providers（展开编辑 + 探测连通性） |

### 工作空间根

| 文件 | 责任 |
|---|---|
| `ARCHITECTURE.md` | 长期方案 |
| `STATUS.md` | 当前进度（this file） |
| `README.md` | 项目简介 |
| `package.json` | npm workspaces |
| `.gitignore` | 排除 node_modules / out / user-plugins 内容 / _reference |
| `_reference/MyPerson/` | 只读参考源 |

---

## `window.ava.*` IPC 表面（renderer 可调用的全部）

```ts
window.ava.ping(): Promise<'pong'>
window.ava.paths.userData(): Promise<string>

window.ava.settings.load(): Promise<unknown>
window.ava.settings.save(data): Promise<boolean>

window.ava.conversations.load(): Promise<unknown>
window.ava.conversations.save(data): Promise<boolean>

window.ava.llm.stream(args: {
  streamId: string,
  messages: LlmMessage[],
  providers: ModelProvider[],  // already filtered+ordered by renderer
  temperature?: number,
}): Promise<
  | { ok: true, result: { fullContent, provider, model, attempts, fallbackUsed } }
  | { ok: false, error: string }
>
window.ava.llm.abort(streamId): Promise<boolean>
window.ava.llm.probe({ baseUrl, apiKey }): Promise<
  | { ok: true, models: string[] }
  | { ok: false, error: string }
>
window.ava.llm.onChunk((payload: { streamId, text }) => void): () => void  // returns unsubscribe
window.ava.llm.onAttempt((payload: { streamId, attempts }) => void): () => void
```

主进程对应的 IPC channel 名（全部在 `electron/main.ts` `registerIpc()` 里）：
`ava:ping` / `ava:paths:userData` / `ava:settings:load|save` / `ava:conversations:load|save` / `ava:llm:stream|abort|probe` / `ava:llm:chunk|attempt`（后两个是 main→renderer）

---

## 关键决策（P1 过程中做的，跟 ARCHITECTURE.md 初版不完全一致）

| 决策 | 为什么 | 在哪实现 |
|---|---|---|
| **LLM fetch 在 main 不在 renderer** | 云厂商 CORS、自签证书、代理、任意 header 只能在 Node 里解决；API key 不落 renderer | `electron/llm.ts` |
| **OpenAI `/v1/chat/completions` 统一协议** | 绝大多数 provider 支持；简化 adapter | `electron/llm.ts` + `lib/llm/providers.ts` |
| **Anthropic 当前不支持** | 它只有 `/v1/messages`，要单独 adapter；P1 范围外 | 需要 P1.5 或 P2 补 |
| **系统默认窗口边框** | P1 没多页面，自绘标题栏意义不大 | `electron/main.ts` |
| **lucide-react 图标** | 离线可用、TS 友好 | 全部 components |
| **沿用 MyPerson 色板** | 省时间、风格一致 | `src/index.css` |
| **P1 不做 Markdown / 会话列表 / 搜索** | 用户选择先保证流式 + 持久化跑通 | — |
| **首字符前导空白吃掉** | Qwen 之类的 chat-tuned 模型会在 assistant 角色后吐 `\n` | `electron/llm.ts` `pushDelta` |
| **探测连通性走 main** | 云 `/v1/models` 对 browser 有 CORS | `electron/main.ts` `ava:llm:probe` handler |

---

## 已知问题 / 踩过的坑

1. **LM Studio 新版（2024 下半年起）默认要 API token**
   - 症状：HTTP 401，报文里提到 `An LM Studio API token is required`
   - 解：LM Studio → Developer → Settings → 关 `Enable API token authentication`；或 copy token 填到 Ava 设置
2. **Qwen2.5 首字符 `\n`**
   - 症状：回复开头一个空行
   - 解：已在 `electron/llm.ts` `pushDelta` 里吃掉首 `\s*`。**不影响正文换行**
3. **Anthropic 在当前实现下会炸**
   - `/v1/messages` 不是 OpenAI 兼容；参数名、header 名（`x-api-key`、`anthropic-version`）都不同
   - 暂时别启用 Anthropic provider
4. **修 main/preload 代码不会热更**
   - 必须 `Ctrl+C` 重启 `npm run dev`
5. **PowerShell MCP 对 `git` / `npm` 命令会 timeout**（沙箱环境的问题，不是 Ava 的）
   - 用户在自己的 Windows 终端跑这些命令就没事
6. **Git 仓库初始化当前在 Windows 完成**（沙箱 `rm -rf .git` 权限拒绝过，不要在沙箱重置 `.git/`）

---

## P1.5 候选打磨项（未开工）

按用户价值排序：

| 项目 | 价值 | 工作量 | 备注 |
|---|---|---|---|
| **Markdown 渲染** | 高 —— 代码/格式化回复现在没法看 | 2h | 加 `react-markdown` + `remark-gfm` + `rehype-highlight`。在 `MessageBubble` 里做 role-aware：user 纯文本，assistant Markdown |
| **会话列表侧边栏** | 高 —— 多对话不能切 | 4-6h | 新 `ConversationSidebar.tsx`；store 已经有 `SELECT_CONVERSATION`。按 `updatedAt` 倒序；支持重命名 |
| **Anthropic adapter** | 中 —— 用户要用 Claude | 3h | `electron/llm.ts` 里按 `provider.id === 'anthropic'` 走另一套 request/SSE 解析（`/v1/messages`，`event: content_block_delta`） |
| **流式中断反馈** | 中 —— StopCircle 已接线但没视觉区分 | 1h | 中断后消息标一个 `aborted: true`，气泡给灰色边 |
| **失败消息重试** | 中 | 2h | error 气泡右下加"重试"按钮 |
| **持久化迁移 / 版本号** | 低但重要 | 1h | `settings.version` 已经在结构里但没写迁移。将来 schema 变要做 |
| **ChatHeader 搜索框** | 低 —— 用户 P1 选了不做 | 3h | 再延后 |

---

## 下一步候选（给 code agent 或用户选）

### A. 最小打磨（Markdown + sidebar）
目标：P1 能日常用。工作量 ~半天。
做完这两个就可以进入 P2，不必做全套 P1.5。

### B. P1.5 全套
目标：P1 完全稳定。工作量 ~1.5-2 天。
包括 Markdown + sidebar + Anthropic + 中断反馈 + 重试。

### C. 直接 P2 — MCP 客户端
目标：插件平台的核心能力。工作量 3-5 天。
- `apps/shell/electron/services/mcpSupervisor.ts`：spawn/kill stdio MCP server 子进程
- `apps/shell/electron/services/mcpClient.ts`：MCP 协议握手（`list_tools` / `call_tool` / `list_resources` / `list_prompts`），用 `@modelcontextprotocol/sdk`
- `apps/shell/electron/ipc/mcpIpc.ts`：renderer 能看到可用的 MCP tools
- `lib/agent/chat.ts` 扩展：tool-use 循环（模型输出 `tool_calls` → 执行 → 塞结果回 messages → 再调）
- `MessageBubble` 加 tool-call 渲染（MyPerson 里有参考，但不要照搬）

### D. P3 预研 — 插件发现
可以跟 P2 并行做一部分（纯 renderer 侧）：
- `apps/shell/electron/services/pluginManager.ts` 扫 `user-plugins/*`
- 解析 `.claude-plugin/plugin.json` + `.mcp.json`
- UI 里展示插件列表（禁用/启用按钮暂时是 mock，真启用在 P3 完整实施时接 MCP supervisor）

**推荐顺序**：**A（半天）→ C（P2, 3-5 天）→ D/P3 扫描（并行）→ P3 启用/禁用 → P4 市场**

---

## 用户偏好（新 agent 必须遵守）

- **中文回答**，简洁明了
- 不清楚的地方**直接讨论**，不要瞎猜
- 发现计划错误 / 缺失 → **追问到底**，不要放过
- 代码写完 → 不做验证步骤 / 不改 git 配置 / 不 force push / 不 `--no-verify`
- 文件位置：所有 Ava 代码在 `D:\Apps\Ava\`；用户插件安装路径 `D:\Apps\Ava\user-plugins\`（gitignored）；MyPerson 在 `D:\Apps\Ava\_reference\MyPerson\`（只读）

---

## 给接手 agent 的快速上手

1. 读这个文件 + ARCHITECTURE.md
2. `cd D:\Apps\Ava && npm install && npm run dev --workspace=@ava/shell`
3. 启动后验证：设置 → 确认 LM Studio 已启用 → 探测连通性 → 返回聊天 → 发消息看流式
4. 想干活之前先跟用户确认"下一步做 A / B / C / D 哪个"
5. 动工前读相关源文件（不要凭记忆），动工后跑 `npm run typecheck --workspace=@ava/shell`
6. 改完让用户手动测（开发机 Windows；沙箱跑不了 Electron GUI）
7. 每次完成一个里程碑：更新 STATUS.md（至少 TL;DR + 新增文件/决策）
