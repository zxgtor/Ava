import type { AvaInputClassifyRequest, AvaInputClassifyResult } from '@ava/contracts'

const TASK_INTAKE_INTENT_RE = /\b(build|create|make|generate|implement|fix|debug|refactor|modify|update|edit|write|add|remove|delete|site|app|component|page|feature|bug|code|html|css|javascript|typescript|react|three\.?js|3d)\b|创建|生成|实现|修复|调试|重构|修改|更新|添加|删除|网站|应用|组件|页面|功能|代码|三维|3d/i
const AVA_META_QUESTION_RE = /\b(what can ava do|what.*ava.*do|ava.*status|how.*ava|why.*ask|capabilit|check what ava can do|what.*this app.*can do)\b|Ava.*能做|能做什么|检查.*Ava|看看.*Ava|先看看|先了解|为什么.*问/i
const CANCEL_OR_PAUSE_RE = /^\s*(stop|cancel|pause|abort|never mind|not now|先别|不要继续|取消|停止|暂停|算了)\s*[.!。！]*\s*$/i
const RETRY_OR_CONTINUE_RE = /^\s*(retry|try again|continue|resume|go on|继续|重试|再试|接着做)\s*[.!。！]*\s*$/i
const TASK_CONFIRMATION_RE = /^\s*(ok|okay|yes|y|go|start|continue|proceed|confirm|do it|looks good|run|执行|开始|继续|确认|可以|好的|好|没问题|就这样)\s*[.!。！]*\s*$/i
const PERMISSION_RESPONSE_RE = /\b(allow|approve|approved|deny|denied|reject|permission|grant access)\b|允许|同意|批准|拒绝|不同意|授权|权限/i
const REQUIREMENT_CORRECTION_RE = /\b(not what i mean|misunderstood|misunderstand|actually|instead|change|i want to|i need to|first)\b|不是|不对|误解|理解错|我的意思|其实|改成|先看看|先看|先确认/i
const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\b(?:localhost|127\.0\.0\.1):\d+\b/i
const PREFERENCE_OR_SETTING_RE = /\b(always|never|prefer|preference|setting|settings|remember|default|use .* by default)\b|以后|总是|不要再|偏好|设置|默认|记住/i
const SMALL_TASK_RE = /\b(read|show|get|list|check|tell me|what is|find)\b.{0,80}\b(file|package\.json|name|version|status|info|content|directory|folder)\b|读取|查看|列出|告诉我|是什么|状态|内容|目录/i
const AMBIGUOUS_RE = /^\s*(this|that|it|这个|那个|它|看看|继续刚才|刚才那个)\s*$/i

function result(input: Omit<AvaInputClassifyResult, 'source'>): AvaInputClassifyResult {
  return { source: 'rule', ...input }
}

function hasAttachments(request: AvaInputClassifyRequest): boolean {
  return Boolean(request.attachments?.length)
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
