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
}
