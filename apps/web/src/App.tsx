import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Bot, Circle, Folder, Loader2, MessageSquarePlus, PlugZap, RefreshCw, UserRound, Wrench } from 'lucide-react'
import { AvaClient } from '@ava/client-sdk'
import type {
  AvaChatContentPart,
  AvaChatMessage,
  AvaChatStreamEvent,
  AvaDaemonChatRequest,
  AvaDaemonStatus,
} from '@ava/contracts'

type Role = 'user' | 'assistant' | 'system' | 'tool'
type RunStatus = 'idle' | 'running' | 'failed'

interface WebMessage {
  id: string
  role: Role
  content: AvaChatContentPart[]
  createdAt: number
  sendToModel?: boolean
}

interface WebConversation {
  id: string
  title: string
  messages: WebMessage[]
  traits?: string[]
  pinned?: boolean
  archived?: boolean
  folderPath?: string
  createdAt: number
  updatedAt: number
}

interface ConversationStore {
  conversations: WebConversation[]
  activeConversationId: string | null
  [key: string]: unknown
}

interface WebSettings {
  pluginStates?: Record<string, { enabled: boolean }>
  modelToolFormatMap?: Record<string, 'openai' | 'hermes' | 'none'>
  [key: string]: unknown
}

interface ToolPart {
  id?: string
  name?: string
  status?: string
  error?: string
  args?: unknown
  result?: unknown
}

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:17871'

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function nowIso() {
  return new Date().toISOString()
}

function textPart(text: string): AvaChatContentPart {
  return { type: 'text', text }
}

function contentText(parts: AvaChatContentPart[] | string): string {
  if (typeof parts === 'string') return parts
  return parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

function messageText(message: WebMessage): string {
  return contentText(message.content)
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function statusLabel(status?: AvaDaemonStatus | null, error?: string | null) {
  if (status?.ok) return 'Connected'
  if (error) return 'Offline'
  return 'Checking'
}

function updateToolPart(parts: ToolPart[], payload: Record<string, unknown>): ToolPart[] {
  const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch as Record<string, unknown> : {}
  return parts.map((part, index) => {
    const matches = payload.partId ? part.id === payload.partId : index === payload.partIndex
    return matches ? { ...part, ...patch } : part
  })
}

function compactJson(value: unknown) {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function sanitizeMessage(raw: unknown): WebMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const role = src.role === 'user' || src.role === 'assistant' || src.role === 'system' || src.role === 'tool'
    ? src.role
    : null
  if (!role) return null
  const content = Array.isArray(src.content)
    ? src.content.filter((part): part is AvaChatContentPart => Boolean(part && typeof part === 'object' && 'type' in part))
    : typeof src.content === 'string'
      ? [textPart(src.content)]
      : []
  return {
    id: typeof src.id === 'string' ? src.id : createId(role),
    role,
    content,
    createdAt: typeof src.createdAt === 'number' ? src.createdAt : Date.now(),
    sendToModel: src.sendToModel === false ? false : undefined,
  }
}

function sanitizeConversation(raw: unknown): WebConversation | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  if (typeof src.id !== 'string') return null
  const messages = Array.isArray(src.messages)
    ? src.messages.map(sanitizeMessage).filter((message): message is WebMessage => Boolean(message))
    : []
  return {
    id: src.id,
    title: typeof src.title === 'string' ? src.title : 'Untitled',
    messages,
    traits: Array.isArray(src.traits) ? src.traits.filter((item): item is string => typeof item === 'string') : undefined,
    pinned: Boolean(src.pinned),
    archived: Boolean(src.archived),
    folderPath: typeof src.folderPath === 'string' ? src.folderPath : undefined,
    createdAt: typeof src.createdAt === 'number' ? src.createdAt : Date.now(),
    updatedAt: typeof src.updatedAt === 'number' ? src.updatedAt : Date.now(),
  }
}

function createConversation(): WebConversation {
  const createdAt = Date.now()
  return {
    id: createId('web_conversation'),
    title: 'Ava Web Session',
    traits: ['chat'],
    createdAt,
    updatedAt: createdAt,
    messages: [{
      id: createId('assistant'),
      role: 'assistant',
      content: [textPart('Ava Web is connected through the daemon. Ask a question or request a local task.')],
      createdAt,
      sendToModel: false,
    }],
  }
}

function conversationToClientMessages(conversation: WebConversation): AvaChatMessage[] {
  return conversation.messages
    .filter(message => message.sendToModel !== false)
    .filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'system' || message.role === 'tool')
    .filter(message => message.content.length > 0)
    .map(message => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: new Date(message.createdAt).toISOString(),
    }))
}

export function App() {
  const [daemonUrl, setDaemonUrl] = useState(() => localStorage.getItem('ava-web-daemon-url') || DEFAULT_DAEMON_URL)
  const [status, setStatus] = useState<AvaDaemonStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [settings, setSettings] = useState<WebSettings>({})
  const [store, setStore] = useState<ConversationStore>(() => {
    const conversation = createConversation()
    return { conversations: [conversation], activeConversationId: conversation.id }
  })
  const [toolParts, setToolParts] = useState<ToolPart[]>([])
  const [input, setInput] = useState('')
  const [runStatus, setRunStatus] = useState<RunStatus>('idle')
  const [runError, setRunError] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const client = useMemo(() => new AvaClient({ baseUrl: daemonUrl }), [daemonUrl])

  const activeConversation = useMemo(
    () => store.conversations.find(conversation => conversation.id === store.activeConversationId) ?? store.conversations[0],
    [store],
  )

  const refreshStatus = async () => {
    localStorage.setItem('ava-web-daemon-url', daemonUrl)
    try {
      const next = await client.status()
      setStatus(next)
      setStatusError(null)
    } catch (error) {
      setStatus(null)
      setStatusError(error instanceof Error ? error.message : String(error))
    }
  }

  const hydrateFromDaemon = async () => {
    try {
      const [rawSettings, rawConversations] = await Promise.all([
        client.loadSettings<WebSettings | null>().catch(() => null),
        client.loadConversations<ConversationStore | null>().catch(() => null),
      ])
      setSettings(rawSettings ?? {})
      if (rawConversations && Array.isArray(rawConversations.conversations)) {
        const conversations = rawConversations.conversations
          .map(sanitizeConversation)
          .filter((conversation): conversation is WebConversation => Boolean(conversation))
        if (conversations.length > 0) {
          const activeConversationId = conversations.some(item => item.id === rawConversations.activeConversationId)
            ? rawConversations.activeConversationId
            : conversations[0].id
          setStore({ ...rawConversations, conversations, activeConversationId })
        }
      }
    } finally {
      setHydrated(true)
    }
  }

  useEffect(() => {
    void refreshStatus()
    void hydrateFromDaemon()
    const id = window.setInterval(() => void refreshStatus(), 3000)
    return () => window.clearInterval(id)
  }, [client])

  useEffect(() => {
    if (!hydrated) return
    const id = window.setTimeout(() => {
      void client.saveConversations({
        conversations: store.conversations,
        activeConversationId: store.activeConversationId,
      })
    }, 350)
    return () => window.clearTimeout(id)
  }, [client, hydrated, store])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [store, toolParts, runStatus])

  const patchConversation = (conversationId: string, updater: (conversation: WebConversation) => WebConversation) => {
    setStore(prev => ({
      ...prev,
      conversations: prev.conversations.map(conversation => (
        conversation.id === conversationId ? updater(conversation) : conversation
      )),
    }))
  }

  const createNewSession = () => {
    const conversation = createConversation()
    setToolParts([])
    setRunError(null)
    setStore(prev => ({
      ...prev,
      conversations: [conversation, ...prev.conversations],
      activeConversationId: conversation.id,
    }))
  }

  const sendMessage = async () => {
    const text = input.trim()
    const conversation = activeConversation
    if (!text || !conversation || runStatus === 'running') return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const userMessage: WebMessage = { id: createId('user'), role: 'user', content: [textPart(text)], createdAt: Date.now() }
    const assistantId = createId('assistant')
    const assistantMessage: WebMessage = { id: assistantId, role: 'assistant', content: [], createdAt: Date.now() }
    const runId = createId('web_run')
    let assistantText = ''

    setInput('')
    setRunError(null)
    setRunStatus('running')
    setToolParts([])
    patchConversation(conversation.id, current => ({
      ...current,
      title: current.messages.some(message => message.role === 'user') ? current.title : text.slice(0, 60),
      messages: [...current.messages, userMessage, assistantMessage],
      updatedAt: Date.now(),
    }))

    const conversationForRequest: WebConversation = {
      ...conversation,
      messages: [...conversation.messages, userMessage, assistantMessage],
      title: conversation.messages.some(message => message.role === 'user') ? conversation.title : text.slice(0, 60),
      updatedAt: Date.now(),
    }
    const projectBrief = conversation.folderPath
      ? await client.getProjectBrief<{ files: string[]; tasksDone: number; tasksTotal: number } | null>({ folderPath: conversation.folderPath }).catch(() => null)
      : null

    const request: AvaDaemonChatRequest = {
      runId,
      conversationId: conversation.id,
      messages: [],
      metadata: {
        clientContext: {
          conversation: {
            id: conversation.id,
            title: conversationForRequest.title,
            traits: conversation.traits,
            folderPath: conversation.folderPath,
            messages: conversationToClientMessages(conversationForRequest),
          },
          projectBrief: projectBrief ?? undefined,
          folderPath: conversation.folderPath,
        },
        streamOptions: {
          streamId: runId,
          conversationId: conversation.id,
          activeFolderPath: conversation.folderPath,
          taskAllowedDirs: conversation.folderPath ? [conversation.folderPath] : undefined,
          temperature: 0.2,
        },
        toolFormatMap: settings.modelToolFormatMap,
        pluginStates: settings.pluginStates,
      },
    }

    try {
      await client.streamChatEvents({
        request,
        signal: controller.signal,
        onEvent: (event: AvaChatStreamEvent) => {
          if (event.type === 'chat.message.delta') {
            assistantText += event.delta
          }
          if (event.type === 'chat.message.completed' && typeof event.message.content === 'string') {
            assistantText = event.message.content
          }
          if (event.type === 'chat.ipc.event') {
            const payload = event.payload as Record<string, unknown>
            if (event.channel === 'ava:llm:chunk' && payload.streamId === runId && typeof payload.text === 'string') {
              assistantText += payload.text
            }
            if (event.channel === 'ava:llm:part' && payload.streamId === runId) {
              const partIndex = typeof payload.partIndex === 'number' ? payload.partIndex : toolParts.length
              const part = payload.part as ToolPart
              setToolParts(prev => {
                const next = [...prev]
                next[partIndex] = part
                return next
              })
            }
            if (event.channel === 'ava:llm:partUpdate' && payload.streamId === runId) {
              setToolParts(prev => updateToolPart(prev, payload))
            }
          }
          if (event.type === 'chat.run.failed') {
            throw new Error(event.error)
          }
          patchConversation(conversation.id, current => ({
            ...current,
            messages: current.messages.map(message => (
              message.id === assistantId ? { ...message, content: [textPart(assistantText)] } : message
            )),
            updatedAt: Date.now(),
          }))
        },
      })
      patchConversation(conversation.id, current => ({
        ...current,
        messages: current.messages.map(message => (
          message.id === assistantId
            ? { ...message, content: [textPart(assistantText || 'No visible response returned.')] }
            : message
        )),
        updatedAt: Date.now(),
      }))
      setRunStatus('idle')
    } catch (error) {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      setRunError(message)
      setRunStatus('failed')
      patchConversation(conversation.id, current => ({
        ...current,
        messages: current.messages.map(item => (
          item.id === assistantId ? { ...item, content: [textPart(`Request failed: ${message}`)] } : item
        )),
        updatedAt: Date.now(),
      }))
    }
  }

  const stopRun = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunStatus('idle')
  }

  return (
    <div className="web-shell">
      <aside className="web-sidebar">
        <div className="brand">
          <div className={`brand-mark ${status?.ok ? 'online' : statusError ? 'offline' : 'checking'}`}>
            <span>{'{'}</span>
            <i />
            <span>{'}'}</span>
          </div>
          <div>
            <h1>Ava Web</h1>
            <p>Browser client for Ava daemon</p>
          </div>
        </div>

        <section className="status-card">
          <div className="status-title">
            <PlugZap size={16} />
            <span>Daemon</span>
            <em>{statusLabel(status, statusError)}</em>
          </div>
          <label>
            URL
            <input value={daemonUrl} onChange={event => setDaemonUrl(event.target.value)} />
          </label>
          <button onClick={refreshStatus}>
            <RefreshCw size={14} />
            Refresh
          </button>
          <dl>
            <div><dt>Runtime</dt><dd>{status?.runtimeAttached ? 'attached' : '-'}</dd></div>
            <div><dt>Conversations</dt><dd>{store.conversations.length}</dd></div>
            <div><dt>PID</dt><dd>{status?.pid ?? '-'}</dd></div>
          </dl>
          {statusError && <p className="status-error">{statusError}</p>}
        </section>

        <section className="session-card">
          <div className="session-title">
            <span>Sessions</span>
            <button type="button" onClick={createNewSession}><MessageSquarePlus size={14} /></button>
          </div>
          <div className="session-list">
            {store.conversations.map(conversation => (
              <button
                key={conversation.id}
                type="button"
                className={conversation.id === activeConversation?.id ? 'active' : ''}
                onClick={() => setStore(prev => ({ ...prev, activeConversationId: conversation.id }))}
              >
                <span>{conversation.title || 'Untitled'}</span>
                {conversation.folderPath && <Folder size={12} />}
              </button>
            ))}
          </div>
        </section>
      </aside>

      <main className="chat-main">
        <header className="chat-header">
          <div>
            <h2>{activeConversation?.title ?? 'Chat Workspace'}</h2>
            <p>Daemon context mode · <code>{daemonUrl}</code></p>
          </div>
          <span className={`run-pill ${runStatus}`}>
            {runStatus === 'running' ? <Loader2 size={14} className="spin" /> : <Circle size={10} />}
            {runStatus}
          </span>
        </header>

        <div className="message-list" ref={scrollRef}>
          {(activeConversation?.messages ?? []).map(message => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="avatar">{message.role === 'user' ? <UserRound size={16} /> : <Bot size={16} />}</div>
              <div className="bubble">
                <div className="message-meta">
                  <strong>{message.role === 'user' ? 'You' : 'Ava'}</strong>
                  <span>{formatTime(message.createdAt)}</span>
                </div>
                <p>{messageText(message) || (message.role === 'assistant' && runStatus === 'running' ? 'Thinking...' : '')}</p>
              </div>
            </article>
          ))}

          {toolParts.length > 0 && (
            <section className="tool-panel">
              <h3><Wrench size={14} /> Tool Activity</h3>
              {toolParts.map((part, index) => (
                <details key={part.id ?? index} open={part.status === 'running' || part.status === 'error'}>
                  <summary>
                    <span>{part.name ?? 'tool'}</span>
                    <em className={part.status ?? 'running'}>{part.status ?? 'running'}</em>
                  </summary>
                  {part.error && <pre>{part.error}</pre>}
                  {part.args !== undefined && <pre>{compactJson(part.args)}</pre>}
                  {part.result !== undefined && <pre>{compactJson(part.result)}</pre>}
                </details>
              ))}
            </section>
          )}
        </div>

        {runError && <div className="error-line">{runError}</div>}

        <form
          className="composer"
          onSubmit={event => {
            event.preventDefault()
            void sendMessage()
          }}
        >
          <textarea
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void sendMessage()
              }
            }}
            placeholder="Ask Ava..."
          />
          {runStatus === 'running' ? (
            <button type="button" className="stop" onClick={stopRun}>Stop</button>
          ) : (
            <button type="submit" disabled={!input.trim() || !status?.ok}>
              <ArrowUp size={17} />
            </button>
          )}
        </form>
      </main>
    </div>
  )
}
