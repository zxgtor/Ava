# Ava — Current Status

_Last updated: 2026-05-03 · Built-in Tools Smoke Test + Status Cleanup_

> 这个文件是"当前进度"的事实清单。要长期方案看 `ARCHITECTURE.md`。
> 新 code agent 接手：**先读这个文件**，再读 ARCHITECTURE.md，再看代码。

---

## TL;DR — 现在能干什么

- [x] 启动 Electron 窗口，系统边框，标题 "Ava"
- [x] 跟 LM Studio / Ollama / vLLM / llama.cpp / OpenAI / Anthropic / Groq / OpenRouter / Google AI Studio / Azure OpenAI 聊天
  - 绝大多数走 OpenAI `/v1/chat/completions` 协议；**Anthropic 走 `/v1/messages` adapter**（`electron/adapters/anthropic.ts`）
- [x] 流式输出（SSE 解析在 main 进程里）
- [x] 多 provider fallback（chain 顺序，失败降级）
- [x] 设置里：provider 列表 / 启用开关 / baseUrl / apiKey / 默认模型 / 链顺序 / 连通性探测
- [x] 对话 + 设置持久化到 `%APPDATA%\Ava\*.json`
- [x] 多对话 + **侧边栏切换**（`ConversationSidebar.tsx`），按 updatedAt 倒序
- [x] **Markdown 渲染**（`MarkdownContent.tsx`，assistant 消息用）
- [x] **Filesystem MCP server**（Settings 可配置白名单目录 / 启用 / 重启 / 看运行状态）
- [x] **Agent tool-use loop**（OpenAI tool_calls + Hermes `<tool_call>` fallback）
- [x] **Tool-call UI**（消息里显示工具调用、参数、结果、状态）
- [x] `Message.content` 已升级为 `ContentPart[]`；settings schema 已 bump 到 v2
- [x] **Task boundary**：最新用户请求优先；旧失败请求不自动重试；filesystem 工具调用前做路径范围防护
- [x] **P2.2 可靠性打磨**：tool-call 错误分类、Stop 后运行中工具乐观标记 aborted、工具失败消息可重试
- [x] **P2.3 Active task context filtering**：发送给 LLM 时过滤旧失败 tool 调用，旧 tool role 不再原样进入后续请求
- [x] **P3 插件发现 / 启用**：扫描 `plugins/` + `user-plugins/`，读取 `.claude-plugin/plugin.json` + `.mcp.json`
- [x] **插件 MCP server 接入**：启用插件后，其 stdio MCP server 会合并进现有 MCP supervisor；Settings 里可刷新/启用/禁用插件
- [x] **P3.4 插件 skills 注入**：启用插件后，`skills/*/SKILL.md` 会在每次聊天时注入 agent system context（带单个/总量上限）
- [x] **P3.5 插件 commands**：启用插件后，`commands/*.md` 可从输入框 `/` 命令菜单插入并发送
- [x] **P3.6 插件校验增强**：manifest fatal errors 和 MCP/skill/command warnings 分离；unsupported MCP 不再让整个插件 invalid
- [x] **P3.7 命令体验增强**：输入 `/` 打开命令菜单；支持搜索、最近使用优先、参数占位符提示
- [x] **P3.8 插件能力详情**：Settings 里展示插件实际 MCP servers / skills / commands 列表和运行时 MCP 状态
- [x] **P3.9 权限透明**：启用插件前展示将获得的能力，例如 MCP 进程、cwd、env、skills/commands 注入
- [x] **P3.10 打包路径处理**：插件扫描支持 dev 项目目录，也支持 packaged app 的 resources/app/userData 路径
- [x] **P4.1 本地安装源**：Settings 可从本地文件夹导入插件到 `user-plugins`
- [x] **P4.2 Git/Zip 安装**：Settings 可从 zip 或 git URL 安装插件，安装前校验 manifest
- [x] **P4.3 更新/卸载**：用户插件可卸载；git 安装的插件支持 `git pull --ff-only` 更新
- [x] **P4.4 信任/安全策略**：插件记录来源 metadata，UI 展示 source/updateable，启用时展示权限确认
- [x] **P5.1 Command frontmatter/schema**：解析 command markdown frontmatter 的 `description` / `arguments`
- [x] **P5.2 参数表单**：选择 command 后显示参数表单，支持 `$ARGUMENTS` / `{{param}}` 渲染
- [x] **P5.3 命令执行记录**：用户消息保存 command invocation metadata（plugin、command、source、arguments）
- [x] **P5.4 命令历史 / 收藏**：命令菜单支持最近使用排序和收藏
- [x] **P6.1 Task ID**：每次用户发送生成 task id，并绑定 user / assistant placeholder / tool-call part
- [x] **P6.2 Tool-call task binding**：LLM stream 接收 active task id，renderer 只接收当前 task 的 part/update
- [x] **P6.3 Conversation compaction**：旧任务按摘要进入上下文，当前任务原样保留，减少旧请求污染
- [x] **P6.4 Command retry**：保存过 invocation 的用户命令消息支持一键“重跑命令”
- [x] **P7.1 Tool audit log**：工具调用落盘到 `%APPDATA%\Ava\tool-audit-log.json`，Settings 可查看/清空最近记录
- [x] **P7.2 插件运行时安全/权限细化**：插件 MCP `cwd` 不允许逃出插件目录；Settings 展示 command/args/cwd/env keys/runtime tools
- [x] **P7.3 UI 打磨 + SettingsView 拆分**：
  - aborted 消息 flash 动画 + 半透明减权
  - 重试/重跑命令按钮升级为 pill 样式（accent 背景圆角按钮）
  - ToolCallBubble running 状态脉冲动画 + aborted 删除线
  - 空 assistant 消息过滤（防止空气泡）
  - 侧边栏 active 对话左侧 accent 色条
  - SettingsView 从 1069 行拆为 10 个 settings/ 子模块
- [x] **P8.1 ava-core 内置插件**：
  - 6 个实用命令：code-explain / summarize / translate / rewrite / review / debug
  - 1 个 skill：response-style（回复风格指引）
  - bundled 插件默认启用（新安装开箱即用）
- [x] **P8.2 Production Build**：
  - electron-builder 集成（NSIS installer + portable）
  - `npm run pack` 打包到 `dist/win-unpacked/`
  - `npm run dist` 生成安装包
  - App icon 生成 + 放入 build/
  - plugins/ 作为 extraResources 打入安装包
  - electron 版本钉定为 41.3.0
- [x] **P8.3 Knowledge MCP**：
  - `packages/knowledge-mcp/` — TypeScript MCP server（TF-IDF 搜索引擎，CJK 分词）
  - `plugins/ava-knowledge/` — bundled 插件（stdio MCP server + `/search` 命令）
  - 4 个工具：`knowledge_search` / `knowledge_ingest` / `knowledge_list` / `knowledge_remove`
  - esbuild 打包为单文件 `server/index.cjs`，dev 和 prod 路径一致
  - 索引持久化到 `%APPDATA%/Ava/knowledge-index.json`
  - 支持 25+ 文件格式，自动跳过 node_modules/.git 等
- [x] **P8.4 Voice Integration (XiaoMo TTS/STT)**：
  - 独立 Python 服务器对接：WebSocket (STT, port 8000) 和 HTTP (TTS, port 8002)
  - Settings 新增 VoiceSection（配置 Server URLs，默认发音人，Auto-Read）
  - `audioRecorder.ts`：16kHz Web Audio API 下采样，发送 `Int16Array` 裸流
  - `voiceClient.ts`：管理 WebSocket STT 与 HTTP TTS (Blob 播放)
  - ChatInput 新增 Mic 图标，录音时显示脉冲动画并实时填入文本
  - MessageBubble 增加喇叭图标可重新播放 TTS，流式结束后支持 Auto-Read
- [x] **P9 Vision Integration (多模态视觉)**：
  - `ContentPart` 支持 `image_url`
  - OpenAI / Anthropic 协议完美兼容图片 Base64 传递
  - UI `PromptInput.tsx` 支持直接拖拽或粘贴本地图片
  - 图片预览/删除，并在 `MessageBubble` 渲染图片
- [x] **P10 E2E Testing (Playwright)**：
  - 集成了 `@playwright/test` 作为 Electron 自动化测试框架
  - 编写 `e2e/tests/app.spec.ts` 验证核心 UI 的加载与渲染
  - 使用隔离的测试数据目录，避免污染本地用户配置
- [x] **P11 Plugin Marketplace (插件市场)**：
  - 支持从远端静态 Catalog 读取可用插件（包含 Windows MCP 和 SQLite MCP 等演示）。
  - 支持直接在客户端一键 `git clone` 安装插件到 `user-plugins` 并自动热更新。
  - 新增 `MarketplaceSection` UI，显示安装进度与卸载功能。
- [x] **P12 HTTP/SSE MCP**（commit 跟 P13 打包，message 未单列）：
  - `mcpSupervisor` 接入 `@modelcontextprotocol/sdk/client/sse.js`，`config.transport === 'sse' || (!command && url)` 自动走 `SSEClientTransport`
  - 类型 `McpServerConfig` 加 `transport?: 'stdio'|'sse'` + `url?: string`
  - 复用原有生命周期：`onclose` / `onerror` / `connect` / 崩溃自动重启 全部继承 stdio 通路
  - Settings → MCP Servers 区新增「添加远程 SSE Server」表单（name + URL，例 `http://127.0.0.1:8000/sse`）
  - 非 builtin 条目（即用户自定义 SSE）显示 Delete 按钮；builtin 条目仍只能 toggle / 改 allowedDirs
  - 列表展示对 SSE 友好：`SSE Endpoint: <url>` 替代命令行
- [x] **P13 System Tray + Global Hotkey + Window Management**：
  - 系统托盘（显示 / 重启后端 / 退出）；关闭窗口默认最小化到托盘
  - 全局热键 `Alt+Space` 唤起 / 收起窗口
  - 透明窗口 + 自绘标题栏（titleBarOverlay），`webkitAppRegion: drag` 支持鼠标拖动
  - mcpSupervisor 增加重启稳定性修复（node.cmd ENOENT 等 Windows 路径问题）
- [x] **P14 Auto-Update Infrastructure**：
  - `electron-updater` 集成；启动后自动检查更新，可配置渠道（stable / beta）
  - Settings 新增 `AboutSection`：显示版本号 / 检查更新 / 下载进度 / 立即重启
  - GitHub Releases 作为分发源（`apps/shell/package.json` 配置 `publish.provider`）
- [x] **P15 Global File Drag-and-Drop**：
  - 整窗范围支持拖拽文件 → 进入 PromptInput 作为附件
  - 通用 attachment 抽象（图片走 `image_url`，其他文件 base64 + filename + mimeType 注入消息）
  - ChatView 显示拖拽 overlay；PromptInput 缩略附件 chip + 移除按钮
- [x] **多主题系统 UI Overhaul (Aura Glass / Nebula Clear)**：
  - 3 套主题：`aura-glass` / `cyber-zen` / `nebula-clear`，存到 `settings.theme`
  - 通过 `<html data-theme>` 切换 CSS 变量；Aura Glass 主题带浮动光球动画
  - Settings 新增 `AppearanceSection` 选择主题
  - Logo 组件抽出 + assets/ 资源目录；ChatHeader / ConversationSidebar / MessageBubble 全部按 token 重构
  - 透明背景 + backdrop-blur 玻璃感
- [x] **P16.1 Animation-only LLM run indicators**：
  - main process 发送 `ava:llm:status` lifecycle event
  - assistant placeholder 按 `connecting / waiting_first_token / generating / tool_running / fallback` 显示无文字动画
  - 完成 / 错误 / 中断时同步 `runPhase`，避免用户看不出 server 是否工作中
- [x] **P17 Chat Pipeline Refactor & Thinking UI**：
  - **架构固化**：Project Context (brief/folder) 和 Traits 注入逻辑从 `ChatView.tsx` 彻底移入 `chat.ts` 的 `conversationToLlmMessages`
  - **推理模型支持**：`reasoning_content` 全链路打通 (Adapter → IPC → Store)；新增 `ThinkingBlock` 组件，支持毫秒级计时与自动折叠
  - **Trait-Aware Prompts**：支持 `code / design / business / idea / video / mastery` 6 种模式，自动注入差异化 System Prompt 并调整 Temperature
  - **Trait-Aware Context Budget**：上下文预算按 session 类型动态调整：chat 6k、code 16k、design/business/video/idea/profile 8k、mastery 10k、intelligence/laboratory/forge 12k
  - **UI 增强**：工具调用气泡 (`CollapsibleToolCalls`) 增加计时器，与推理块统一视觉语言
- [x] **P17.0 Task Intake（任务理解确认）**：
  - coding / 文件修改 / 多步骤任务会先生成“理解确认”消息，用户回复「确认」或「开始」后才执行
  - 编辑上一条用户请求后也会重新走 Task Intake，避免直接生成代码
  - 确认后复用原始用户消息执行，不重复插入用户请求
  - 如果用户补充修正而不是确认，会取消 pending intake 并按新请求处理
- [x] **Context Window Indicator**：
  - 输入框右侧显示 Codex 风格 context percent 圆环
  - hover 显示 context window 百分比、used/budget tokens，以及自动压缩说明
  - 圆环和实际 compaction 使用同一套 trait-aware budget
- [x] **Session UX fixes**：
  - Session actions 的 Rename 改为顶部标题内联编辑，修复 popup 内 rename 不工作
  - 隐藏未实现菜单项：Open side chat / Fork / Add automation / Mini window
  - 会话类型变化不再自动移动，改为 title 旁显示 “Looks like X · Move” 建议，用户确认后才移动
  - 左侧栏恢复单组展开行为；窗口按钮 hover 区域对齐顶部栏高度
  - assistant 回复 hover 显示 copy 按钮，消息时间改为 hover 才显示
- [x] **Project file bootstrap**：
  - `ava:fs:readFile` 读取缺失的 `TASKS.md` 时自动创建默认任务清单，避免 ENOENT 打断项目状态同步
- [x] **P17.1 Built-in Agent Tools**：
  - 新增 Ava built-in tools，不依赖 MCP 即可完成基础 code-agent workflow
  - `shell.run_command`：受控执行 `npm / npx / pnpm / yarn / node / git / python / py / vite / tsc / powershell / pwsh`
  - `file.read_text / file.write_text / file.list_dir / file.create_dir / file.stat`：内置文件读写/目录/状态工具
  - 所有 built-in tools 限制在当前 project folder 或 filesystem allowed dirs 内
  - shell 工具只接受结构化 `command + args + cwd`，不接受自由 shell 字符串；带危险参数拦截、timeout、Stop abort
- [x] **P17.2 Coding failure handling**：
  - OpenAI-compatible stream 读取 `finish_reason`，识别 `length/max_tokens` 为 output limit
  - stream 没有 `[DONE]` 且无 finish reason 时标记 server disconnected
  - tool loop 超限标记为 `tool_loop_limit`
  - UI 不再把这些情况当成功完成，显示明确错误；Retry 会要求 Ava 从现有文件状态继续，不从头生成
  - Code/Design prompt 改为 file-first；初始化、安装、构建、测试时要求调用 `shell.run_command`，不能只写“我将执行”
- [x] **P17.3 Auto-continue + final report discipline**：
  - `output_limit / server_disconnected / tool_loop_limit` 后自动在同一个 assistant 回复内续跑，最多 3 轮
  - 自动续跑使用隐藏 system message，要求从当前文件状态继续，不重启、不重复已完成工作
  - 达到自动续跑上限才显示错误，并保留当前文件状态
  - coding/design 最终报告必须说明改动、验证结果、剩余风险；未验证/失败/中断时不能声称完成
- [x] **Built-in tools smoke test**：
  - 新增 `npm run test:builtins`，直接 smoke-test `builtInTools.ts`
  - 覆盖 `file.create_dir/read_text/write_text/list_dir/stat/patch`
  - 覆盖 `project.detect/project.validate/search.ripgrep/shell.run_command/git.status`
  - 修复 Windows `.cmd` shim 执行方式，避免 `spawn EINVAL`
  - 修复 `search.ripgrep` 非交互模式等待 stdin 的问题，显式搜索 `.`

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

## 文件地图（P0–P7 写入的全部代码）

### 主进程 `apps/shell/electron/`

| 文件 | 责任 |
|---|---|
| `main.ts` | 启动窗口；注册 IPC handler（ping / paths / settings / conversations / llm stream / llm abort / llm probe） |
| `preload.ts` | `contextBridge.exposeInMainWorld('ava', …)` 暴露 API |
| `storage.ts` | `loadSettings/saveSettings/loadConversations/saveConversations`，原子写（`.tmp` → `rename`） |
| `llm.ts` | Node 端 LLM 核心：管理 tool-use 循环、system prompt 注入（skills/commands/hermes/built-in tools）、调度 adapter。支持 abort、reasoning 回调、stopReason 分类 |
| `adapters/` | [NEW] LLM 适配器：`base.ts` (接口) / `openai.ts` (标准协议) / `anthropic.ts` (消息協議)。支持推理内容提取 |
| `services/pluginManager.ts` | P3/P4 插件管理：扫描、安装、卸载、解析 manifest/skills/commands |
| `services/mcpSupervisor.ts` | [NEW] MCP 客户端管理：启动 stdio/sse 进程、tool 执行、崩溃重启 |
| `services/toolAuditLog.ts` | P7 工具审计日志：记录 tool-call 参数、状态、结果预览 |
| `services/builtInTools.ts` | P17.1 内置 agent tools：`shell.run_command` + `file.*`，带 cwd/allowedDirs 安全边界、命令 allowlist、危险参数拦截、timeout/abort |
| `services/dwmCorners.ts` | [NEW] Win11 窗口美化：通过 DWM API 实现无边框透明窗口的原生圆角 |

### Renderer `apps/shell/src/`

| 文件 | 责任 |
|---|---|
| `App.tsx` | `StoreProvider` + 根据 `viewMode` 切 ChatView / SettingsView |
| `main.tsx` | React 入口 |
| `index.css` | Tailwind 4 `@theme inline` tokens + 滚动条 + `gradient-text` + `streaming-dot` + `abort-flash` + `tool-pulse` 动画 |
| `env.d.ts` | `window.ava: AvaApi`（从 preload 类型推导） |
| `types.ts` | `Message` / `Conversation` / `ModelProvider` / `Settings` / `ViewMode` / `DiscoveredPlugin` / `PluginCommand`；支持 reasoningContent |
| `store.tsx` | `useReducer` + Context。支持 APPEND_REASONING_DELTA |
| `lib/llm/providers.ts` | 10 家 provider 默认配置；`mergeModelProviders` / `normalizeProviderChain` / `getEnabledProviders` / `chatCompletionsEndpoint` / `modelsEndpoint` / `defaultSettings` |
| `lib/agent/chat.ts` | `sendChat`：核心 pipeline。Trait 识别、Token Budget、Project Context 注入、Temperature 调度 |
| `components/ChatView.tsx` | 消息列表 + 自动滚动 + 调度 sendChat。逻辑已简化，context 注入已移出 |
| `components/ChatHeader.tsx` | 顶部 bar：标题 / 删对话 / 新对话 / 进设置。高度 `h-11`，无自绘窗控（系统边框） |
| `components/MessageBubble.tsx` | 单条消息渲染。支持 ThinkingBlock + CollapsibleToolCalls 与实时计时 |
| `components/ToolCallBubble.tsx` | 工具调用卡片：running 脉冲、aborted 删除线、error 分类、参数/结果折叠 |
| `components/MarkdownContent.tsx` | react-markdown + remark-gfm + rehype-highlight |
| `components/ConversationSidebar.tsx` | 会话列表，按 updatedAt 倒序，active accent 色条，支持选中/重命名/删除 |
| `components/PromptInput.tsx` | textarea 自增高（max 220px）+ Enter 发送 / Shift+Enter 换行 + streaming 时切 StopCircle + `/` 命令面板。禁用态显示 reason |
| `components/EmptyState.tsx` | 首次进入：gradient "你好 {userName}" + 4 个快速 prompt chips |
| `components/SettingsView.tsx` | Layout shell（根据 `settingsSection` 切子模块） |
| `components/PreviewView.tsx` | [NEW] 设计预览画布：实时渲染 assistant 生成的 HTML/组件预览 |
| `components/settings/shared.tsx` | Toggle / LabeledInput / ModelChips 共用组件 |
| `components/settings/PersonaSection.tsx` | 用户 / 助手名字 |
| `components/settings/ChainSection.tsx` | 主回退链排序管理 |
| `components/settings/ProvidersSection.tsx` | Provider 配置 + 探测 |
| `components/settings/McpSection.tsx` | MCP Server 白名单 / 重启 |
| `components/settings/ToolAuditSection.tsx` | Tool audit log 查看 / 清空 |
| `components/settings/PluginsSection.tsx` | 插件列表 / 安装 / 卸载 / 更新 / 权限 |
| `components/settings/MarketplaceSection.tsx` | P11 插件市场：远端 catalog 浏览 / 一键安装 |
| `components/settings/VoiceSection.tsx` | P8.4 语音设置：STT/TTS server URL / 默认发音人 / Auto-Read |
| `components/settings/AboutSection.tsx` | P14：版本号 / 检查更新 / 下载进度 / 立即重启 |
| `components/settings/AppearanceSection.tsx` | P16 多主题选择 |
| `components/Logo.tsx` | UI overhaul：抽出 Logo 组件，被 ChatHeader 复用 |
| `assets/` | UI overhaul 静态资源（图标 / SVG） |

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
  activeTaskId?: string,
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
window.ava.llm.onStatus((payload: { streamId, taskId?, phase }) => void): () => void
window.ava.llm.onPart((payload: { streamId, taskId?, partIndex, part }) => void): () => void
window.ava.llm.onPartUpdate((payload: { streamId, taskId?, partIndex, partId?, patch }) => void): () => void
window.ava.mcp.listServers(): Promise<McpServerRuntime[]>
window.ava.mcp.restart(serverId): Promise<boolean>
window.ava.toolAudit.list(limit?: number): Promise<ToolAuditEntry[]>
window.ava.toolAudit.clear(): Promise<boolean>
window.ava.plugins.list(pluginStates): Promise<DiscoveredPlugin[]>
```

主进程对应的 IPC channel 名（全部在 `electron/main.ts` `registerIpc()` 里）：
`ava:ping` / `ava:paths:userData` / `ava:settings:load|save` / `ava:conversations:load|save` / `ava:llm:stream|abort|probe` / `ava:mcp:listServers|restart` / `ava:plugins:list` / `ava:llm:chunk|attempt`（后两个是 main→renderer）

---

## 关键决策（P1 过程中做的，跟 ARCHITECTURE.md 初版不完全一致）

| 决策 | 为什么 | 在哪实现 |
|---|---|---|
| **LLM fetch 在 main 不在 renderer** | 云厂商 CORS、自签证书、代理、任意 header 只能在 Node 里解决；API key 不落 renderer | `electron/llm.ts` |
| **OpenAI `/v1/chat/completions` 统一协议** | 绝大多数 provider 支持；简化 adapter | `electron/llm.ts` + `lib/llm/providers.ts` |
| **Anthropic adapter 已接** | 它只有 `/v1/messages`，header/参数名都不同；P1.5 补完 | `electron/llm.ts` `streamAnthropic` |
| **系统默认窗口边框** | P1 没多页面，自绘标题栏意义不大 | `electron/main.ts` |
| **lucide-react 图标** | 离线可用、TS 友好 | 全部 components |
| **沿用 MyPerson 色板** | 省时间、风格一致 | `src/index.css` |
| **P1 不做搜索**（Markdown + 会话列表 P1.5 补完） | 用户选择先保证流式 + 持久化跑通 | — |
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
3. **修 main/preload 代码不会热更**
   - 必须 `Ctrl+C` 重启 `npm run dev`
4. **PowerShell MCP 对 `git` / `npm` 命令会 timeout**（沙箱环境的问题，不是 Ava 的）
   - 用户在自己的 Windows 终端跑这些命令就没事
5. **Git 仓库初始化当前在 Windows 完成**（沙箱 `rm -rf .git` 权限拒绝过，不要在沙箱重置 `.git/`）
6. **P3 只接入插件内 stdio MCP server**
   - `.mcp.json` 里的 `http` / `sse` MCP server 会显示为 unsupported warning，暂不启动
   - skills 已注入 prompt；commands 已能从输入框菜单插入
7. **Task boundary 不是完整 planner**
   - 已防止典型“旧 D: 请求失败后又自动续跑”的问题
   - 当前路径防护主要覆盖 Windows 路径/scope；更复杂的语义级任务隔离需要后续 task id / compaction
8. **Abort 依赖 MCP server 配合**
   - UI 会在 Stop 后立即把运行中 tool-call 标成 aborted
   - 真实子进程/tool call 是否立刻停止，仍取决于 MCP server 和 SDK signal 支持

---

## 下一步 — 后续候选

主线 P1–P17.3 已落地。后续候选：

- **P16 Plugin Marketplace 远端 Catalog 完善**：现在的 catalog 是静态 JSON，缺签名 / 版本兼容性 / 评分。
- **Dev server tools**：`devserver.start / stop / status`，管理长期运行的 Vite/Next dev server，不用 `shell.run_command` 挂住。
- **Preview tools**：`preview.open / console / screenshot`，让 Ava 能打开页面、读取 console error、获得视觉反馈。
- **E2E 测试覆盖率扩展**：P10 只验证了核心 UI 加载；插件 / MCP / tool-call / auto-continue 流程缺自动化覆盖。
- **Auto-update GitHub Release 流水线**：P14 接好 SDK，但发布流程（签名 / changelog / staged rollout）还要梳理。

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
4. 动工前先读 `P2_PLAN.md`（如果 P2 还没完），跟用户确认一步步来
5. 动工前读相关源文件（不要凭记忆），动工后跑 `npm run typecheck --workspace=@ava/shell`
6. 改完让用户手动测（开发机 Windows；沙箱跑不了 Electron GUI）
7. 每次完成一个里程碑：更新 STATUS.md（至少 TL;DR + 新增文件/决策）
