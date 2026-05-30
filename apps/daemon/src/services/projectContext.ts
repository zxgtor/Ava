import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ProjectBriefResult {
  tasksDone: number
  tasksTotal: number
  files: string[]
}

export async function getProjectBrief(request: { folderPath?: string }): Promise<ProjectBriefResult | null> {
  const folderPath = request.folderPath?.trim()
  if (!folderPath) return null
  const entries = await readdir(folderPath, { withFileTypes: true })
  const files = entries.map(entry => entry.name)
  let tasksDone = 0
  let tasksTotal = 0
  try {
    const tasksMd = await readFile(join(folderPath, 'TASKS.md'), 'utf8')
    for (const line of tasksMd.split('\n')) {
      if (line.includes('[ ]') || line.includes('[x]')) {
        tasksTotal += 1
        if (line.includes('[x]')) tasksDone += 1
      }
    }
  } catch {
    // TASKS.md is optional project metadata.
  }
  return { tasksDone, tasksTotal, files }
}
