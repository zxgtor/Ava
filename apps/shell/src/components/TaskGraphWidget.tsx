import React, { useMemo } from 'react'
import { Check, Clock, AlertTriangle, Loader2, GitBranch, ArrowRight, XCircle } from 'lucide-react'
import type { TaskExecutionPlan, TaskExecutionStep } from '../types'
import { getNodesByLayer } from '../lib/agent/taskExecution'
import { useStore } from '../store'

interface Props {
  plan: TaskExecutionPlan
}

function StatusIcon({ status }: { status: TaskExecutionStep['status'] }) {
  switch (status) {
    case 'done':
      return <Check size={14} className="text-emerald-500" />
    case 'running':
      return <Loader2 size={14} className="text-accent animate-spin" />
    case 'failed':
      return <AlertTriangle size={14} className="text-error" />
    case 'skipped':
      return <ArrowRight size={14} className="text-text-3" />
    case 'pending':
    default:
      return <Clock size={14} className="text-text-3" />
  }
}

function WorkflowBadge({ type }: { type?: string }) {
  let bg = 'bg-surface-2 text-text-3'
  let label = type || 'feature'
  
  if (type === 'scaffold') bg = 'bg-blue-500/20 text-blue-400'
  else if (type === 'debug') bg = 'bg-amber-500/20 text-amber-400'
  else if (type === 'refactor') bg = 'bg-purple-500/20 text-purple-400'
  else if (type === 'research') bg = 'bg-teal-500/20 text-teal-400'
  
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-sm uppercase tracking-wider font-semibold ${bg}`}>
      {label}
    </span>
  )
}

export function TaskGraphWidget({ plan }: Props) {
  const layers = useMemo(() => getNodesByLayer(plan), [plan])
  const { activeConversation, dispatch } = useStore()

  const handleAbort = () => {
    if (activeConversation) {
      dispatch({ type: 'ABORT_TASK_PLAN', conversationId: activeConversation.id })
    }
  }

  const isTerminal = plan.status === 'completed' || plan.status === 'aborted' || plan.status === 'failed'

  return (
    <div className="w-full bg-surface-1 border-b border-border/40 overflow-hidden shadow-sm shadow-black/10 z-30 transition-all duration-300 relative">
      {/* Subtle top progress bar */}
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-surface-2">
        <div 
          className="h-full bg-accent transition-all duration-500" 
          style={{ 
            width: `${(plan.steps.filter(s => s.status === 'done' || s.status === 'skipped').length / plan.steps.length) * 100}%` 
          }} 
        />
      </div>

      <div className="px-6 py-4 flex flex-col gap-4 max-h-[300px] overflow-y-auto custom-scrollbar">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-text-2 font-semibold text-sm truncate">
            <GitBranch size={16} className="text-accent shrink-0" />
            <span className="truncate">Agent OS Plan: {plan.goal}</span>
          </div>
          {!isTerminal && (
            <button 
              onClick={handleAbort}
              className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-error hover:bg-error/10 border border-transparent hover:border-error/20 rounded transition-colors shrink-0"
            >
              <XCircle size={12} />
              Abort Plan
            </button>
          )}
        </div>
        
        <div className="flex flex-col gap-6">
          {layers.map((layer, layerIdx) => (
            <div key={layerIdx} className="flex items-start gap-4 relative">
              {/* Connector line from previous layer */}
              {layerIdx > 0 && (
                <div className="absolute -top-6 left-[18px] w-0.5 h-6 bg-border/50" />
              )}
              
              {/* Layer Nodes */}
              <div className="flex flex-wrap gap-4 w-full relative z-10">
                {layer.map(step => {
                  const isActive = step.status === 'running'
                  const isFailed = step.status === 'failed'
                  const isDone = step.status === 'done'
                  
                  return (
                    <div 
                      key={step.id}
                      className={`
                        flex flex-col p-3 rounded-lg border min-w-[200px] flex-1 max-w-[320px] shadow-sm transition-colors duration-300
                        ${isActive ? 'border-accent/50 bg-accent/5' : ''}
                        ${isFailed ? 'border-error/50 bg-error/5' : ''}
                        ${isDone ? 'border-emerald-500/20 bg-surface-2/50 opacity-70' : ''}
                        ${step.status === 'pending' ? 'border-border/60 bg-surface-1 opacity-60' : ''}
                      `}
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <StatusIcon status={step.status} />
                          <span className="text-xs font-semibold text-text">{step.title}</span>
                        </div>
                        <WorkflowBadge type={step.workflowType} />
                      </div>
                      
                      {/* Dependencies pill */}
                      {step.dependsOn && step.dependsOn.length > 0 && (
                        <div className="text-[10px] text-text-3 mt-1 flex gap-1 flex-wrap">
                          <span className="opacity-70">Depends on:</span>
                          {step.dependsOn.map(dep => (
                            <span key={dep} className="px-1 rounded bg-black/20 font-mono tracking-tight">{dep}</span>
                          ))}
                        </div>
                      )}

                      {/* Error message */}
                      {step.lastError && (
                        <div className="mt-2 text-[10px] text-error/90 bg-error/10 p-1.5 rounded line-clamp-2">
                          {step.lastError}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
