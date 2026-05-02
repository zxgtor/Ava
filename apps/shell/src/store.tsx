import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  CommandInvocation,
  ContentPart,
  Conversation,
  InitiativeTrait,
  Message,
  ProjectBrief,
  AssistantRunPhase,
  Settings,
  ToolCallStatus,
  ViewMode,
} from './types'
import {
  defaultSettings,
  mergeMcpServers,
  mergeModelProviders,
  normalizeProviderChain,
} from './lib/llm/providers'

// ── State shape ─────────────────────────────────────────────────────

interface AppState {
  conversations: Conversation[]
  activeConversationId: string | null
  settings: Settings
  settingsSection: string
  viewMode: ViewMode
  sidebarOpen: boolean
  projectBriefs: Record<string, ProjectBrief>
  hydrated: boolean
}

type Action =
  | { type: 'HYDRATE'; conversations: Conversation[]; settings: Settings; activeId: string | null }
  | { type: 'SET_VIEW'; view: ViewMode }
  | { type: 'SET_SETTINGS_SECTION'; section: string }
  | { type: 'SET_SIDEBAR'; open: boolean }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'CREATE_CONVERSATION'; conversation: Conversation }
  | { type: 'SELECT_CONVERSATION'; id: string }
  | { type: 'CLEAR_ACTIVE_CONVERSATION' }
  | { type: 'DELETE_CONVERSATION'; id: string }
  | { type: 'RENAME_CONVERSATION'; id: string; title: string }
  | { type: 'SET_TRAITS'; id: string; traits: InitiativeTrait[] }
  | { type: 'TOGGLE_PIN_CONVERSATION'; id: string }
  | { type: 'ARCHIVE_CONVERSATION'; id: string; archived?: boolean }
  | { type: 'SET_CONVERSATION_FOLDER'; id: string; path: string }
  | { type: 'ADD_MESSAGE'; conversationId: string; message: Message }
  | { type: 'UPDATE_MESSAGE'; conversationId: string; messageId: string; patch: Partial<Message> }
  | { type: 'ADD_PART'; conversationId: string; messageId: string; part: ContentPart }
  | { type: 'UPDATE_PART'; conversationId: string; messageId: string; partIndex: number; partId?: string; patch: Partial<Extract<ContentPart, { type: 'tool_call' }>> }
  | { type: 'ABORT_RUNNING_PARTS'; conversationId: string; messageId: string }
  | { type: 'APPEND_DELTA'; conversationId: string; messageId: string; delta: string }
  | { type: 'DELETE_MESSAGE'; conversationId: string; messageId: string }
  | { type: 'REPLACE_MESSAGES_FROM'; conversationId: string; fromMessageId: string; messages: Message[] }
  | { type: 'UPDATE_SETTINGS'; settings: Settings }
  | { type: 'SET_PROJECT_BRIEF'; conversationId: string; brief: ProjectBrief | null }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'HYDRATE':
      return {
        ...state,
        conversations: action.conversations,
        settings: action.settings,
        activeConversationId: action.activeId,
        projectBriefs: {},
        hydrated: true,
      }

    case 'SET_VIEW':
      return { ...state, viewMode: action.view }

    case 'SET_SETTINGS_SECTION':
      return { ...state, settingsSection: action.section }

    case 'SET_SIDEBAR':
      return { ...state, sidebarOpen: action.open }

    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarOpen: !state.sidebarOpen }

    case 'CREATE_CONVERSATION':
      return {
        ...state,
        conversations: [action.conversation, ...state.conversations],
        activeConversationId: action.conversation.id,
      }

    case 'SELECT_CONVERSATION':
      return { ...state, activeConversationId: action.id }

    case 'CLEAR_ACTIVE_CONVERSATION':
      return { ...state, activeConversationId: null }

    case 'DELETE_CONVERSATION': {
      const remaining = state.conversations.filter(c => c.id !== action.id)
      const activeId =
        state.activeConversationId === action.id
          ? remaining[0]?.id ?? null
          : state.activeConversationId
      return { ...state, conversations: remaining, activeConversationId: activeId }
    }

    case 'RENAME_CONVERSATION':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id === action.id ? { ...c, title: action.title, updatedAt: Date.now() } : c,
        ),
      }

    case 'SET_TRAITS':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id === action.id ? { ...c, traits: action.traits, updatedAt: Date.now() } : c,
        ),
      }

    case 'TOGGLE_PIN_CONVERSATION':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id === action.id ? { ...c, pinned: !c.pinned, updatedAt: Date.now() } : c,
        ),
      }

    case 'ARCHIVE_CONVERSATION':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id === action.id ? { ...c, archived: action.archived ?? true, updatedAt: Date.now() } : c,
        ),
      }

    case 'SET_CONVERSATION_FOLDER':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id === action.id ? { ...c, folderPath: action.path, updatedAt: Date.now() } : c,
        ),
      }

    case 'ADD_MESSAGE':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id === action.conversationId
            ? { ...c, messages: [...c.messages, action.message], updatedAt: Date.now() }
            : c,
        ),
      }

    case 'UPDATE_MESSAGE':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id !== action.conversationId
            ? c
            : {
                ...c,
                updatedAt: Date.now(),
                messages: c.messages.map(m =>
                  m.id === action.messageId ? { ...m, ...action.patch } : m,
                ),
              },
        ),
      }

    case 'ADD_PART':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id !== action.conversationId
            ? c
            : {
                ...c,
                updatedAt: Date.now(),
                messages: c.messages.map(m =>
                  m.id === action.messageId
                    ? { ...m, content: [...m.content, action.part] }
                    : m,
                ),
              },
        ),
      }

    case 'UPDATE_PART':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id !== action.conversationId
            ? c
            : {
                ...c,
                updatedAt: Date.now(),
                messages: c.messages.map(m => {
                  if (m.id !== action.messageId) return m
                  const nextContent = m.content.map((part, idx) => {
                    const isTarget = action.partId
                      ? part.type === 'tool_call' && part.id === action.partId
                      : idx === action.partIndex
                    if (!isTarget || part.type !== 'tool_call') return part
                    return { ...part, ...action.patch }
                  })
                  return { ...m, content: nextContent }
                }),
              },
        ),
      }

    case 'ABORT_RUNNING_PARTS':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id !== action.conversationId
            ? c
            : {
                ...c,
                updatedAt: Date.now(),
                messages: c.messages.map(m => {
                  if (m.id !== action.messageId) return m
                  return {
                    ...m,
                    content: m.content.map(part =>
                      part.type === 'tool_call' && (part.status === 'running' || part.status === 'pending')
                        ? { ...part, status: 'aborted', endedAt: Date.now(), error: part.error ?? 'aborted by user' }
                        : part,
                    ),
                  }
                }),
              },
        ),
      }

    case 'APPEND_DELTA':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id !== action.conversationId
            ? c
            : {
                ...c,
                updatedAt: Date.now(),
                messages: c.messages.map(m => {
                  if (m.id !== action.messageId) return m
                  // Append to the trailing text part if any; otherwise push a
                  // new text part. Tool-call parts in the middle of a message
                  // are preserved — only the most recent text run is extended.
                  const last = m.content[m.content.length - 1]
                  if (last && last.type === 'text') {
                    const updated: ContentPart[] = [
                      ...m.content.slice(0, -1),
                      { type: 'text', text: last.text + action.delta },
                    ]
                    return { ...m, content: updated }
                  }
                  return {
                    ...m,
                    content: [...m.content, { type: 'text', text: action.delta }],
                  }
                }),
              },
        ),
      }

    case 'DELETE_MESSAGE':
      return {
        ...state,
        conversations: state.conversations.map(c =>
          c.id !== action.conversationId
            ? c
            : {
                ...c,
                updatedAt: Date.now(),
                messages: c.messages.filter(m => m.id !== action.messageId),
              },
        ),
      }

    case 'REPLACE_MESSAGES_FROM':
      return {
        ...state,
        conversations: state.conversations.map(c => {
          if (c.id !== action.conversationId) return c
          const idx = c.messages.findIndex(m => m.id === action.fromMessageId)
          if (idx < 0) {
            return { ...c, updatedAt: Date.now(), messages: [...c.messages, ...action.messages] }
          }
          return {
            ...c,
            updatedAt: Date.now(),
            messages: [...c.messages.slice(0, idx), ...action.messages],
          }
        }),
      }

    case 'UPDATE_SETTINGS':
      return { ...state, settings: action.settings }

    case 'SET_PROJECT_BRIEF': {
      const nextBriefs = { ...state.projectBriefs }
      if (action.brief) {
        nextBriefs[action.conversationId] = action.brief
      } else {
        delete nextBriefs[action.conversationId]
      }
      return { ...state, projectBriefs: nextBriefs }
    }

    default:
      return state
  }
}

function initialState(): AppState {
  return {
    conversations: [],
    activeConversationId: null,
    settings: defaultSettings(),
    settingsSection: 'persona',
    viewMode: 'chat',
    sidebarOpen: true,
    projectBriefs: {},
    hydrated: false,
  }
}

// ── Hydration helpers ───────────────────────────────────────────────

interface PersistedConversations {
  conversations: Conversation[]
  activeConversationId: string | null
}

/**
 * Schema v2 strict sanitizer.
 * Returns `null` when the payload is not v2 — callers should reset both
 * settings and conversations in that case (no v1→v2 migration by design;
 * decision made with Jason at the start of P2).
 */
function sanitizeSettingsStrict(raw: unknown): Settings | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Partial<Settings> & { version?: unknown }
  if (src.version !== 2) return null

  const merged = defaultSettings()
  const providers = mergeModelProviders(src.modelProviders ?? null)
  const mcpServers = mergeMcpServers(src.mcpServers ?? null)
  const toolFormatMap: Settings['modelToolFormatMap'] = {}
  if (src.modelToolFormatMap && typeof src.modelToolFormatMap === 'object') {
    for (const [k, v] of Object.entries(src.modelToolFormatMap)) {
      if (v === 'openai' || v === 'hermes' || v === 'none') {
        toolFormatMap[k] = v
      }
    }
  }
  const pluginStates: Settings['pluginStates'] = {}
  if (src.pluginStates && typeof src.pluginStates === 'object') {
    for (const [id, state] of Object.entries(src.pluginStates)) {
      if (!id.trim() || !state || typeof state !== 'object') continue
      pluginStates[id] = { enabled: Boolean((state as { enabled?: unknown }).enabled) }
    }
  }

  return {
    version: 2,
    modelProviders: providers,
    primaryModelChain: normalizeProviderChain(src.primaryModelChain ?? null, providers),
    persona: {
      userName: src.persona?.userName ?? merged.persona.userName,
      assistantName: src.persona?.assistantName ?? merged.persona.assistantName,
    },
    mcpServers,
    pluginStates,
    modelToolFormatMap: toolFormatMap,
    voice: {
      enabled: typeof src.voice?.enabled === 'boolean' ? src.voice.enabled : merged.voice.enabled,
      sttServerUrl: typeof src.voice?.sttServerUrl === 'string' ? src.voice.sttServerUrl : merged.voice.sttServerUrl,
      ttsServerUrl: typeof src.voice?.ttsServerUrl === 'string' ? src.voice.ttsServerUrl : merged.voice.ttsServerUrl,
      voiceId: typeof src.voice?.voiceId === 'string' ? src.voice.voiceId : merged.voice.voiceId,
      autoRead: typeof src.voice?.autoRead === 'boolean' ? src.voice.autoRead : merged.voice.autoRead,
    },
    theme:
      src.theme === 'aura-glass' || src.theme === 'cyber-zen' ||
      src.theme === 'nebula-clear'
        ? src.theme
        : merged.theme,
    language:
      src.language === 'en-US' || src.language === 'zh-CN' || src.language === 'auto'
        ? src.language
        : merged.language,
  }
}

function sanitizeContentPart(raw: unknown): ContentPart | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as { type?: unknown } & Record<string, unknown>
  if (p.type === 'text') {
    return typeof p.text === 'string' ? { type: 'text', text: p.text } : null
  }
  if (p.type === 'tool_call') {
    if (typeof p.id !== 'string' || typeof p.name !== 'string') return null
    const status: ToolCallStatus =
      p.status === 'pending' || p.status === 'running' ||
      p.status === 'ok' || p.status === 'error' || p.status === 'aborted'
        ? p.status
        : 'ok'
    return {
      type: 'tool_call',
      taskId: typeof p.taskId === 'string' ? p.taskId : undefined,
      id: p.id,
      name: p.name,
      args: p.args && typeof p.args === 'object' ? p.args as Record<string, unknown> : {},
      status,
      result: p.result,
      error: typeof p.error === 'string' ? p.error : undefined,
      startedAt: typeof p.startedAt === 'number' ? p.startedAt : undefined,
      endedAt: typeof p.endedAt === 'number' ? p.endedAt : undefined,
    }
  }
  if (p.type === 'image_url') {
    const inner = p.image_url as Record<string, unknown>
    if (inner && typeof inner.url === 'string') {
      return { type: 'image_url', image_url: { url: inner.url } }
    }
  }
  return null
}

function sanitizeMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Partial<Message> & Record<string, unknown>
  if (typeof m.id !== 'string') return null
  if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system' && m.role !== 'tool') return null
  if (!Array.isArray(m.content)) return null

  const content: ContentPart[] = []
  for (const part of m.content) {
    const sanitized = sanitizeContentPart(part)
    if (!sanitized) return null // drop entire message on any invalid part
    content.push(sanitized)
  }

  return {
    id: m.id,
    taskId: typeof m.taskId === 'string' ? m.taskId : undefined,
    role: m.role,
    content,
    toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : undefined,
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now(),
    streaming: m.streaming ? true : undefined,
    runPhase: sanitizeRunPhase(m.runPhase),
    error: typeof m.error === 'string' ? m.error : undefined,
    aborted: m.aborted ? true : undefined,
    commandInvocation: sanitizeCommandInvocation(m.commandInvocation),
  }
}

function sanitizeRunPhase(raw: unknown): AssistantRunPhase | undefined {
  return raw === 'connecting' ||
    raw === 'waiting_first_token' ||
    raw === 'generating' ||
    raw === 'tool_running' ||
    raw === 'fallback' ||
    raw === 'completed' ||
    raw === 'error' ||
    raw === 'aborted'
    ? raw
    : undefined
}

function sanitizeCommandInvocation(raw: unknown): CommandInvocation | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as Partial<CommandInvocation> & Record<string, unknown>
  if (
    typeof src.pluginId !== 'string' ||
    typeof src.pluginName !== 'string' ||
    typeof src.commandName !== 'string' ||
    typeof src.sourcePath !== 'string'
  ) return undefined
  const args: Record<string, string> = {}
  if (src.arguments && typeof src.arguments === 'object') {
    for (const [key, value] of Object.entries(src.arguments)) {
      if (typeof value === 'string') args[key] = value
    }
  }
  return {
    pluginId: src.pluginId,
    pluginName: src.pluginName,
    commandName: src.commandName,
    sourcePath: src.sourcePath,
    arguments: args,
  }
}

function sanitizeConversation(raw: unknown): Conversation | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Partial<Conversation> & Record<string, unknown>
  if (typeof c.id !== 'string' || typeof c.title !== 'string') return null
  if (!Array.isArray(c.messages)) return null
  const messages: Message[] = []
  for (const m of c.messages) {
    const sanitized = sanitizeMessage(m)
    if (!sanitized) return null // strict: drop whole conversation on any bad msg
    messages.push(sanitized)
  }

  // Sanitize traits
  const traits: InitiativeTrait[] = []
  if (Array.isArray(c.traits)) {
    const valid: InitiativeTrait[] = [
      'chat', 'video', 'code', 'business', 'mastery', 
      'intelligence', 'profile', 'laboratory', 'forge', 'idea'
    ]
    for (const t of c.traits) {
      if (valid.includes(t)) traits.push(t as InitiativeTrait)
    }
  }

  return {
    id: c.id,
    title: c.title,
    messages,
    traits: traits.length > 0 ? traits : ['chat'],
    pinned: Boolean(c.pinned),
    archived: Boolean(c.archived),
    folderPath: typeof c.folderPath === 'string' ? c.folderPath : undefined,
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
    updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
  }
}

function sanitizeConversations(raw: unknown): PersistedConversations {
  if (!raw || typeof raw !== 'object') {
    return { conversations: [], activeConversationId: null }
  }
  const src = raw as Partial<PersistedConversations>
  const conversations: Conversation[] = []
  if (Array.isArray(src.conversations)) {
    for (const c of src.conversations) {
      const sanitized = sanitizeConversation(c)
      if (sanitized) conversations.push(sanitized)
    }
  }
  return {
    conversations,
    activeConversationId: typeof src.activeConversationId === 'string' ? src.activeConversationId : null,
  }
}

// ── Context ─────────────────────────────────────────────────────────

interface StoreContextValue {
  state: AppState
  dispatch: React.Dispatch<Action>
  activeConversation: Conversation | null
  createConversation: () => Conversation
}

const StoreContext = createContext<StoreContextValue | null>(null)

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}

// ── Provider ────────────────────────────────────────────────────────

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)

  // Hydrate from disk on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [rawSettings, rawConvs] = await Promise.all([
          window.ava.settings.load(),
          window.ava.conversations.load(),
        ])
        const settings = sanitizeSettingsStrict(rawSettings)
        if (!settings) {
          // Settings not at v2 — breaking schema change: drop everything.
          console.info('[store] settings schema not v2; resetting settings + conversations')
          if (!cancelled) {
            dispatch({
              type: 'HYDRATE',
              conversations: [],
              settings: defaultSettings(),
              activeId: null,
            })
          }
          return
        }
        const { conversations, activeConversationId } = sanitizeConversations(rawConvs)
        const activeId = conversations.some(c => c.id === activeConversationId)
          ? activeConversationId
          : conversations[0]?.id ?? null
        if (!cancelled) {
          dispatch({ type: 'HYDRATE', conversations, settings, activeId })
        }
      } catch (err) {
        console.warn('[store] hydration failed:', err)
        if (!cancelled) {
          dispatch({ type: 'HYDRATE', conversations: [], settings: defaultSettings(), activeId: null })
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Persist settings (debounced)
  const settingsTimer = useRef<number | null>(null)
  useEffect(() => {
    if (!state.hydrated) return
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current)
    settingsTimer.current = window.setTimeout(() => {
      window.ava.settings.save(state.settings).catch(err => console.warn('[store] save settings:', err))
    }, 300)
  }, [state.hydrated, state.settings])

  // Persist conversations (debounced)
  const convsTimer = useRef<number | null>(null)
  useEffect(() => {
    if (!state.hydrated) return
    if (convsTimer.current) window.clearTimeout(convsTimer.current)
    convsTimer.current = window.setTimeout(() => {
      window.ava.conversations.save({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
      }).catch(err => console.warn('[store] save conversations:', err))
    }, 400)
  }, [state.hydrated, state.conversations, state.activeConversationId])

  const { t } = useTranslation()

  const activeConversation = useMemo(
    () => state.conversations.find(c => c.id === state.activeConversationId) ?? null,
    [state.conversations, state.activeConversationId],
  )

  const createConversation = useCallback((): Conversation => {
    const now = Date.now()
    const convo: Conversation = {
      id: `c_${now}_${Math.random().toString(36).slice(2, 8)}`,
      title: t('sidebar.new_chat', 'New session'),
      messages: [],
      traits: ['chat'],
      createdAt: now,
      updatedAt: now,
    }
    dispatch({ type: 'CREATE_CONVERSATION', conversation: convo })
    return convo
  }, [])

  const value = useMemo<StoreContextValue>(
    () => ({ state, dispatch, activeConversation, createConversation }),
    [state, activeConversation, createConversation],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}
