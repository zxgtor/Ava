import type {
  AvaActionPreview,
  AvaInputClassifyResult,
  AvaInputDispatchRequest,
  AvaInputDispatchResult,
  AvaWorkflowAction,
  AvaWorkflowImplementationStatus,
} from '@ava/contracts'
import { classifyInputWithFallback } from './agentInputRouter'

const IMPLEMENTED_ACTIONS = new Set<AvaWorkflowAction>([
  'run_chat',
  'start_task_intake',
  'continue_intake',
  'confirm_task',
  'reanalyze_intake',
  'cancel_intake',
  'recover_task',
  'handle_permission',
  'run_direct_tool',
  'handle_file_media',
  'handle_url',
  'delegate_to_code_agent',
  'update_preference',
  'start_video_creation',
  'ask_clarifying_question',
])

function actionForRoute(classification: AvaInputClassifyResult): AvaWorkflowAction {
  switch (classification.route) {
    case 'task_intake':
      return 'start_task_intake'
    case 'continue_intake':
      return 'continue_intake'
    case 'task_confirmation':
      return 'confirm_task'
    case 'requirement_correction':
      return 'reanalyze_intake'
    case 'cancel_or_pause':
      return 'cancel_intake'
    case 'retry_or_continue':
      return 'recover_task'
    case 'permission_response':
      return 'handle_permission'
    case 'small_task':
      return 'run_direct_tool'
    case 'file_or_attachment_input':
      return 'handle_file_media'
    case 'url_input':
      return 'handle_url'
    case 'agent_delegation':
      return 'delegate_to_code_agent'
    case 'preference_or_setting':
      return 'update_preference'
    case 'video_creation':
      return 'start_video_creation'
    case 'new_capability_needed':
      return 'ask_clarifying_question'
    case 'unknown_or_ambiguous':
      return 'ask_clarifying_question'
    case 'normal_chat':
    case 'meta_question':
    default:
      return 'run_chat'
  }
}

function implementationStatus(action: AvaWorkflowAction): AvaWorkflowImplementationStatus {
  return IMPLEMENTED_ACTIONS.has(action) ? 'implemented' : 'planned'
}

function previewForAction(
  action: AvaWorkflowAction,
  request: AvaInputDispatchRequest,
  classification: AvaInputClassifyResult,
): AvaActionPreview | undefined {
  const firstLine = request.content.trim().split(/\r?\n/)[0] || 'the request'
  const shortGoal = firstLine.length > 150 ? `${firstLine.slice(0, 150)}...` : firstLine
  const workspace = request.workingDirectory ? `\n工作目录：${request.workingDirectory}` : ''

  switch (action) {
    case 'start_task_intake':
      return {
        requiresConfirmation: false,
        text: [
          '我先确认一下我的理解：这是一个需要拆分和执行的任务。',
          `目标：${shortGoal}${workspace}`,
          '我会先分析需求和缺失信息；如果信息足够，再生成小步骤计划并开始执行。',
        ].join('\n'),
      }
    case 'continue_intake':
      return {
        requiresConfirmation: false,
        text: '我会把你的回复记录到当前需求澄清流程里，然后判断是否还需要继续提问或生成 summary。',
      }
    case 'confirm_task':
      return {
        requiresConfirmation: false,
        text: '我已收到确认。接下来会基于已确认的需求生成执行计划，并按步骤推进任务。',
      }
    case 'reanalyze_intake':
      return {
        requiresConfirmation: false,
        text: '我理解你在修正前面的需求。我会重新分析目标，更新 summary，而不是继续执行旧理解。',
      }
    case 'cancel_intake':
      return {
        requiresConfirmation: false,
        text: '我会停止当前需求澄清或执行流程，不继续旧任务。',
      }
    case 'recover_task':
      return {
        requiresConfirmation: false,
        text: '我会从当前任务状态继续或重试，先复用已有文件和执行进度，不从头开始。',
      }
    case 'handle_permission':
      return {
        requiresConfirmation: false,
        text: '我会按你的权限回复处理上一个被阻塞的操作；如果是允许，就只继续之前被权限挡住的那一步。',
      }
    case 'run_direct_tool':
      return {
        requiresConfirmation: false,
        text: [
          '我理解这是一个小任务，不需要完整计划。',
          `目标：${shortGoal}${workspace}`,
          '我会直接调用最小必要工具，然后基于工具结果回答。',
        ].join('\n'),
      }
    case 'handle_file_media':
      return {
        requiresConfirmation: false,
        text: '我会把你提供的文件或附件作为主要输入，先检查可读取内容，再回答或继续处理。',
      }
    case 'handle_url':
      return {
        requiresConfirmation: false,
        text: '我会先判断这个 URL 是本地预览、远程页面还是错误诊断对象，再选择打开、检查控制台、截图或说明限制。',
      }
    case 'delegate_to_code_agent':
      return {
        requiresConfirmation: false,
        text: '我会先识别你想使用的代码代理，并检查本机是否可用；如果可用再把任务路由给对应代理。',
      }
    case 'update_preference':
      return {
        requiresConfirmation: false,
        text: '我会把这条输入当作偏好或设置处理，先判断是当前会话生效、已有设置可保存，还是需要新增设置能力。',
      }
    case 'start_video_creation':
      return {
        requiresConfirmation: false,
        text: [
          '我会按短视频创作流程处理，不会直接启动代码项目或生成视频文件。',
          `主题：${shortGoal}`,
          '我会先确认平台、时长、风格和输出目标；信息足够时生成脚本、分镜、旁白、字幕和素材清单。',
        ].join('\n'),
      }
    case 'ask_clarifying_question':
      return {
        requiresConfirmation: false,
        text: '我还不能安全判断你要执行哪个任务，会先问一个具体问题来缩小范围。',
      }
    case 'run_chat':
    default:
      return classification.route === 'normal_chat' || classification.route === 'meta_question'
        ? undefined
        : {
            requiresConfirmation: false,
            text: `我会按 ${classification.workflow} 流程处理这条输入。`,
          }
  }
}

export async function dispatchInput(request: AvaInputDispatchRequest): Promise<AvaInputDispatchResult> {
  const classification = await classifyInputWithFallback(request)
  const action = actionForRoute(classification)
  const status = implementationStatus(action)

  return {
    classification,
    action,
    workflow: classification.workflow,
    status,
    fallbackAction: status === 'planned' ? 'run_chat' : undefined,
    actionPreview: previewForAction(action, request, classification),
    reason: status === 'implemented'
      ? `Workflow dispatcher selected ${action}.`
      : `Workflow dispatcher selected ${action}, but that workflow is not implemented yet; client should safely fall back to chat.`,
  }
}
