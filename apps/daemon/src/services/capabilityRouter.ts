import type { McpToolDescriptor } from './mcpSupervisor'
import type { PluginSkillCandidate } from './pluginManager'

export type CapabilityKind = 'built_in_tool' | 'mcp_tool' | 'skill'

export interface CapabilityIndexItem {
  id: string
  kind: CapabilityKind
  name: string
  description: string
  source: string
  tags: string[]
  contextCost: number
  risk: 'low' | 'medium' | 'high'
  ref: McpToolDescriptor | PluginSkillCandidate
}

export interface CapabilityRoutingInput {
  currentTask: string
  activeStepRole?: string
  activeStepRequiredTools?: string[]
  messagesText?: string
  maxSkills?: number
  maxMcpTools?: number
}

export interface RoutedCapability<T = CapabilityIndexItem> {
  item: T
  score: number
  reasons: string[]
}

const DEFAULT_MAX_SKILLS = 3
const MIN_SKILL_SCORE = 4
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'need', 'use',
  'using', 'into', 'will', 'your', 'you', 'are', 'can', 'how', 'what', 'when',
  'where', 'why', 'please', 'pls', 'app', 'task', 'step', 'project',
])

const ROLE_TERMS: Record<string, string[]> = {
  inspect: ['inspect', 'explore', 'project', 'map', 'research'],
  scaffold: ['scaffold', 'create', 'init', 'setup', 'vite', 'project'],
  install: ['install', 'dependency', 'package', 'npm', 'pnpm'],
  feature: ['implement', 'feature', 'code', 'frontend', 'ui', 'react', 'component'],
  repair: ['repair', 'debug', 'fix', 'error', 'bug', 'diagnose'],
  validate: ['validate', 'build', 'test', 'typecheck', 'lint'],
  preview: ['preview', 'browser', 'devserver', 'website', 'ui'],
  console: ['console', 'browser', 'runtime', 'error', 'debug'],
  screenshot: ['screenshot', 'visual', 'browser', 'ui', 'layout'],
  final_report: ['summary', 'report', 'validation', 'changed'],
}

export function buildCapabilityIndex(input: {
  builtInTools: McpToolDescriptor[]
  mcpTools: McpToolDescriptor[]
  skills: PluginSkillCandidate[]
}): CapabilityIndexItem[] {
  return [
    ...input.builtInTools.map(tool => toolToCapability(tool, 'built_in_tool', 'built-in')),
    ...input.mcpTools.map(tool => toolToCapability(tool, 'mcp_tool', 'mcp')),
    ...input.skills.map(skill => skillToCapability(skill)),
  ]
}

export function routeSkills(
  skills: PluginSkillCandidate[],
  input: CapabilityRoutingInput,
): RoutedCapability<PluginSkillCandidate>[] {
  const maxSkills = Math.max(0, Math.floor(input.maxSkills ?? DEFAULT_MAX_SKILLS))
  if (maxSkills === 0 || skills.length === 0) return []
  const queryTerms = queryTermsFor(input)
  const routed = skills
    .map(skill => scoreSkill(skill, queryTerms, input))
    .filter(item => item.score >= MIN_SKILL_SCORE)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
  return routed.slice(0, maxSkills)
}

export function routeMcpTools(
  tools: McpToolDescriptor[],
  input: CapabilityRoutingInput,
): RoutedCapability<McpToolDescriptor>[] {
  const maxMcpTools = Math.max(0, Math.floor(input.maxMcpTools ?? 8))
  if (maxMcpTools === 0 || tools.length === 0) return []
  const queryTerms = queryTermsFor(input)
  const requiredTools = new Set(input.activeStepRequiredTools ?? [])
  return tools
    .map(tool => scoreMcpTool(tool, queryTerms, requiredTools, input))
    .filter(item => item.score >= 3 || requiredTools.has(item.item.name))
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, maxMcpTools)
}

function toolToCapability(tool: McpToolDescriptor, kind: 'built_in_tool' | 'mcp_tool', source: string): CapabilityIndexItem {
  return {
    id: `${kind}:${tool.name}`,
    kind,
    name: tool.name,
    description: tool.description ?? '',
    source,
    tags: tokenize(`${tool.name} ${tool.description ?? ''}`).slice(0, 12),
    contextCost: JSON.stringify(tool.inputSchema ?? {}).length + (tool.description ?? '').length,
    risk: toolRisk(tool.name, tool.description ?? ''),
    ref: tool,
  }
}

function skillToCapability(skill: PluginSkillCandidate): CapabilityIndexItem {
  return {
    id: `skill:${skill.pluginId}:${skill.name}`,
    kind: 'skill',
    name: skill.name,
    description: skill.summary || skill.contentPreview,
    source: skill.pluginName,
    tags: skill.tags,
    contextCost: skill.contentPreview.length,
    risk: 'low',
    ref: skill,
  }
}

function scoreSkill(
  skill: PluginSkillCandidate,
  queryTerms: Set<string>,
  input: CapabilityRoutingInput,
): RoutedCapability<PluginSkillCandidate> {
  const reasons: string[] = []
  let score = 0
  const haystack = tokenize([
    skill.name,
    skill.pluginName,
    skill.summary,
    skill.tags.join(' '),
    skill.contentPreview,
  ].join(' '))
  const haystackSet = new Set(haystack)
  const nameSet = new Set(tokenize(`${skill.name} ${skill.pluginName}`))
  const tagSet = new Set(skill.tags.map(tag => tag.toLowerCase()))

  for (const term of queryTerms) {
    if (nameSet.has(term)) {
      score += 5
      reasons.push(`name:${term}`)
    } else if (tagSet.has(term)) {
      score += 4
      reasons.push(`tag:${term}`)
    } else if (haystackSet.has(term)) {
      score += 1
    }
  }

  const roleTerms = input.activeStepRole ? ROLE_TERMS[input.activeStepRole] ?? [] : []
  for (const term of roleTerms) {
    if (nameSet.has(term) || tagSet.has(term)) {
      score += 3
      reasons.push(`role:${input.activeStepRole}:${term}`)
    } else if (haystackSet.has(term)) {
      score += 1
    }
  }

  const lowerQuery = `${input.currentTask}\n${input.messagesText ?? ''}`.toLowerCase()
  if (lowerQuery.includes(skill.name.toLowerCase())) {
    score += 8
    reasons.push('explicit-skill-name')
  }
  if (lowerQuery.includes(skill.pluginName.toLowerCase())) {
    score += 4
    reasons.push('explicit-plugin-name')
  }

  const costPenalty = Math.min(3, Math.floor(skill.contentPreview.length / 4000))
  score -= costPenalty
  if (costPenalty > 0) reasons.push(`context-cost:-${costPenalty}`)

  return {
    item: skill,
    score,
    reasons: Array.from(new Set(reasons)).slice(0, 8),
  }
}

function scoreMcpTool(
  tool: McpToolDescriptor,
  queryTerms: Set<string>,
  requiredTools: Set<string>,
  input: CapabilityRoutingInput,
): RoutedCapability<McpToolDescriptor> {
  const reasons: string[] = []
  let score = 0
  const nameSet = new Set(tokenize(tool.name))
  const haystackSet = new Set(tokenize(`${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema ?? {})}`))

  if (requiredTools.has(tool.name)) {
    score += 20
    reasons.push('required-tool')
  }

  for (const term of queryTerms) {
    if (nameSet.has(term)) {
      score += 5
      reasons.push(`name:${term}`)
    } else if (haystackSet.has(term)) {
      score += 1
    }
  }

  const roleTerms = input.activeStepRole ? ROLE_TERMS[input.activeStepRole] ?? [] : []
  for (const term of roleTerms) {
    if (nameSet.has(term)) {
      score += 3
      reasons.push(`role:${input.activeStepRole}:${term}`)
    } else if (haystackSet.has(term)) {
      score += 1
    }
  }

  const lowerQuery = `${input.currentTask}\n${input.messagesText ?? ''}`.toLowerCase()
  if (lowerQuery.includes(tool.name.toLowerCase()) || lowerQuery.includes(tool.rawName.toLowerCase())) {
    score += 8
    reasons.push('explicit-tool-name')
  }

  const riskPenalty = toolRisk(tool.name, tool.description ?? '') === 'medium' ? 1 : 0
  score -= riskPenalty
  if (riskPenalty > 0) reasons.push(`risk:-${riskPenalty}`)

  return {
    item: tool,
    score,
    reasons: Array.from(new Set(reasons)).slice(0, 8),
  }
}

function queryTermsFor(input: CapabilityRoutingInput): Set<string> {
  const requiredToolTerms = (input.activeStepRequiredTools ?? []).join(' ')
  const roleTerms = input.activeStepRole ? ROLE_TERMS[input.activeStepRole]?.join(' ') ?? '' : ''
  return new Set(tokenize([
    input.currentTask,
    input.messagesText ?? '',
    input.activeStepRole ?? '',
    requiredToolTerms,
    roleTerms,
  ].join(' ')).filter(term => !STOP_WORDS.has(term)))
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9+#.-]+/i)
    .map(item => item.trim())
    .filter(item => item.length >= 2 && item.length <= 40 && !STOP_WORDS.has(item))
}

function toolRisk(name: string, description: string): 'low' | 'medium' | 'high' {
  const text = `${name} ${description}`.toLowerCase()
  if (/\b(delete|remove|kill|write|patch|shell|command|exec|process)\b/.test(text)) return 'medium'
  return 'low'
}
