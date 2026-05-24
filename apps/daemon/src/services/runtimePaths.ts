import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BUNDLED_DIR = 'plugins'
const USER_DIR = 'user-plugins'

export interface RuntimePaths {
  appPath: string
  resourcesPath: string
  userDataPath: string
  projectRoot: string
  isPackaged: boolean
}

let configuredPaths: Partial<RuntimePaths> = {}

export function configureRuntimePaths(paths: Partial<RuntimePaths>): void {
  configuredPaths = { ...configuredPaths, ...paths }
}

export function runtimePaths(): RuntimePaths {
  const projectRoot = configuredPaths.projectRoot ?? findProjectRoot()
  return {
    projectRoot,
    appPath: configuredPaths.appPath ?? projectRoot,
    resourcesPath: configuredPaths.resourcesPath ?? process.env.AVA_RESOURCES_DIR ?? projectRoot,
    userDataPath: configuredPaths.userDataPath ?? defaultUserDataPath(),
    isPackaged: configuredPaths.isPackaged ?? false,
  }
}

export function userDataFile(name: string): string {
  return join(runtimePaths().userDataPath, name)
}

export function userPluginsDir(): string {
  const paths = runtimePaths()
  return paths.isPackaged
    ? join(paths.userDataPath, USER_DIR)
    : join(paths.projectRoot, USER_DIR)
}

export function packagedPluginRoots(): Array<{ path: string; bundled: boolean }> {
  const paths = runtimePaths()
  if (!paths.isPackaged) return []
  return [
    { path: join(paths.resourcesPath, BUNDLED_DIR), bundled: true },
    { path: join(paths.appPath, BUNDLED_DIR), bundled: true },
    { path: join(paths.userDataPath, USER_DIR), bundled: false },
  ]
}

function defaultUserDataPath(): string {
  if (process.env.AVA_USER_DATA_DIR) return resolve(process.env.AVA_USER_DATA_DIR)
  if (process.env.APPDATA) return join(process.env.APPDATA, 'Ava')
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'Ava')
  return join(findProjectRoot(), '.ava', 'user-data')
}

function findProjectRoot(): string {
  if (process.env.AVA_PROJECT_ROOT) return resolve(process.env.AVA_PROJECT_ROOT)

  let dir = process.cwd()
  let fallback = process.cwd()
  while (true) {
    const packagePath = join(dir, 'package.json')
    if (existsSync(packagePath)) {
      fallback = dir
      try {
        const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { workspaces?: unknown }
        if (Array.isArray(pkg.workspaces) || (pkg.workspaces && typeof pkg.workspaces === 'object')) {
          return dir
        }
      } catch {
        // Keep walking; malformed package files should not block runtime startup.
      }
    }
    if (existsSync(join(dir, USER_DIR)) || existsSync(join(dir, BUNDLED_DIR))) {
      return dir
    }
    const parent = resolve(dir, '..')
    if (parent === dir) return fallback
    dir = parent
  }
}
