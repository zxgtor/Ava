import type {
  AvaInputClassifyResult,
  AvaInputDispatchRequest,
  AvaInputDispatchResult,
  AvaWorkflowAction,
  AvaWorkflowImplementationStatus,
} from '@ava/contracts'
import { classifyInput } from './agentInputRouter'

const IMPLEMENTED_ACTIONS = new Set<AvaWorkflowAction>([
  'run_chat',
  'start_task_intake',
  'continue_intake',
  'confirm_task',
  'reanalyze_intake',
  'cancel_intake',
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
    case 'preference_or_setting':
      return 'update_preference'
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

export function dispatchInput(request: AvaInputDispatchRequest): AvaInputDispatchResult {
  const classification = classifyInput(request)
  const action = actionForRoute(classification)
  const status = implementationStatus(action)

  return {
    classification,
    action,
    workflow: classification.workflow,
    status,
    fallbackAction: status === 'planned' ? 'run_chat' : undefined,
    reason: status === 'implemented'
      ? `Workflow dispatcher selected ${action}.`
      : `Workflow dispatcher selected ${action}, but that workflow is not implemented yet; client should safely fall back to chat.`,
  }
}
