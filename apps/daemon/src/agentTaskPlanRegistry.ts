import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TaskExecutionPlan } from '@ava/contracts'
import { userDataFile } from './services/runtimePaths'

type StoredTaskPlans = {
  version: 1
  plans: Array<{
    conversationId: string
    plan: TaskExecutionPlan
  }>
}

const STORE_FILE = 'active-task-plans.json'

let loaded = false
let plans = new Map<string, TaskExecutionPlan>()

function storePath(): string {
  return userDataFile(STORE_FILE)
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as Partial<StoredTaskPlans>
    if (!Array.isArray(raw.plans)) return
    plans = new Map(
      raw.plans
        .filter(item => typeof item?.conversationId === 'string' && Boolean(item.plan))
        .map(item => [item.conversationId, item.plan as TaskExecutionPlan]),
    )
  } catch {
    plans = new Map()
  }
}

function persist(): void {
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  const payload: StoredTaskPlans = {
    version: 1,
    plans: [...plans.entries()].map(([conversationId, plan]) => ({ conversationId, plan })),
  }
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

export function getActiveTaskPlan(conversationId: string): TaskExecutionPlan | undefined {
  load()
  return plans.get(conversationId)
}

export function setActiveTaskPlan(conversationId: string, plan: TaskExecutionPlan): TaskExecutionPlan {
  load()
  const next = { ...plan, updatedAt: Date.now() }
  plans.set(conversationId, next)
  persist()
  return next
}

export function clearActiveTaskPlan(conversationId: string): boolean {
  load()
  const existed = plans.delete(conversationId)
  if (existed) persist()
  return existed
}

export function snapshotActiveTaskPlans(): Array<{ conversationId: string; plan: TaskExecutionPlan }> {
  load()
  return [...plans.entries()].map(([conversationId, plan]) => ({ conversationId, plan }))
}
