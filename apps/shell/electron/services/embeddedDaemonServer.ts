import type { WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { streamChat, type RuntimeStreamEvent, type StreamChatArgs } from '@ava/daemon'
import type { AvaChatStreamEvent, AvaChatStreamRequest } from '@ava/contracts'

interface DaemonServerHandle {
  url: string
  close: () => Promise<void>
}

type EmitDaemonEvent = (event: AvaChatStreamEvent) => void

let embeddedDaemon: DaemonServerHandle | null = null

function streamChatArgsFromRequest(request: AvaChatStreamRequest): StreamChatArgs {
  const metadata = request.metadata as { streamChatArgs?: unknown } | undefined
  const args = metadata?.streamChatArgs as StreamChatArgs | undefined
  if (!args || !Array.isArray(args.messages) || !Array.isArray(args.providers)) {
    throw new Error('Daemon runtime request is missing metadata.streamChatArgs.')
  }
  return args
}

function createRuntimeWebContents(args: StreamChatArgs, emit: EmitDaemonEvent): WebContents {
  let runStarted = false
  let runFinished = false

  const ensureStarted = () => {
    if (runStarted) return
    runStarted = true
    emit({
      type: 'chat.run.started',
      runId: args.streamId,
      phase: 'running',
      timestamp: new Date().toISOString(),
      runtimeAttached: true,
    })
  }

  const sendRuntimeEvent = (event: RuntimeStreamEvent) => {
    if (event.streamId !== args.streamId) return

    if (event.type === 'text_delta') {
      ensureStarted()
      return
    }

    if (event.type === 'run_status') {
      ensureStarted()
      return
    }

    if (event.type === 'error') {
      ensureStarted()
      emit({
        type: 'chat.run.failed',
        runId: args.streamId,
        phase: 'failed',
        timestamp: new Date().toISOString(),
        error: event.message,
      })
      runFinished = true
    }
  }

  return {
    isDestroyed: () => runFinished,
    send: (channel: string, payload: unknown) => {
      emit({
        type: 'chat.ipc.event',
        runId: args.streamId,
        channel,
        payload,
      })
      if (channel === 'ava:llm:event') {
        sendRuntimeEvent(payload as RuntimeStreamEvent)
      }
    },
  } as unknown as WebContents
}

export function shouldStartEmbeddedDaemonRuntime(): boolean {
  const value = process.env.AVA_CHAT_RUNTIME ?? process.env.AVA_USE_DAEMON_CHAT
  return value === 'daemon' || value === '1' || value === 'true' || process.env.AVA_EMBED_DAEMON === '1'
}

export async function startEmbeddedDaemonRuntime(): Promise<void> {
  if (embeddedDaemon) return

  const moduleUrl = pathToFileURL(join(process.cwd(), 'apps/daemon/src/httpServer.mjs')).href
  const { startDaemonServer } = await import(/* @vite-ignore */ moduleUrl) as {
    startDaemonServer: (options: {
      runtime: {
        streamChat: (request: AvaChatStreamRequest, emit: EmitDaemonEvent) => Promise<void>
      }
    }) => Promise<DaemonServerHandle>
  }

  embeddedDaemon = await startDaemonServer({
    runtime: {
      streamChat: async (request, emit) => {
        const args = streamChatArgsFromRequest(request)
        const webContents = createRuntimeWebContents(args, emit)
        const result = await streamChat(webContents, args)

        emit({
          type: 'chat.message.completed',
          runId: args.streamId,
          message: {
            role: 'assistant',
            content: result.fullContent,
            createdAt: new Date().toISOString(),
          },
        })
        emit({
          type: 'chat.run.completed',
          runId: args.streamId,
          phase: 'completed',
          timestamp: new Date().toISOString(),
        })
      },
    },
  })

  console.info(`[daemon] embedded runtime listening on ${embeddedDaemon.url}`)
}

export async function stopEmbeddedDaemonRuntime(): Promise<void> {
  if (!embeddedDaemon) return
  const daemon = embeddedDaemon
  embeddedDaemon = null
  await daemon.close()
}
