import type { TaskExecutionStep, ProjectAnalysis, ModelProvider, Settings } from '../../../types'

export interface MemoryStore {
  architecture: ProjectAnalysis | null
  completedTasksSummaries: string[]
  activeInterfaces: string[]
}

export class ContextManager {
  private memory: MemoryStore

  constructor(initialArchitecture: ProjectAnalysis | null) {
    this.memory = {
      architecture: initialArchitecture,
      completedTasksSummaries: [],
      activeInterfaces: []
    }
  }

  getWorkingMemory(): string {
    const parts = []
    
    if (this.memory.architecture) {
      parts.push('--- ARCHITECTURE ---')
      parts.push(`Summary: ${this.memory.architecture.projectSummary}`)
      parts.push(`Rules: ${this.memory.architecture.architecture}`)
    }

    if (this.memory.completedTasksSummaries.length > 0) {
      parts.push('--- COMPLETED TASKS ---')
      parts.push(this.memory.completedTasksSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n'))
    }

    if (this.memory.activeInterfaces.length > 0) {
      parts.push('--- ACTIVE INTERFACES ---')
      parts.push(this.memory.activeInterfaces.join('\n'))
    }

    return parts.join('\n\n')
  }

  async compressCompletedTask(
    step: TaskExecutionStep, 
    diffOrOutput: string, 
    providers: ModelProvider[], 
    settings: Settings
  ): Promise<void> {
    const streamId = `compress_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    
    const systemPrompt = `You are the Context Compressor Agent.
Your job is to summarize the outcome of the completed task to save context memory for future tasks.
Task Goal: ${step.title}
Output a short, concise summary (1-2 sentences) of what was actually built or fixed.
Also, if any new files, functions, or UI components were exported, list them.
Output JSON: { "summary": "...", "exportedInterfaces": ["..."] }`

    try {
      const reply = await window.ava.llm.stream({
        streamId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Task output:\n${diffOrOutput}` }
        ],
        providers,
        temperature: 0.1,
        pluginStates: settings.pluginStates,
        toolFormatMap: settings.modelToolFormatMap,
      })

      if (!reply.ok) return

      const jsonMatch = reply.result.fullContent.match(/```json\s*(\{[\s\S]*?\})\s*```/) || 
                        reply.result.fullContent.match(/(\{[\s\S]*\})/)
      
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1])
        if (parsed.summary) this.memory.completedTasksSummaries.push(`[${step.id}]: ${parsed.summary}`)
        if (Array.isArray(parsed.exportedInterfaces)) {
          this.memory.activeInterfaces.push(...parsed.exportedInterfaces)
        }
      }
    } catch (err) {
      console.error('Failed to compress context:', err)
      // Fallback
      this.memory.completedTasksSummaries.push(`[${step.id}]: Completed successfully but compression failed.`)
    }
  }
}
