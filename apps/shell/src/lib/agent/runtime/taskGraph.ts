import type { TaskExecutionPlan, TaskExecutionStep } from '../../../types'

export class TaskGraph {
  private plan: TaskExecutionPlan

  constructor(plan: TaskExecutionPlan) {
    this.plan = plan
  }

  getPlan(): TaskExecutionPlan {
    return this.plan
  }

  // Topological sort to find the next executable step
  getNextStep(): TaskExecutionStep | null {
    if (this.plan.status === 'completed' || this.plan.status === 'aborted') return null

    const allSteps = this.plan.steps
    
    // Find a step that is pending/failed/running and all its dependencies are done
    for (const step of allSteps) {
      if (step.status === 'pending' || step.status === 'failed' || step.status === 'running') {
        const dependencies = step.dependsOn || []
        const canRun = dependencies.every(depId => {
          const depStep = allSteps.find(s => s.id === depId)
          return depStep?.status === 'done' || depStep?.status === 'skipped'
        })
        
        if (canRun) {
          return step
        }
      }
    }
    
    return null
  }

  markStepStatus(stepId: string, status: TaskExecutionStep['status'], error?: string) {
    const step = this.plan.steps.find(s => s.id === stepId)
    if (step) {
      step.status = status
      if (error) step.lastError = error
      if (status === 'running') step.attempts += 1
    }
    this.plan.updatedAt = Date.now()
  }

  // Dynamic decompose: Replaces a step with a sub-DAG
  decomposeStep(stepId: string, subSteps: TaskExecutionStep[]) {
    const stepIndex = this.plan.steps.findIndex(s => s.id === stepId)
    if (stepIndex === -1) return

    const originalStep = this.plan.steps[stepIndex]
    
    // Update dependencies of subSteps to ensure they run sequentially or respect the original dependencies
    subSteps.forEach(sub => {
      sub.dependsOn = [...(sub.dependsOn || []), ...(originalStep.dependsOn || [])]
    })

    // Remove original step, insert new steps
    this.plan.steps.splice(stepIndex, 1, ...subSteps)
    
    // Update other steps that depended on the original step to depend on the last subStep(s)
    const newLeafNodes = subSteps.filter(sub => !subSteps.some(s => s.dependsOn?.includes(sub.id)))
    
    this.plan.steps.forEach(s => {
      if (s.dependsOn?.includes(stepId)) {
        s.dependsOn = s.dependsOn.filter(d => d !== stepId)
        s.dependsOn.push(...newLeafNodes.map(l => l.id))
      }
    })
    
    this.plan.updatedAt = Date.now()
  }

  // Insert a new step before a failed step (e.g., to install dependencies)
  replanInsertBefore(failedStepId: string, newStep: TaskExecutionStep) {
    const stepIndex = this.plan.steps.findIndex(s => s.id === failedStepId)
    if (stepIndex === -1) return
    
    const failedStep = this.plan.steps[stepIndex]
    
    // New step inherits the failed step's dependencies
    newStep.dependsOn = [...(failedStep.dependsOn || [])]
    
    // Failed step now depends on the new step
    failedStep.dependsOn = [newStep.id]
    
    // Reset failed step to pending so it can run again after the new step
    failedStep.status = 'pending'
    failedStep.lastError = undefined
    failedStep.attempts = 0

    this.plan.steps.splice(stepIndex, 0, newStep)
    this.plan.updatedAt = Date.now()
  }
}
