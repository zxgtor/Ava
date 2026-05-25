import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Bot, Circle, Loader2, PlugZap, RefreshCw, UserRound, Wrench } from 'lucide-react'
import { AvaClient } from '@ava/client-sdk'
import type { AvaChatStreamEvent, AvaDaemonChatRequest, AvaDaemonStatus } from '@ava/contracts'

type Role = 'user' | 'assistant'
type RunStatus = 'idle' | 'running' | 'failed'

interface ChatMessage {
  id: string
  role: Role
  content: string
  createdAt: number
  sendToModel?: boolean
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

export function App() {
  const [daemonUrl, setDaemonUrl] = useState(() => localStorage.getItem('ava-web-daemon-url') || DEFAULT_DAEMON_URL)
  const [status, setStatus] = useState<AvaDaemonStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: createId('assistant'),
      role: 'assistant',
      content: 'Ava Web is connected through the daemon. Ask a question or request a local task.',
      createdAt: Date.now(),
      sendToModel: false,
    },
  ])
  const [toolParts, setToolParts] = useState<ToolPart[]>([])
  const [input, setInput] = useState('')
  const [runStatus, setRunStatus] = useState<RunStatus>('idle')
  const [runError, setRunError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const client = useMemo(() => new AvaClient({ baseUrl: daemonUrl }), [daemonUrl])

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

  useEffect(() => {
    void refreshStatus()
    const id = window.setInterval(() => void refreshStatus(), 3000)
    return () => window.clearInterval(id)
  }, [client])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, toolParts, runStatus])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || runStatus === 'running') return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const userMessage: ChatMessage = { id: createId('user'), role: 'user', content: text, createdAt: Date.now() }
    const assistantId = createId('assistant')
    const runId = createId('web_run')
    let assistantText = ''

    setInput('')
    setRunError(null)
    setRunStatus('running')
    setToolParts([])
    setMessages(prev => [
      ...prev,
      userMessage,
      { id: assistantId, role: 'assistant', content: '', createdAt: Date.now() },
    ])

    const request: AvaDaemonChatRequest = {
      runId,
      messages: [
        {
          role: 'system',
          content: 'You are Ava Web, a browser client for Ava. Use daemon tools when the user asks for external state, local files, commands, or app actions. Keep final answers concise and useful.',
        },
        ...messages
          .filter(message => message.sendToModel !== false)
          .filter(message => message.content.trim())
          .slice(-12)
          .map(message => ({ role: message.role, content: message.content })),
        { role: 'user', content: text },
      ],
      metadata: {
        streamOptions: {
          streamId: runId,
          temperature: 0.2,
        },
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
          setMessages(prev => prev.map(message => (
            message.id === assistantId ? { ...message, content: assistantText } : message
          )))
        },
      })
      setMessages(prev => prev.map(message => (
        message.id === assistantId
          ? { ...message, content: assistantText || 'No visible response returned.' }
          : message
      )))
      setRunStatus('idle')
    } catch (error) {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      setRunError(message)
      setRunStatus('failed')
      setMessages(prev => prev.map(item => (
        item.id === assistantId ? { ...item, content: `Request failed: ${message}` } : item
      )))
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
            <div><dt>Node</dt><dd>{status?.node ?? '-'}</dd></div>
            <div><dt>PID</dt><dd>{status?.pid ?? '-'}</dd></div>
          </dl>
          {statusError && <p className="status-error">{statusError}</p>}
        </section>
      </aside>

      <main className="chat-main">
        <header className="chat-header">
          <div>
            <h2>Chat Workspace</h2>
            <p>Streams through <code>{daemonUrl}</code></p>
          </div>
          <span className={`run-pill ${runStatus}`}>
            {runStatus === 'running' ? <Loader2 size={14} className="spin" /> : <Circle size={10} />}
            {runStatus}
          </span>
        </header>

        <div className="message-list" ref={scrollRef}>
          {messages.map(message => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="avatar">{message.role === 'user' ? <UserRound size={16} /> : <Bot size={16} />}</div>
              <div className="bubble">
                <div className="message-meta">
                  <strong>{message.role === 'user' ? 'You' : 'Ava'}</strong>
                  <span>{formatTime(message.createdAt)}</span>
                </div>
                <p>{message.content || (message.role === 'assistant' && runStatus === 'running' ? 'Thinking...' : '')}</p>
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
