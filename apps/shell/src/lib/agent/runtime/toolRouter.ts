import type { TaskExecutionStep } from '../../../types'

export class ToolRouter {
  // A catalog of all available tools across MCPs, Skills, and built-ins.
  // In a full implementation, this would be populated dynamically from Ava's plugin manager.
  private availableToolsCatalog: Record<string, any> = {}

  constructor(catalog: Record<string, any>) {
    this.availableToolsCatalog = catalog
  }

  getLightweightCatalogForPlanner(): string {
    // Returns a summary of tool names and short descriptions to not blow up context
    return Object.entries(this.availableToolsCatalog)
      .map(([name, schema]) => `- ${name}: ${schema.description || 'No description'}`)
      .join('\n')
  }

  injectToolsForStep(step: TaskExecutionStep): any[] {
    const injected = []
    // Always inject some core file reading tools
    const coreTools = ['file.read_text', 'project.map', 'search.ripgrep']
    
    const requested = new Set([...coreTools, ...step.requiredTools])

    for (const toolName of requested) {
      if (this.availableToolsCatalog[toolName]) {
        injected.push(this.availableToolsCatalog[toolName])
      }
    }
    
    return injected
  }
}
