import type { TaskExecutionPlan, TaskExecutionStep } from '../../types'

const CODING_DESIGN_TASK_RE =
  /\b(3d|three\.?js|animation|animated|site|website|landing page|app|full app|project|professional|production ready|complete|responsive|dashboard|frontend|ui|ux|migrate|refactor|implement feature|create|build|generate)\b|三维|动画|网站|站点|落地页|应用|完整|专业|响应式|前端|界面|迁移|重构|项目/i

export function isCodingDesignBigTask(content: string): boolean {
  return CODING_DESIGN_TASK_RE.test(content) || content.length > 300
}

export function extractWorkingDirectoryFromText(content: string): string | undefined {
  const quoted = content.match(/["'`]([A-Za-z]:[\\/][^"'`\r\n]+)["'`]/)
  if (quoted?.[1]) return sanitizeWorkingDirectoryPath(quoted[1])

  const bare = content.match(/[A-Za-z]:[\\/][\w./\\()-]+/)
  return bare ? sanitizeWorkingDirectoryPath(bare[0]) : undefined
}

function sanitizeWorkingDirectoryPath(path: string): string | undefined {
  const cleaned = path
    .trim()
    .replace(/[.,;:!?，。；：！？\])}]+$/g, '')
    .trim()
  if (!/^[A-Za-z]:[\\/]/.test(cleaned)) return undefined
  if (/[<>|?*"]/.test(cleaned)) return undefined
  return cleaned
}

export function getNodesByLayer(plan: TaskExecutionPlan): TaskExecutionStep[][] {
  const byId = new Map(plan.steps.map(step => [step.id, step]))
  const depthMemo = new Map<string, number>()

  const depthOf = (step: TaskExecutionStep, visiting = new Set<string>()): number => {
    if (depthMemo.has(step.id)) return depthMemo.get(step.id)!
    if (visiting.has(step.id)) return 0
    visiting.add(step.id)
    const deps = (step.dependsOn ?? [])
      .map(id => byId.get(id))
      .filter((item): item is TaskExecutionStep => Boolean(item))
    const depth = deps.length === 0
      ? 0
      : Math.max(...deps.map(dep => depthOf(dep, visiting))) + 1
    visiting.delete(step.id)
    depthMemo.set(step.id, depth)
    return depth
  }

  const layers: TaskExecutionStep[][] = []
  for (const step of plan.steps) {
    const depth = depthOf(step)
    layers[depth] ??= []
    layers[depth].push(step)
  }
  return layers
}
