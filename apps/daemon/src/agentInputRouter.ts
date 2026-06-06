import type { AvaInputClassifyRequest, AvaInputClassifyResult, AvaInputRoute, AvaInputWorkflow } from '@ava/contracts'
import { loadSettings } from './storage'

const TASK_EXECUTION_VERB_RE = /\b(build|create|make|generate|implement|scaffold|fix|debug|refactor|modify|update|edit|add|remove|delete)\b|创建|生成|实现|搭建|修复|调试|重构|修改|更新|添加|删除/i
const ENGINEERING_OBJECT_RE = /\b(app|site|website|web\s*app|project|component|page|feature|bug|code|html|css|javascript|typescript|react|vue|svelte|angular|node|npm|vite|three\.?js|webgl|glb|api|server|database|cli|extension|plugin|desktop|electron|build|typecheck|test)\b|网站|应用|项目|组件|页面|功能|代码|接口|服务|插件|桌面|构建|测试|类型检查/i
const LOCAL_EXECUTION_SIGNAL_RE = /\b[A-Z]:\\|\/[A-Za-z0-9_.-]+\/|package\.json|npm\s|pnpm\s|yarn\s|bun\s|git\s|\.tsx?\b|\.jsx?\b|\.py\b|\.css\b|\.html\b/i
const CODE_SCRIPT_RE = /\b(?:python|javascript|typescript|node|bash|shell|powershell|sql)\s+script\b|\bscript\s+(?:in|with)\s+(?:python|javascript|typescript|node|bash|shell|powershell|sql)\b|Python\s*脚本|脚本.*(?:Python|JavaScript|TypeScript|Shell|PowerShell)/i
const WEAK_CREATE_HELP_RE = /\b(create|make|generate|write|draft|help me with|can you help me)\b|创建|生成|写|草拟|帮我|可以帮我/i
const CREATIVE_OR_ADVICE_OBJECT_RE = /\b(video|short video|youtube|reel|script|storyboard|voiceover|narration|story|article|post|presentation|lesson|course|outline|plan|strategy|idea|ideas)\b|视频|短视频|脚本|分镜|旁白|故事|文章|帖子|演示|课程|大纲|计划|策略|想法/i
const VIDEO_CREATION_OBJECT_RE = /\b(short\s*video|video|youtube\s*shorts?|tiktok|reels?|bilibili|storyboard|voiceover|narration|captions?|subtitle|shot\s*list|video\s*script|remotion|sora|runway|kling|veo|pika|video\s+prompts?)\b|短视频|视频|分镜|旁白|字幕|镜头清单|视频脚本|视频提示词/i
const CREATIVE_EXECUTION_VERB_RE = /\b(create|make|generate|write|draft|produce|plan|help me with|can you help me)\b|创建|生成|写|草拟|制作|策划|帮我|可以帮我/i
const AVA_META_QUESTION_RE = /\b(what can ava do|what.*ava.*do|ava.*status|how.*ava|why.*ask|capabilit|check what ava can do|what.*this app.*can do)\b|Ava.*能做|能做什么|检查.*Ava|看看.*Ava|先看看|先了解|为什么.*问/i
const CANCEL_OR_PAUSE_RE = /^\s*(stop|cancel|pause|abort|never mind|not now|先别|不要继续|取消|停止|暂停|算了)\s*[.!。！]*\s*$/i
const RETRY_OR_CONTINUE_RE = /^\s*(retry|try again|continue|resume|go on|继续|重试|再试|接着做)\s*[.!。！]*\s*$/i
const TASK_CONFIRMATION_RE = /^\s*(ok|okay|yes|y|go|start|continue|proceed|confirm|do it|looks good|run|执行|开始|继续|确认|可以|好的|好|没问题|就这样)\s*[.!。！]*\s*$/i
const PERMISSION_RESPONSE_RE = /\b(allow|approve|approved|deny|denied|reject|permission|grant access)\b|允许|同意|批准|拒绝|不同意|授权|权限/i
const REQUIREMENT_CORRECTION_RE = /\b(not what i mean|misunderstood|misunderstand|actually|instead|change|i want to|i need to|first)\b|不是|不对|误解|理解错|我的意思|其实|改成|先看看|先看|先确认/i
const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\b(?:localhost|127\.0\.0\.1):\d+\b/i
const CODE_AGENT_DELEGATION_RE = /\b(delegate|assign|handoff|use|run|start)\b.{0,80}\b(codex|claude code|claude-code|gemini|open code|opencode|openclaw|cursor|code agent|agent)\b|\b(codex|claude code|claude-code|gemini|open code|opencode|openclaw|cursor)\b.{0,80}\b(do|handle|fix|build|create|implement|debug|refactor)\b|交给|委派|分配给|调用.*(codex|claude|gemini|代码代理|agent)/i
const CODE_AGENT_META_QUESTION_RE = /\b(will|would|can|could|does|do|how|when|what)\b.{0,80}\b(ava|you)\b.{0,80}\b(use|pick|select|choose|assign|delegate|route)\b.{0,80}\b(code agent|codex|claude code|claude-code|gemini|opencode|openclaw|agent)\b|\b(ava|you)\b.{0,80}\b(use|pick|select|choose|assign|delegate|route)\b.{0,80}\b(code agent|codex|claude code|claude-code|gemini|opencode|openclaw|agent)\b.*\?|Ava.*(会不会|是否|怎么|什么时候).*(代码代理|codex|claude|gemini|agent)/i
const PREFERENCE_OR_SETTING_RE = /\b(always|never|prefer|preference|setting|settings|remember|default|use .* by default)\b|以后|总是|不要再|偏好|设置|默认|记住/i
const SMALL_TASK_RE = /\b(read|show|get|list|check|tell me|what is|find)\b.{0,80}\b(file|package\.json|name|version|status|info|content|directory|folder)\b|读取|查看|列出|告诉我|是什么|状态|内容|目录/i
const AMBIGUOUS_RE = /^\s*(this|that|it|这个|那个|它|看看|继续刚才|刚才那个)\s*$/i
const ADVICE_QUESTION_RE = /\b(how to|how do i|what should|can you explain|help me understand|what is the best way)\b|如何|怎么|怎样|什么是|解释/i

function hasStrongTaskIntent(content: string): boolean {
  if (/\b(fix|debug|refactor)\b|修复|调试|重构/i.test(content)) return true
  if (!TASK_EXECUTION_VERB_RE.test(content)) return false
  return ENGINEERING_OBJECT_RE.test(content) || LOCAL_EXECUTION_SIGNAL_RE.test(content) || CODE_SCRIPT_RE.test(content)
}

function hasExplicitExecutionRequest(content: string): boolean {
  return hasStrongTaskIntent(content) && !ADVICE_QUESTION_RE.test(content)
}

function hasWeakCreateOrAdviceSignal(content: string): boolean {
  return WEAK_CREATE_HELP_RE.test(content) || CREATIVE_OR_ADVICE_OBJECT_RE.test(content)
}

function hasVideoCreationIntent(content: string): boolean {
  if (ADVICE_QUESTION_RE.test(content) && !/\b(write|draft|create|make|generate|produce)\b|写|创建|生成|制作/i.test(content)) return false
  return VIDEO_CREATION_OBJECT_RE.test(content) && CREATIVE_EXECUTION_VERB_RE.test(content)
}

function isWeakCreateRuleResult(result: AvaInputClassifyResult): boolean {
  return result.source === 'rule'
    && result.route === 'normal_chat'
    && result.confidence < 0.65
    && /weak create\/help signal/i.test(result.reason ?? '')
}

function isHardPrecheckResult(request: AvaInputClassifyRequest, ruleResult: AvaInputClassifyResult): boolean {
  if (request.pendingIntake || request.hasCommandInvocation) return true
  switch (ruleResult.route) {
    case 'cancel_or_pause':
    case 'permission_response':
    case 'retry_or_continue':
    case 'file_or_attachment_input':
    case 'url_input':
    case 'preference_or_setting':
      return true
    case 'meta_question':
      return AVA_META_QUESTION_RE.test(request.content) || CODE_AGENT_META_QUESTION_RE.test(request.content)
    case 'agent_delegation':
      return CODE_AGENT_DELEGATION_RE.test(request.content)
    case 'small_task':
      return true
    default:
      return false
  }
}

function normalizeFinalClassification(candidate: AvaInputClassifyResult): AvaInputClassifyResult {
  const workflow = workflowForRoute(candidate.route)
  return {
    ...candidate,
    workflow,
    requiresTaskIntake: candidate.route === 'task_intake',
  }
}

function postcheckClassification(
  request: AvaInputClassifyRequest,
  candidate: AvaInputClassifyResult,
  ruleResult: AvaInputClassifyResult,
): AvaInputClassifyResult {
  const content = request.content.trim()

  if (
    candidate.route === 'task_intake'
    && !request.hasCommandInvocation
    && !hasExplicitExecutionRequest(content)
  ) {
    const route: AvaInputRoute = hasVideoCreationIntent(content)
      ? 'video_creation'
      : hasWeakCreateOrAdviceSignal(content)
        ? 'normal_chat'
        : 'unknown_or_ambiguous'
    return normalizeFinalClassification({
      ...candidate,
      route,
      requiresTaskIntake: false,
      needsClarification: route === 'unknown_or_ambiguous' ? true : undefined,
      reason: `${candidate.reason} Postcheck blocked task_intake because the input does not contain an explicit code/project/file/tool execution target.`,
      confidence: Math.min(candidate.confidence, 0.64),
    })
  }

  if (candidate.route === 'agent_delegation' && CODE_AGENT_META_QUESTION_RE.test(content)) {
    return normalizeFinalClassification({
      ...candidate,
      route: 'meta_question',
      requiresTaskIntake: false,
      reason: `${candidate.reason} Postcheck changed agent_delegation to meta_question because the user is asking about code-agent behavior.`,
      confidence: Math.min(candidate.confidence, 0.86),
    })
  }

  if (candidate.route === 'agent_delegation' && !CODE_AGENT_DELEGATION_RE.test(content)) {
    return normalizeFinalClassification({
      ...candidate,
      route: 'normal_chat',
      requiresTaskIntake: false,
      reason: `${candidate.reason} Postcheck blocked agent_delegation because the input does not explicitly ask Ava to use or assign a code agent.`,
      confidence: Math.min(candidate.confidence, 0.64),
    })
  }

  if (candidate.route === 'video_creation' && !hasVideoCreationIntent(content)) {
    return normalizeFinalClassification({
      ...candidate,
      route: 'normal_chat',
      requiresTaskIntake: false,
      reason: `${candidate.reason} Postcheck blocked video_creation because the user is not explicitly asking Ava to create or draft video assets.`,
      confidence: Math.min(candidate.confidence, 0.64),
    })
  }

  if (
    (candidate.route === 'task_confirmation' || candidate.route === 'continue_intake' || candidate.route === 'requirement_correction')
    && !request.pendingIntake
  ) {
    return normalizeFinalClassification({
      ...candidate,
      route: 'normal_chat',
      requiresTaskIntake: false,
      reason: `${candidate.reason} Postcheck blocked intake-only route because no intake session is pending.`,
      confidence: Math.min(candidate.confidence, 0.64),
    })
  }

  if (
    ruleResult.route === 'task_intake'
    && candidate.route !== 'task_intake'
    && hasExplicitExecutionRequest(content)
    && (LOCAL_EXECUTION_SIGNAL_RE.test(content) || request.workingDirectory || /\b(fix|debug|refactor)\b|修复|调试|重构/i.test(content))
  ) {
    return normalizeFinalClassification({
      ...ruleResult,
      reason: `${ruleResult.reason} Postcheck kept task_intake because the input has explicit local execution evidence.`,
      confidence: Math.max(ruleResult.confidence, 0.82),
    })
  }

  if (
    ruleResult.route === 'video_creation'
    && candidate.route !== 'video_creation'
    && hasVideoCreationIntent(content)
  ) {
    return normalizeFinalClassification({
      ...ruleResult,
      reason: `${ruleResult.reason} Postcheck kept video_creation because the input explicitly asks Ava to create short-form video assets.`,
      confidence: Math.max(ruleResult.confidence, 0.82),
    })
  }

  return normalizeFinalClassification(candidate)
}

function withTrace(
  finalResult: AvaInputClassifyResult,
  ruleResult: AvaInputClassifyResult,
  llmResult: AvaInputClassifyResult | null,
  hardPrecheck: boolean,
): AvaInputClassifyResult {
  const candidate = llmResult ?? ruleResult
  return {
    ...finalResult,
    trace: {
      hardPrecheck,
      ruleRoute: ruleResult.route,
      llmRoute: llmResult?.route,
      finalRoute: finalResult.route,
      postcheckApplied: finalResult.route !== candidate.route || finalResult.workflow !== candidate.workflow || finalResult.reason !== candidate.reason,
    },
  }
}

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
  'creative_content',
  'video_creation',
  'new_capability_needed',
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
  'creative',
  'video_creation',
  'capability_gap',
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
    case 'creative_content':
      return 'creative'
    case 'video_creation':
      return 'video_creation'
    case 'new_capability_needed':
      return 'capability_gap'
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
  if (isHardPrecheckResult(request, ruleResult)) return false
  if (hasMultiInput(request)) return true
  return true
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

  if (CODE_AGENT_META_QUESTION_RE.test(content)) {
    return result({
      route: 'meta_question',
      workflow: 'chat',
      requiresTaskIntake: false,
      reason: 'The user is asking about Ava code-agent routing behavior, not requesting delegation.',
      confidence: 0.86,
    })
  }

  if (CODE_AGENT_DELEGATION_RE.test(content)) {
    return result({
      route: 'agent_delegation',
      workflow: 'delegation',
      requiresTaskIntake: false,
      reason: 'The user appears to be asking Ava to delegate work to a code agent such as Codex, Claude Code, or Gemini CLI.',
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

  if (hasVideoCreationIntent(content)) {
    return result({
      route: 'video_creation',
      workflow: 'video_creation',
      requiresTaskIntake: false,
      reason: 'The user is asking Ava to help create short-form video assets such as script, storyboard, voiceover, captions, or production plan.',
      confidence: 0.78,
    })
  }

  if (SMALL_TASK_RE.test(content) && !hasStrongTaskIntent(content)) {
    return result({
      route: 'small_task',
      workflow: 'direct_tool',
      requiresTaskIntake: false,
      reason: 'The request looks like a small direct tool task and does not need full task intake.',
      confidence: 0.72,
    })
  }

  if (hasStrongTaskIntent(content)) {
    return result({
      route: 'task_intake',
      workflow: 'intake',
      requiresTaskIntake: true,
      reason: 'The request has both an execution verb and an engineering/project target.',
      confidence: 0.78,
    })
  }

  if (hasWeakCreateOrAdviceSignal(content)) {
    return result({
      route: 'normal_chat',
      workflow: 'chat',
      requiresTaskIntake: false,
      reason: 'The request has a weak create/help signal but no explicit coding project, local file, tool, or execution target.',
      confidence: 0.52,
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
  if (route === 'task_intake' && isWeakCreateRuleResult(ruleResult)) {
    return {
      ...ruleResult,
      reason: `${ruleResult.reason} LLM classifier attempted to upgrade it to task_intake, but Ava requires an explicit code/project/file/tool target for task intake.`,
    }
  }
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
    'Do not use task_intake just because the user says create, make, generate, or write.',
    'Use task_intake only when the user asks Ava to create/modify/debug a code project, local files, app/site/component, or execute tools.',
    'If the user asks for creative help, advice, script/storyboard/video planning, or "can you help me", classify as normal_chat unless they explicitly ask to create files/projects or use tools.',
    'Use video_creation when the user asks Ava to create, draft, plan, or produce a short video, video script, storyboard, voiceover, captions, or shot list.',
    'Use creative_content for non-video creative production such as posts, articles, stories, outlines, or presentations.',
    'If no existing workflow fits and execution is implied but capability is missing, prefer unknown_or_ambiguous with needsClarification=true and explain the missing capability.',
    'Use agent_delegation when the user asks to use/delegate to Codex, Claude Code, Gemini CLI, Cursor, or another code agent.',
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
      max_tokens: 240,
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
  const hardPrecheck = isHardPrecheckResult(request, ruleResult)
  if (!shouldUseLlmClassifier(request, ruleResult)) {
    return withTrace(postcheckClassification(request, ruleResult, ruleResult), ruleResult, null, hardPrecheck)
  }
  try {
    const llmResult = await classifyInputWithLlm(request, ruleResult)
    return withTrace(postcheckClassification(request, llmResult ?? ruleResult, ruleResult), ruleResult, llmResult, hardPrecheck)
  } catch (err) {
    console.warn('[input-router] LLM classifier fallback failed:', err)
    return withTrace(postcheckClassification(request, ruleResult, ruleResult), ruleResult, null, hardPrecheck)
  }
}
