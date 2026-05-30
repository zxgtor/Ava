import type { AvaInputClassifyRequest, AvaInputClassifyResult, AvaInputRoute, AvaInputWorkflow } from '@ava/contracts'
import { loadSettings } from './storage'

const TASK_INTAKE_INTENT_RE = /\b(build|create|make|generate|implement|fix|debug|refactor|modify|update|edit|write|add|remove|delete|site|app|component|page|feature|bug|code|html|css|javascript|typescript|react|three\.?js|3d)\b|创建|生成|实现|修复|调试|重构|修改|更新|添加|删除|网站|应用|组件|页面|功能|代码|三维|3d/i
const AVA_META_QUESTION_RE = /\b(what can ava do|what.*ava.*do|ava.*status|how.*ava|why.*ask|capabilit|check what ava can do|what.*this app.*can do)\b|Ava.*能做|能做什么|检查.*Ava|看看.*Ava|先看看|先了解|为什么.*问/i
const CANCEL_OR_PAUSE_RE = /^\s*(stop|cancel|pause|abort|never mind|not now|先别|不要继续|取消|停止|暂停|算了)\s*[.!。！]*\s*$/i
const RETRY_OR_CONTINUE_RE = /^\s*(retry|try again|continue|resume|go on|继续|重试|再试|接着做)\s*[.!。！]*\s*$/i
const TASK_CONFIRMATION_RE = /^\s*(ok|okay|yes|y|go|start|continue|proceed|confirm|do it|looks good|run|执行|开始|继续|确认|可以|好的|好|没问题|就这样)\s*[.!。！]*\s*$/i
const PERMISSION_RESPONSE_RE = /\b(allow|approve|approved|deny|denied|reject|permission|grant access)\b|允许|同意|批准|拒绝|不同意|授权|权限/i
const REQUIREMENT_CORRECTION_RE = /\b(not what i mean|misunderstood|misunderstand|actually|instead|change|i want to|i need to|first)\b|不是|不对|误解|理解错|我的意思|其实|改成|先看看|先看|先确认/i
const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\b(?:localhost|127\.0\.0\.1):\d+\b/i
const CODE_AGENT_DELEGATION_RE = /\b(codex|claude code|claude-code|open code|cursor|delegate|assign|handoff|use .*agent|run .*agent)\b|交给|委派|分配给|调用.*(codex|claude|代码代理|agent)|代码代理/i
const PREFERENCE_OR_SETTING_RE = /\b(always|never|prefer|preference|setting|settings|remember|default|use .* by default)\b|以后|总是|不要再|偏好|设置|默认|记住/i
const SMALL_TASK_RE = /\b(read|show|get|list|check|tell me|what is|find)\b.{0,80}\b(file|package\.json|name|version|status|info|content|directory|folder)\b|读取|查看|列出|告诉我|是什么|状态|内容|目录/i
const AMBIGUOUS_RE = /^\s*(this|that|it|这个|那个|它|看看|继续刚才|刚才那个)\s*$/i

function result(input: Omit<AvaInputClassifyResult, 'source'>): AvaInputClassifyResult {
  return { source: 'rule', ...input }
}

const LLM_CLASSIFIER_ROUTES = new Set<AvaInputRoute>([
  'normal_chat',
  'meta_question',
  'task_intake',
  'continue_intake',
  'task_confirmation',
  'requirement_correction',
  'cancel_or_pause',
  'retry_or_continue',
  'permission_response',
  'small_task',
  'file_or_attachment_input',
  'url_input',
  'agent_delegation',
  'preference_or_setting',
  'unknown_or_ambiguous',
])

const LLM_CLASSIFIER_WORKFLOWS = new Set<AvaInputWorkflow>([
  'chat',
  'intake',
  'intake_reply',
  'intake_reanalysis',
  'cancel',
  'recovery',
  'permission',
  'direct_tool',
  'file_media',
  'browser',
  'delegation',
  'settings',
  'clarify',
])

function workflowForRoute(route: AvaInputRoute): AvaInputWorkflow {
  switch (route) {
    case 'task_intake':
    case 'task_confirmation':
      return 'intake'
    case 'continue_intake':
      return 'intake_reply'
    case 'requirement_correction':
      return 'intake_reanalysis'
    case 'cancel_or_pause':
      return 'cancel'
    case 'retry_or_continue':
      return 'recovery'
    case 'permission_response':
      return 'permission'
    case 'small_task':
      return 'direct_tool'
    case 'file_or_attachment_input':
      return 'file_media'
    case 'url_input':
      return 'browser'
    case 'agent_delegation':
      return 'delegation'
    case 'preference_or_setting':
      return 'settings'
    case 'unknown_or_ambiguous':
      return 'clarify'
    case 'normal_chat':
    case 'meta_question':
    default:
      return 'chat'
  }
}

function hasAttachments(request: AvaInputClassifyRequest): boolean {
  return Boolean(request.attachments?.length)
}

function hasMultiInput(request: AvaInputClassifyRequest): boolean {
  const hasText = request.content.trim().length > 0
  const attachmentCount = request.attachments?.length ?? 0
  return attachmentCount > 1 || (hasText && attachmentCount > 0)
}

function shouldUseLlmClassifier(request: AvaInputClassifyRequest, ruleResult: AvaInputClassifyResult): boolean {
  if (request.pendingIntake) return false
  if (ruleResult.confidence < 0.65) return true
  if (hasMultiInput(request)) return true
  return ruleResult.route === 'unknown_or_ambiguous'
}

export function classifyInput(request: AvaInputClassifyRequest): AvaInputClassifyResult {
  const content = request.content.trim()

  if (CANCEL_OR_PAUSE_RE.test(content)) {
    return result({
      route: 'cancel_or_pause',
      workflow: 'cancel',
      requiresTaskIntake: false,
      reason: 'The user is explicitly cancelling or pausing the active flow.',
      confidence: 0.95,
    })
  }

  if (PERMISSION_RESPONSE_RE.test(content)) {
    return result({
      route: 'permission_response',
      workflow: 'permission',
      requiresTaskIntake: false,
      reason: 'The input looks like an allow/deny response for a permission or access request.',
      confidence: 0.86,
    })
  }

  if (request.pendingIntake) {
    if (AVA_META_QUESTION_RE.test(content)) {
      return result({
        route: 'meta_question',
        workflow: 'chat',
        requiresTaskIntake: false,
        reason: 'The user is asking a meta question while intake is active; answer it instead of asking the next old question.',
        confidence: 0.82,
      })
    }

    if (REQUIREMENT_CORRECTION_RE.test(content)) {
      return result({
        route: 'requirement_correction',
        workflow: 'intake_reanalysis',
        requiresTaskIntake: false,
        reason: 'The user appears to be correcting the requirement instead of answering the current clarification.',
        confidence: 0.78,
      })
    }

    if (request.pendingIntakeStage === 'awaiting_summary_confirm' && TASK_CONFIRMATION_RE.test(content)) {
      return result({
        route: 'task_confirmation',
        workflow: 'intake',
        requiresTaskIntake: false,
        reason: 'The user confirmed the clarified summary and can proceed to planning.',
        confidence: 0.92,
      })
    }

    return result({
      route: 'continue_intake',
      workflow: 'intake_reply',
      requiresTaskIntake: false,
      reason: 'A task intake flow is already active; the reply should be handled by the intake reply classifier.',
      confidence: 0.9,
    })
  }

  if (request.hasCommandInvocation) {
    return result({
      route: 'task_intake',
      workflow: 'intake',
      requiresTaskIntake: true,
      reason: 'Command invocations require task intake so Ava can confirm scope and execution plan.',
      confidence: 0.95,
    })
  }

  if (RETRY_OR_CONTINUE_RE.test(content)) {
    return result({
      route: 'retry_or_continue',
      workflow: 'recovery',
      requiresTaskIntake: false,
      reason: 'The user wants to retry or continue an interrupted task.',
      confidence: 0.88,
    })
  }

  if (AVA_META_QUESTION_RE.test(content)) {
    return result({
      route: 'meta_question',
      workflow: 'chat',
      requiresTaskIntake: false,
      reason: 'The user is asking about Ava or the workflow, not requesting project execution.',
      confidence: 0.8,
    })
  }

  if (CODE_AGENT_DELEGATION_RE.test(content)) {
    return result({
      route: 'agent_delegation',
      workflow: 'delegation',
      requiresTaskIntake: false,
      reason: 'The user appears to be asking Ava to delegate work to a code agent such as Codex or Claude Code.',
      confidence: 0.84,
    })
  }

  if (URL_RE.test(content) || request.attachments?.some(item => item.kind === 'url' || item.url)) {
    return result({
      route: 'url_input',
      workflow: 'browser',
      requiresTaskIntake: false,
      reason: 'The input contains a URL or URL attachment.',
      confidence: 0.83,
    })
  }

  if (hasAttachments(request)) {
    return result({
      route: 'file_or_attachment_input',
      workflow: 'file_media',
      requiresTaskIntake: false,
      reason: 'The input includes attachments that should be understood as part of the request.',
      confidence: 0.82,
    })
  }

  if (PREFERENCE_OR_SETTING_RE.test(content)) {
    return result({
      route: 'preference_or_setting',
      workflow: 'settings',
      requiresTaskIntake: false,
      reason: 'The user is expressing a preference or setting rather than asking for task execution.',
      confidence: 0.78,
    })
  }

  if (SMALL_TASK_RE.test(content) && !TASK_INTAKE_INTENT_RE.test(content)) {
    return result({
      route: 'small_task',
      workflow: 'direct_tool',
      requiresTaskIntake: false,
      reason: 'The request looks like a small direct tool task and does not need full task intake.',
      confidence: 0.72,
    })
  }

  if (TASK_INTAKE_INTENT_RE.test(content)) {
    return result({
      route: 'task_intake',
      workflow: 'intake',
      requiresTaskIntake: true,
      reason: 'The request looks like a coding/design execution task.',
      confidence: 0.75,
    })
  }

  if (!content || AMBIGUOUS_RE.test(content)) {
    return result({
      route: 'unknown_or_ambiguous',
      workflow: 'clarify',
      requiresTaskIntake: false,
      needsClarification: true,
      reason: 'The input is too short or context-dependent to classify safely.',
      confidence: 0.45,
    })
  }

  return result({
    route: 'normal_chat',
    workflow: 'chat',
    requiresTaskIntake: false,
    reason: 'No execution-task signal was detected.',
    confidence: 0.7,
  })
}

type ClassifierProvider = {
  id?: unknown
  name?: unknown
  type?: unknown
  baseUrl?: unknown
  apiKey?: unknown
  enabled?: unknown
  defaultModel?: unknown
}

type ResolvedClassifierProvider = ClassifierProvider & {
  id: string
  baseUrl: string
  defaultModel: string
}

function isClassifierProvider(value: unknown): value is ResolvedClassifierProvider {
  if (!value || typeof value !== 'object') return false
  const provider = value as ClassifierProvider
  return (
    typeof provider.id === 'string' &&
    typeof provider.baseUrl === 'string' &&
    typeof provider.defaultModel === 'string' &&
    provider.baseUrl.length > 0 &&
    provider.defaultModel.length > 0 &&
    provider.enabled !== false
  )
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

async function classifierProvider(): Promise<ResolvedClassifierProvider | null> {
  const settings = await loadSettings() as { modelProviders?: unknown } | null
  const providers = Array.isArray(settings?.modelProviders) ? settings.modelProviders.filter(isClassifierProvider) : []
  return providers.find(provider => provider.id !== 'anthropic') ?? null
}

function parseLlmClassifierPayload(text: string): Partial<AvaInputClassifyResult> | null {
  const jsonText = text.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonText) return null
  try {
    const parsed = JSON.parse(jsonText) as Partial<AvaInputClassifyResult>
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function normalizeLlmClassification(
  parsed: Partial<AvaInputClassifyResult> | null,
  ruleResult: AvaInputClassifyResult,
): AvaInputClassifyResult | null {
  if (!parsed || typeof parsed.route !== 'string') return null
  const route = parsed.route as AvaInputRoute
  if (!LLM_CLASSIFIER_ROUTES.has(route)) return null
  const workflow = typeof parsed.workflow === 'string' && LLM_CLASSIFIER_WORKFLOWS.has(parsed.workflow as AvaInputWorkflow)
    ? parsed.workflow as AvaInputWorkflow
    : workflowForRoute(route)
  const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
    ? Math.min(0.95, Math.max(0.05, parsed.confidence))
    : Math.max(0.66, ruleResult.confidence)

  return {
    route,
    workflow,
    requiresTaskIntake: typeof parsed.requiresTaskIntake === 'boolean'
      ? parsed.requiresTaskIntake
      : route === 'task_intake',
    needsClarification: parsed.needsClarification,
    source: 'llm',
    reason: typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : `LLM classifier refined rule route ${ruleResult.route}.`,
    confidence,
  }
}

async function classifyInputWithLlm(
  request: AvaInputClassifyRequest,
  ruleResult: AvaInputClassifyResult,
): Promise<AvaInputClassifyResult | null> {
  const provider = await classifierProvider()
  if (!provider || typeof provider.baseUrl !== 'string' || typeof provider.defaultModel !== 'string') return null

  const attachments = (request.attachments ?? []).map(item => ({
    kind: item.kind ?? 'unknown',
    name: item.name,
    path: item.path,
    url: item.url,
    mimeType: item.mimeType,
  }))
  const prompt = [
    'Classify this Ava user input into exactly one route.',
    'Return only compact JSON with keys: route, workflow, requiresTaskIntake, needsClarification, reason, confidence.',
    `Allowed routes: ${[...LLM_CLASSIFIER_ROUTES].join(', ')}`,
    'Use task_intake only for coding/design execution tasks that need planning.',
    'Use agent_delegation when the user asks to use/delegate to Codex, Claude Code, Cursor, or another code agent.',
    'Use file_or_attachment_input when attachments are central to the request.',
    'Use preference_or_setting when the user asks Ava to remember/default/prefer behavior.',
    '',
    `Text: ${request.content}`,
    `Pending intake: ${Boolean(request.pendingIntake)} stage=${request.pendingIntakeStage ?? 'none'}`,
    `Working directory: ${request.workingDirectory ?? ''}`,
    `Traits: ${(request.traits ?? []).join(', ')}`,
    `Attachments: ${JSON.stringify(attachments)}`,
    `Rule classifier: ${JSON.stringify(ruleResult)}`,
  ].join('\n')

  const response = await fetch(chatCompletionsUrl(provider.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(typeof provider.apiKey === 'string' && provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider.defaultModel,
      temperature: 0,
      max_tokens: 180,
      stream: false,
      messages: [
        { role: 'system', content: 'You are Ava Input Gate. You classify user input for routing. Output JSON only.' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(4000),
  })
  if (!response.ok) return null
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  const text = payload.choices?.[0]?.message?.content ?? ''
  return normalizeLlmClassification(parseLlmClassifierPayload(text), ruleResult)
}

export async function classifyInputWithFallback(request: AvaInputClassifyRequest): Promise<AvaInputClassifyResult> {
  const ruleResult = classifyInput(request)
  if (!shouldUseLlmClassifier(request, ruleResult)) return ruleResult
  try {
    return await classifyInputWithLlm(request, ruleResult) ?? ruleResult
  } catch (err) {
    console.warn('[input-router] LLM classifier fallback failed:', err)
    return ruleResult
  }
}
