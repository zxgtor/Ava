# Ava Architecture

_Last updated: 2026-04-23_
_Current phase: end of P1 (chat + LLM + persistence)_

> For current progress, pending work, and handoff info see **STATUS.md**.
> This file holds the long-term plan. Update it only when the plan changes.

## 定位

**Ava** = 极简 Electron 壳 + Cowork 格式插件运行时。从零写。

- 兼容 Cowork 插件格式（`.claude-plugin/plugin.json` + skills + MCP + commands + agents + hooks）
- 本地优先：支持本地 LLM（LM Studio / Ollama / vLLM / llama.cpp）+ 云 provider 回退
- 插件按需启用/禁用，禁用时真杀进程、真释放资源
- 所有"重 UI"功能（图谱、监控面板、设备、Voice Orb 等）放到独立 app 或 MCP 里，不在 Ava 主壳

## 实际结构（as of P1）

```
D:\Apps\Ava\
├── apps/
│   └── shell/                          Electron 主应用 (@ava/shell)
│       ├── electron/                   主进程 + preload
│       │   ├── main.ts                 窗口 + IPC 注册
│       │   ├── preload.ts              contextBridge → window.ava.*
│       │   ├── storage.ts              settings / conversations 原子写盘
│       │   └── llm.ts                  node 端 SSE 流式 fetch + fallback 链
│       └── src/
│           ├── App.tsx                 Store + view 切换
│           ├── main.tsx                React 入口
│           ├── index.css               Tailwind 4 + @theme tokens
│           ├── env.d.ts                window.ava 类型声明
│           ├── types.ts                Message / Conversation / Settings
│           ├── store.tsx               reducer + Context + 自动持久化
│           ├── components/
│           │   ├── ChatView.tsx
│           │   ├── ChatHeader.tsx
│           │   ├── MessageBubble.tsx
│           │   ├── PromptInput.tsx
│           │   ├── EmptyState.tsx
│           │   └── SettingsView.tsx
│           └── lib/
│               ├── llm/providers.ts    10 家 provider 默认 + chain 规范化
│               └── agent/chat.ts       对话发送粘合层
│
├── packages/
│   ├── ava-plugin-sdk/                 插件作者用的类型（P0 占位）
│   └── ava-mcp/                        MCP 客户端封装（P0 占位，P2 实装）
│
├── plugins/
│   └── ava-core/                       内置默认插件（P3 再填）
│
├── user-plugins/                       用户安装的插件（gitignored）
│
├── _reference/MyPerson/                只读参考，P4+ 迁完就移走
│
├── ARCHITECTURE.md                     长期方案（this file）
├── STATUS.md                           当前进度 / 交接（读这个先）
├── README.md
└── package.json                        npm workspaces
```

## 目标结构（P2+ 需要补的）

```
apps/shell/electron/
├── ipc/
│   ├── pluginIpc.ts        P3 — 插件启用/禁用/列表
│   ├── mcpIpc.ts           P2 — MCP 工具调用代理
│   └── settingsIpc.ts      P1 已经内联在 main.ts，可拆
└── services/
    ├── pluginManager.ts    P3 — 发现 / 解析 / 生命周期
    ├── mcpSupervisor.ts    P2 — spawn / kill MCP 子进程
    ├── mcpClient.ts        P2 — MCP 协议客户端
    ├── skillLoader.ts      P3 — 读 SKILL.md 注入上下文
    └── commandRegistry.ts  P5 — slash 命令

apps/shell/src/
└── views/
    ├── ChatView.tsx        P1 已做（在 components/，P1.5 可考虑搬）
    ├── SettingsView.tsx    P1 已做
    └── PluginManagerView.tsx   P3/P4 — 插件列表 + 装/卸
```

## Roadmap

| 阶段 | 目标 | 状态 | 说明 |
|---|---|---|---|
| **P0** | 脚手架：Electron 窗口、npm workspaces、Git 新库 | ✅ | 完成 2026-04-22 |
| **P1** | 聊天 + LLM：多 provider + fallback + 流式 + 持久化 | ✅ | 完成 2026-04-23 |
| P1.5 | 打磨：会话列表、Markdown、中断、重试、Anthropic adapter | ⏸ 待定 | 见 STATUS.md |
| P2 | MCP 客户端：主进程 spawn MCP 子进程、Agent 拿到 tools | ⏳ 下一步候选 | 3-5 天 |
| P3 | 插件运行时：发现 `user-plugins/*`、解析 plugin.json、启用/禁用真杀进程 | | 5-7 天 |
| P4 | 插件管理 UI + 市场：本地装 + Git URL 装 + marketplace.json 浏览 | | 5-7 天 |
| P5 | Command + Hook：slash 命令分发 | | 2-3 天 |
| P6+ | 生态实战：跑 anthropics/knowledge-work-plugins；写 Voice MCP、Knowledge MCP | | 持续 |

## 核心决策记录

### 运行时与技术栈
- **从零写**，不 fork MyPerson（学习目的）
- **Electron 41** + electron-vite 5 + React 19 + Vite + TypeScript 5.7 + Tailwind CSS 4
- **npm workspaces**：`apps/* / packages/* / plugins/*`
- **不迁到 Tauri**（保留与 MyPerson 的代码连续性，避免语言迁移成本）

### LLM 调用架构（P1）
- **所有 LLM HTTP 都在 main 进程里跑**，不在 renderer
  - 原因：云厂商（OpenAI / Anthropic / Groq 等）不给浏览器发 CORS 头；自签证书、企业代理、任意 header 只能在 Node 里解决；API key 不落在 renderer 更安全
  - renderer 只拿 Settings 传给 main，main 跑 fetch 后 `webContents.send` 推流回来
- **OpenAI Chat Completions 格式作为统一协议**：所有 provider 都走 `/v1/chat/completions`
  - 例外：**Anthropic 当前会炸**（它只有 `/v1/messages`）。adapter 在 P1.5 或 P2 加
- **fallback 链**：primaryModelChain 顺序试，失败才下一家，不做并行

### UI 决策（P1）
- **Electron 系统默认边框**（非自绘）—— P1 没有多页面，自绘标题栏意义不大
- **lucide-react 图标**（非 Material Symbols）—— 打包进 bundle，离线可用
- **Tailwind 4 `@theme inline`**：沿用 MyPerson 色板（`bg-bg` / `bg-surface` / `text-text-*` / `accent` / `gradient-1/2/3`）
- **P1 不做 Markdown 渲染、不做会话列表侧边栏、不做搜索**（列在 P1.5 待定）

### 插件格式
- **兼容 Cowork 插件格式**（beta 中，规范可能变）
- **用户插件路径**：`D:\Apps\Ava\user-plugins\`（项目内，gitignored）
  - 日后打包分发会挪到 `%APPDATA%\Ava\plugins\`
- **最小版本**：聊天 + 设置 + 插件管理，一个窗口，无插件窗口
- **不做**：自定义 Electron 窗口插件、复杂渲染端 UI 插件（放弃 MyPerson 的重 UI）

### 持久化
- **Electron `userData` 目录**（Windows 上是 `%APPDATA%\Ava\`）
- `settings.json` — 全部 Settings
- `conversations.json` — `{ conversations: [], activeConversationId }`
- 写盘策略：原子写（写 `.tmp` 再 rename），renderer 端写动作做 300-400ms debounce

## 从 MyPerson 保留的代码（P1 实际搬了）

- ✅ `src/lib/llm/providers.ts` — 多 provider 路由（去掉 AgentId 依赖）
- ✅ Tailwind 4 `@theme` 色板 tokens
- ✅ 组件骨架：ChatView / ChatHeader / MessageBubble / PromptInput / EmptyState / SettingsView（大幅简化）

## 从 MyPerson 丢弃的代码

- ❌ `src/lib/knowledge/`（整个目录）
- ❌ `src/lib/devices/`、`src/lib/abilities/`
- ❌ `electron/knowledgeIpc.ts`、`deviceIpc.ts`、`ingestionQueue.ts`、`wikiInbox.ts`、`wikiGraph.ts`
- ❌ 4 个独立窗口入口：TrayApp、VoiceWindowApp、KnowledgeStandaloneApp、DeviceStandaloneApp
- ❌ `packages/knowledge-core/`（除非以后包进 Knowledge MCP）
- ❌ MessageBubble 的工具调用渲染（~200 行）
- ❌ PromptInput 的语音 + Knowledge 导入
- ❌ `useAudioStream.ts` / `ttsQueue.ts` / `speechText.ts`
- ❌ `window.xiaomo.logLlmFallback`（已砍掉）

## 现有 Python 服务（stt / tts / graphify）

**不动**。未来包装成 MCP：
- **Voice MCP**：提供 `speech_to_text` / `text_to_speech` 工具，内部调 services/stt、services/tts
- **Knowledge MCP**：读写现有 `knowledge/` 数据，内部调 services/graphify

Voice Orb 悬浮窗 → 另做一个独立 app（不在 Ava 仓库）。
