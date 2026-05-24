import type { WebContents } from 'electron'
import type { AvaChatStreamEvent, AvaChatStreamRequest } from '@ava/contracts'
import type { ModelProvider, StreamChatArgs, StreamChatResult } from '../llm'
import { toolRuntime } from './toolRuntime'

const DEFAULT_DAEMON_HOST = '127.0.0.1'
const DEFAULT_DAEMON_PORT = '17871'

const activeDaemonStreams = new Map<string, AbortController>()

export function shouldUseDaemonChat(): boolean {
  const value = process.env.AVA_CHAT_RUNTIME ?? process.env.AVA_USE_DAEMON_CHAT
  return value === 'daemon' || value === '1' || value === 'true'
}

export function daemonBaseUrl(): string {
  if (process.env.AVA_DAEMON_URL) return process.env.AVA_DAEMON_URL.replace(/\/+$/, '')
  const host = process.env.AVA_DAEMON_HOST || DEFAULT_DAEMON_HOST
  const port = process.env.AVA_DAEMON_PORT || DEFAULT_DAEMON_PORT
  return `http://${host}:${port}`
}

export function abortDaemonChatStream(streamId: string): boolean {
  const controller = activeDaemonStreams.get(streamId)
  if (!controller) return false
  controller.abort()
  activeDaemonStreams.delete(streamId)
  return true
}

function selectedProvider(args: StreamChatArgs): ModelProvider {
  const provider = args.providers.find(item => item.enabled) ?? args.providers[0]
  if (provider) return provider
  return {
    id: 'daemon',
    name: 'Ava Daemon',
    type: 'local',
    baseUrl: daemonBaseUrl(),
    apiKey: '',
    enabled: true,
    models: ['daemon'],
    defaultModel: 'daemon',
  }
}

function selectedModel(provider: ModelProvider): string {
  return provider.defaultModel || provider.models[0] || 'daemon'
}

function buildDaemonRequest(args: StreamChatArgs, provider: ModelProvider, model: string): AvaChatStreamRequest {
  return {
    runId: args.streamId,
    providerId: provider.id,
    model,
    messages: args.messages.map(message => ({
      role: message.role,
      content: message.content,
      taskId: message.taskId,
      toolCallId: message.toolCallId,
    })),
    activeStepId: args.activeStepRequiredTools?.join(',') || undefined,
    metadata: {
      activeTaskId: args.activeTaskId,
      activeFolderPath: args.activeFolderPath,
      activeStepRole: args.activeStepRole,
      activeStepRequiredTools: args.activeStepRequiredTools,
    },
  }
}

function parseSseEvents(buffer: string): { events: AvaChatStreamEvent[]; rest: string } {
  const events: AvaChatStreamEvent[] = []
  let rest = buffer
  let boundary = rest.indexOf('\n\n')

  while (boundary >= 0) {
    const rawEvent = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)
    boundary = rest.indexOf('\n\n')

    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trimStart())

    if (dataLines.length === 0) continue

    try {
      events.push(JSON.parse(dataLines.join('\n')) as AvaChatStreamEvent)
    } catch {
      // Ignore malformed SSE frames; the final result fails if no completion
      // event arrives.
    }
  }

  return { events, rest }
}

function emitDaemonEvent(
  webContents: WebContents,
  args: StreamChatArgs,
  provider: ModelProvider,
  model: string,
  event: AvaChatStreamEvent,
): { textDelta?: string; completed?: boolean; failedError?: string } {
  if (event.type === 'chat.run.started') {
    toolRuntime.sendRunStatus(webContents, args, provider, model, 'generating')
    return {}
  }

  if (event.type === 'chat.message.delta') {
    toolRuntime.sendTextDelta(webContents, args, event.delta)
    return { textDelta: event.delta }
  }

  if (event.type === 'chat.run.completed') {
    toolRuntime.sendRunStatus(webContents, args, provider, model, 'completed')
    return { completed: true }
  }

  if (event.type === 'chat.run.failed') {
    toolRuntime.sendRunStatus(webContents, args, provider, model, 'error')
    toolRuntime.sendError(webContents, args, event.error)
    return { failedError: event.error }
  }

  return {}
}

export async function streamChatThroughDaemon(
  webContents: WebContents,
  args: StreamChatArgs,
): Promise<StreamChatResult> {
  const provider = selectedProvider(args)
  const model = selectedModel(provider)
  const controller = new AbortController()
  const request = buildDaemonRequest(args, provider, model)
  const url = `${daemonBaseUrl()}/chat/stream`
  let fullContent = ''
  let completed = false

  activeDaemonStreams.set(args.streamId, controller)
  toolRuntime.sendRunStatus(webContents, args, provider, model, 'connecting')

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Daemon chat stream failed: HTTP ${response.status}`)
    }
    if (!response.body) {
      throw new Error('Daemon chat stream failed: empty response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseEvents(buffer)
      buffer = parsed.rest

      for (const event of parsed.events) {
        const result = emitDaemonEvent(webContents, args, provider, model, event)
        if (result.textDelta) fullContent += result.textDelta
        if (result.completed) completed = true
        if (result.failedError) throw new Error(result.failedError)
      }
    }

    buffer += decoder.decode()
    const parsed = parseSseEvents(buffer)
    for (const event of parsed.events) {
      const result = emitDaemonEvent(webContents, args, provider, model, event)
      if (result.textDelta) fullContent += result.textDelta
      if (result.completed) completed = true
      if (result.failedError) throw new Error(result.failedError)
    }

    if (!completed) {
      throw new Error('Daemon chat stream ended before chat.run.completed')
    }

    return {
      fullContent,
      parts: fullContent ? [{ type: 'text', text: fullContent }] : [],
      provider,
      model,
      attempts: [{
        providerId: provider.id,
        providerName: provider.name,
        model,
        ok: true,
      }],
      fallbackUsed: false,
      toolCallsIssued: 0,
      loopRounds: 0,
      detectedToolFormat: 'none',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    toolRuntime.sendRunStatus(webContents, args, provider, model, controller.signal.aborted ? 'aborted' : 'error')
    toolRuntime.sendError(webContents, args, message)
    throw error
  } finally {
    activeDaemonStreams.delete(args.streamId)
  }
}
