import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runtimePaths } from './runtimePaths'

export interface CapabilityStatsRecord {
  capabilityId: string
  kind: 'built_in_tool' | 'mcp_tool' | 'skill'
  selectedCount: number
  injectedCount: number
  usedCount: number
  successCount: number
  failureCount: number
  loopCount: number
  lastUsedAt: number
  scoreAdjustment: number
}

export interface CapabilityRouteLogEntry {
  streamId: string
  taskId?: string
  activeStepRole?: string
  totalCapabilities: number
  selectedSkills: Array<{ id: string; name: string; score: number; reasons: string[] }>
  selectedMcpTools: Array<{ id: string; name: string; score: number; reasons: string[] }>
  createdAt: number
}

type StatsMap = Record<string, CapabilityStatsRecord>

class CapabilityStatsStore {
  private loaded = false
  private stats: StatsMap = {}

  async recordSelection(items: Array<{ id: string; kind: CapabilityStatsRecord['kind']; injected?: boolean }>): Promise<void> {
    if (items.length === 0) return
    await this.load()
    const now = Date.now()
    for (const item of items) {
      const record = this.recordFor(item.id, item.kind)
      record.selectedCount += 1
      if (item.injected) record.injectedCount += 1
      record.lastUsedAt = now
    }
    await this.save()
  }

  async recordUse(input: {
    id: string
    kind: CapabilityStatsRecord['kind']
    success: boolean
    loop?: boolean
  }): Promise<void> {
    await this.load()
    const record = this.recordFor(input.id, input.kind)
    record.usedCount += 1
    if (input.success) record.successCount += 1
    else record.failureCount += 1
    if (input.loop) record.loopCount += 1
    record.scoreAdjustment = Math.max(-20, Math.min(20, record.successCount - record.failureCount - record.loopCount * 2))
    record.lastUsedAt = Date.now()
    await this.save()
  }

  async appendRouteLog(entry: CapabilityRouteLogEntry): Promise<void> {
    try {
      const path = routeLogPath()
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (err) {
      console.warn('[capability-router] failed to append route log:', err)
    }
  }

  private recordFor(id: string, kind: CapabilityStatsRecord['kind']): CapabilityStatsRecord {
    const existing = this.stats[id]
    if (existing) return existing
    const created: CapabilityStatsRecord = {
      capabilityId: id,
      kind,
      selectedCount: 0,
      injectedCount: 0,
      usedCount: 0,
      successCount: 0,
      failureCount: 0,
      loopCount: 0,
      lastUsedAt: 0,
      scoreAdjustment: 0,
    }
    this.stats[id] = created
    return created
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const path = statsPath()
    if (!existsSync(path)) return
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object') this.stats = parsed as StatsMap
    } catch (err) {
      console.warn('[capability-router] failed to read stats:', err)
    }
  }

  private async save(): Promise<void> {
    try {
      const path = statsPath()
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify(this.stats, null, 2)}\n`, 'utf8')
    } catch (err) {
      console.warn('[capability-router] failed to save stats:', err)
    }
  }
}

function statsPath(): string {
  return join(runtimePaths().userDataPath, 'capability_stats.json')
}

function routeLogPath(): string {
  return join(runtimePaths().userDataPath, 'capability-routing-log.jsonl')
}

export const capabilityStats = new CapabilityStatsStore()
