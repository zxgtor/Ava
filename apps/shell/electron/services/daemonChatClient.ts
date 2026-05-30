import type { WebContents } from 'electron'
import { AvaClient } from '@ava/client-sdk'
import type { AvaChatStreamEvent, AvaDaemonChatRequest } from '@ava/contracts'
import type { ModelProvider, StreamChatArgs, StreamChatResult } from '../llm'
import { toolRuntime } from '../../../daemon/src/services/toolRuntime'

const DEFAULT_DAEMON_HOST = '127.0.0.1'
const DEFAULT_DAEMON_PORT = '17871'

const activeDaemonStreams = new Map<string, AbortController>()

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

function buildDaemonRequest(args: StreamChatArgs, provider: ModelProvider, model: string): AvaDaemonChatRequest {
  return {
    conversationId: args.conversationId,
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
      streamChatArgs: args,
    },
  }
}

function emitDaemonEvent(
  webContents: WebContents,
  args: StreamChatArgs,
  provider: ModelProvider,
  model: string,
  event: AvaChatStreamEvent,
): { textDelta?: string; completed?: boolean; failedError?: string } {
  if (event.type === 'chat.ipc.event') {
    webContents.send(event.channel, event.payload)
    if (event.channel === 'ava:llm:chunk') {
      const payload = event.payload as { streamId?: string; text?: unknown }
      if (payload.streamId === args.streamId && typeof payload.text === 'string') {
        return { textDelta: payload.text }
      }
    }
    return {}
  }

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
  const client = new AvaClient({ baseUrl: daemonBaseUrl() })
  let fullContent = ''
  let completed = false

  activeDaemonStreams.set(args.streamId, controller)
  toolRuntime.sendRunStatus(webContents, args, provider, model, 'connecting')

  try {
    await client.streamChatEvents({
      request,
      signal: controller.signal,
      onEvent: (event) => {
        const result = emitDaemonEvent(webContents, args, provider, model, event)
        if (result.textDelta) fullContent += result.textDelta
        if (result.completed) completed = true
        if (result.failedError) throw new Error(result.failedError)
      },
    })

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
