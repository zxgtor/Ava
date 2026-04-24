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
import type {
  Conversation,
  Message,
  Settings,
  ViewMode,
} from './types'
import {
  defaultSettings,
  mergeModelProviders,
  normalizeProviderChain,
} from './lib/llm/providers'

// ── State shape ─────────────────────────────────────────────────────

interface AppState {
  conversations: Conversation[]
  activeConversationId: string | null
  settings: Settings
  viewMode: ViewMode
  sidebarOpen: boolean
  hydrated: boolean
}

type Action =
  | { type: 'HYDRATE'; conversations: Conversation[]; settings: Settings; activeId: string | null }
  | { type: 'SET_VIEW'; view: ViewMode }
  | { type: 'SET_SIDEBAR'; open: boolean }
  | { type: 'CREATE_CONVERSATION'; conversation: Conversation }
  | { type: 'SELECT_CONVERSATION'; id: string }
  | { type: 'DELETE_CONVERSATION'; id: string }
  | { type: 'RENAME_CONVERSATION'; id: string; title: string }
  | { type: 'ADD_MESSAGE'; conversationId: string; message: Message }
  | { type: 'UPDATE_MESSAGE'; conversationId: string; messageId: string; patch: Partial<Message> }
  | { type: 'APPEND_DELTA'; conversationId: string; messageId: string; delta: string }
  | { type: 'DELETE_MESSAGE'; conversationId: string; messageId: string }
  | { type: 'UPDATE_SETTINGS'; settings: Settings }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'HYDRATE':
      return {
        ...state,
        conversations: action.conversations,
        settings: action.settings,
        activeConversationId: action.activeId,
        hydrated: true,
      }

    case 'SET_VIEW':
      return { ...state, viewMode: action.view }

    case 'SET_SIDEBAR':
      return { ...state, sidebarOpen: action.open }

    case 'CREATE_CONVERSATION':
      return {
        ...state,
        conversations: [action.conversation, ...state.conversations],
        activeConversationId: action.conversation.id,
      }

    case 'SELECT_CONVERSATION':
      return { ...state, activeConversationId: action.id }

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

    case 'APPEND_DELTA':
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
                    ? { ...m, content: m.content + action.delta }
                    : m,
                ),
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

    case 'UPDATE_SETTINGS':
      return { ...state, settings: action.settings }

    default:
      return state
  }
}

function initialState(): AppState {
  return {
    conversations: [],
    activeConversationId: null,
    settings: defaultSettings(),
    viewMode: 'chat',
    sidebarOpen: true,
    hydrated: false,
  }
}

// ── Hydration helpers ───────────────────────────────────────────────

interface PersistedConversations {
  conversations: Conversation[]
  activeConversationId: string | null
}

function sanitizeSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return defaultSettings()
  const src = raw as Partial<Settings>
  const merged = defaultSettings()
  const providers = mergeModelProviders(src.modelProviders ?? null)
  return {
    version: 1,
    modelProviders: providers,
    primaryModelChain: normalizeProviderChain(src.primaryModelChain ?? null, providers),
    persona: {
      userName: src.persona?.userName ?? merged.persona.userName,
      assistantName: src.persona?.assistantName ?? merged.persona.assistantName,
    },
  }
}

function sanitizeConversations(raw: unknown): PersistedConversations {
  if (!raw || typeof raw !== 'object') {
    return { conversations: [], activeConversationId: null }
  }
  const src = raw as Partial<PersistedConversations>
  const conversations = Array.isArray(src.conversations)
    ? src.conversations.filter(c => c && typeof c.id === 'string')
    : []
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
        const settings = sanitizeSettings(rawSettings)
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

  const activeConversation = useMemo(
    () => state.conversations.find(c => c.id === state.activeConversationId) ?? null,
    [state.conversations, state.activeConversationId],
  )

  const createConversation = useCallback((): Conversation => {
    const now = Date.now()
    const convo: Conversation = {
      id: `c_${now}_${Math.random().toString(36).slice(2, 8)}`,
      title: '新对话',
      messages: [],
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
