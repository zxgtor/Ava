import type { TaskExecutionPlan, TaskExecutionStep } from '../../types'

const TASK_EXECUTION_VERB_RE = /\b(build|create|make|generate|implement|scaffold|fix|debug|refactor|modify|update|edit|add|remove|delete)\b|创建|生成|实现|搭建|修复|调试|重构|修改|更新|添加|删除/i
const ENGINEERING_OBJECT_RE = /\b(app|site|website|web\s*app|project|component|page|feature|bug|code|html|css|javascript|typescript|react|vue|svelte|angular|node|npm|vite|three\.?js|webgl|glb|api|server|database|cli|extension|plugin|desktop|electron|build|typecheck|test)\b|网站|应用|项目|组件|页面|功能|代码|接口|服务|插件|桌面|构建|测试|类型检查/i
const LOCAL_EXECUTION_SIGNAL_RE = /\b[A-Z]:\\|\/[A-Za-z0-9_.-]+\/|package\.json|npm\s|pnpm\s|yarn\s|bun\s|git\s|\.tsx?\b|\.jsx?\b|\.py\b|\.css\b|\.html\b/i
const CODE_SCRIPT_RE = /\b(?:python|javascript|typescript|node|bash|shell|powershell|sql)\s+script\b|\bscript\s+(?:in|with)\s+(?:python|javascript|typescript|node|bash|shell|powershell|sql)\b|Python\s*脚本|脚本.*(?:Python|JavaScript|TypeScript|Shell|PowerShell)/i

export function hasStrongCodingDesignTaskIntent(content: string): boolean {
  if (/\b(fix|debug|refactor)\b|修复|调试|重构/i.test(content)) return true
  if (!TASK_EXECUTION_VERB_RE.test(content)) return false
  return ENGINEERING_OBJECT_RE.test(content) || LOCAL_EXECUTION_SIGNAL_RE.test(content) || CODE_SCRIPT_RE.test(content)
}

export function isCodingDesignBigTask(content: string): boolean {
  return hasStrongCodingDesignTaskIntent(content) || (content.length > 300 && (ENGINEERING_OBJECT_RE.test(content) || LOCAL_EXECUTION_SIGNAL_RE.test(content)))
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
