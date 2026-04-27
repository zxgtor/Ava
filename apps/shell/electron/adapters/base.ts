import { 
  ModelProvider, 
  LlmMessage, 
  StreamStepResult, 
  StreamStepArgs
} from '../llm'
import { McpToolDescriptor } from '../services/mcpSupervisor'

export interface AdapterOptions {
  provider: ModelProvider
  args: StreamStepArgs
  controller: AbortController
  onChunk: (text: string) => void
}

export abstract class LlmAdapter {
  /**
   * Performs a single step of streaming chat. 
   * Returns visible text and any detected tool calls.
   */
  abstract streamChat(options: AdapterOptions): Promise<StreamStepResult>

  /**
   * Optional: Can be used by adapters to transform internal messages 
   * to provider-specific formats.
   */
  protected abstract transformMessages(messages: LlmMessage[]): any
}
