import type { WebContents } from 'electron'
import type {
  AssistantRunPhase,
  ModelProvider,
  RuntimeStreamEvent,
  StreamChatArgs,
  ToolCallPart,
} from '../llm'

const MAX_RESOLVED_TOOL_CALL_IDS = 1_000

export function duplicateToolResultPatch(): Partial<ToolCallPart> {
  return {
    endedAt: Date.now(),
    status: 'ok',
    result: {
      ignored: true,
      reason: 'Duplicate tool_call_id was already resolved for this stream; Ava ignored the late duplicate to avoid executing the same tool twice.',
    },
  }
}

export class ToolRuntime {
  private resolvedToolCallIds: string[] = []
  private resolvedToolCallIdSet = new Set<string>()

  emit(webContents: WebContents, event: RuntimeStreamEvent): void {
    if (webContents.isDestroyed()) return
    webContents.send('ava:llm:event', event)
  }

  sendRunStatus(
    webContents: WebContents,
    args: StreamChatArgs,
    provider: ModelProvider,
    model: string,
    phase: AssistantRunPhase,
  ): void {
    if (webContents.isDestroyed()) return
    const payload = {
      streamId: args.streamId,
      taskId: args.activeTaskId,
      providerId: provider.id,
      providerName: provider.name,
      model,
      phase,
    }
    webContents.send('ava:llm:status', payload)
    this.emit(webContents, { type: 'run_status', ...payload })
  }

  sendTextDelta(webContents: WebContents, args: StreamChatArgs, text: string): void {
    if (webContents.isDestroyed()) return
    webContents.send('ava:llm:chunk', { streamId: args.streamId, text })
    this.emit(webContents, {
      type: 'text_delta',
      streamId: args.streamId,
      taskId: args.activeTaskId,
      text,
    })
  }

  sendReasoningDelta(webContents: WebContents, args: StreamChatArgs, text: string): void {
    if (webContents.isDestroyed()) return
    webContents.send('ava:llm:reasoning-chunk', { streamId: args.streamId, text })
    this.emit(webContents, {
      type: 'reasoning_delta',
      streamId: args.streamId,
      taskId: args.activeTaskId,
      text,
    })
  }

  sendToolStarted(webContents: WebContents, args: StreamChatArgs, partIndex: number, part: ToolCallPart): void {
    if (!webContents.isDestroyed()) {
      webContents.send('ava:llm:part', {
        streamId: args.streamId,
        taskId: args.activeTaskId,
        partIndex,
        part,
      })
    }
    this.emit(webContents, {
      type: 'tool_call_started',
      streamId: args.streamId,
      taskId: args.activeTaskId,
      partIndex,
      part,
    })
  }

  sendToolResult(
    webContents: WebContents,
    args: StreamChatArgs,
    partIndex: number,
    partId: string,
    patch: Partial<ToolCallPart>,
  ): void {
    if (!webContents.isDestroyed()) {
      webContents.send('ava:llm:partUpdate', {
        streamId: args.streamId,
        taskId: args.activeTaskId,
        partIndex,
        partId,
        patch,
      })
    }
    this.emit(webContents, {
      type: 'tool_result',
      streamId: args.streamId,
      taskId: args.activeTaskId,
      partIndex,
      partId,
      patch,
    })
  }

  sendError(webContents: WebContents, args: StreamChatArgs, message: string): void {
    this.emit(webContents, {
      type: 'error',
      streamId: args.streamId,
      taskId: args.activeTaskId,
      message,
    })
  }

  hasResolvedToolCall(streamId: string, toolCallId: string): boolean {
    return this.resolvedToolCallIdSet.has(this.resolvedToolCallKey(streamId, toolCallId))
  }

  rememberResolvedToolCall(streamId: string, toolCallId: string): void {
    const key = this.resolvedToolCallKey(streamId, toolCallId)
    if (this.resolvedToolCallIdSet.has(key)) return
    this.resolvedToolCallIdSet.add(key)
    this.resolvedToolCallIds.push(key)
    while (this.resolvedToolCallIds.length > MAX_RESOLVED_TOOL_CALL_IDS) {
      const old = this.resolvedToolCallIds.shift()
      if (old) this.resolvedToolCallIdSet.delete(old)
    }
  }

  private resolvedToolCallKey(streamId: string, toolCallId: string): string {
    return `${streamId}:${toolCallId}`
  }
}

export const toolRuntime = new ToolRuntime()
