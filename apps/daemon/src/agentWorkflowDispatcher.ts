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

function hasExplicitVideoAssetSaveRequest(content: string): boolean {
  return /\b(save|write|export|create files?|generate files?|put (?:it|them) (?:in|under)|to files?|as files?|folder|directory)\b|保存|写入|导出|生成文件|创建文件|放到|目录|文件夹/i.test(content)
}

function videoOutputTargetFor(content: string): string {
  if (hasExplicitVideoAssetSaveRequest(content)) return 'file_assets'
  if (/\b(remotion|editable\s+video|react\s+video|video\s+project)\b|可编辑视频|视频项目/i.test(content)) return 'remotion_project'
  if (/\b(sora|runway|kling|veo|pika|video\s+prompts?|ai\s+video\s+prompt)\b|视频提示词|生成视频提示词/i.test(content)) return 'video_prompts'
  if (/\b(tts|voiceover|narration|audio|mp3|wav|spoken)\b|旁白|配音|音频|语音/i.test(content)) return 'tts_voiceover'
  return 'chat_draft'
}

function videoOutputTargetLabel(target: string): string {
  switch (target) {
    case 'file_assets': return '保存为脚本/分镜/字幕/提示词文件'
    case 'remotion_project': return '准备 Remotion 可编辑视频项目'
    case 'video_prompts': return '生成 Sora/Runway/Kling/Veo 视频提示词'
    case 'tts_voiceover': return '生成 TTS/旁白素材'
    case 'chat_draft':
    default: return '先在聊天里生成 V1 草稿'
  }
}

function videoOutputTargetPlan(target: string): string {
  switch (target) {
    case 'file_assets':
      return '如果你给了目录，Ava 会写入脚本、分镜、字幕、提示词和制作说明文件；没给目录会先问目录。'
    case 'remotion_project':
      return '如果你给了目标目录，Ava 会创建 Remotion 项目结构并写入初版 composition；没给目录会先问目录。'
    case 'video_prompts':
      return 'Ava 会生成适合 Sora/Runway/Kling/Veo 等工具的镜头级视频提示词。'
    case 'tts_voiceover':
      return 'Ava 会生成旁白-ready 文本；使用语音工具前会先确认。'
    case 'chat_draft':
    default:
      return 'Ava 会先在聊天里给出脚本、分镜、字幕和素材清单草稿。'
  }
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
    case 'start_video_creation': {
      const videoTarget = videoOutputTargetFor(request.content)
      return {
        requiresConfirmation: false,
        text: [
          '我会按短视频创作流程处理，不会直接启动代码项目或生成视频文件。',
          `主题：${shortGoal}`,
          `输出路径：${videoOutputTargetLabel(videoTarget)}`,
          videoOutputTargetPlan(videoTarget),
        ].join('\n'),
      }
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
