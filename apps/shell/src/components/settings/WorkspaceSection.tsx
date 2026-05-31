import { useEffect, useState } from 'react'
import { Download, Loader2, Monitor, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Settings, WorkspaceConfig } from '../../types'
import { LOCAL_WORKSPACE_ID } from '../../lib/llm/providers'
import { Toggle } from './shared'

type CodeAgentProbeResult = Awaited<ReturnType<typeof window.ava.workspace.probeCodeAgents>>[number]

export function WorkspaceSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
  const { t } = useTranslation()
  const [runtime, setRuntime] = useState<Record<string, Awaited<ReturnType<typeof window.ava.mcp.listServers>>[number]>>({})
  const [codeAgents, setCodeAgents] = useState<CodeAgentProbeResult[]>([])
  const [probingCodeAgents, setProbingCodeAgents] = useState(false)
  const [codeAgentProbeError, setCodeAgentProbeError] = useState<string | null>(null)
  const [installingCodeAgentId, setInstallingCodeAgentId] = useState<CodeAgentProbeResult['id'] | null>(null)
  const [codeAgentInstallError, setCodeAgentInstallError] = useState<string | null>(null)
  const [newWorkspaceName, setNewWorkspaceName] = useState('')

  useEffect(() => {
    window.ava.mcp.listServers()
      .then(list => setRuntime(Object.fromEntries(list.map(item => [item.id, item]))))
      .catch(() => { /* noop */ })
    const off = window.ava.mcp.onStatus(server => {
      setRuntime(prev => ({ ...prev, [server.id]: server }))
    })
    return off
  }, [])

  const probeCodeAgents = async () => {
    setProbingCodeAgents(true)
    setCodeAgentProbeError(null)
    try {
      setCodeAgents(await probeWorkspaceCodeAgents())
    } catch (err) {
      setCodeAgentProbeError(err instanceof Error ? err.message : String(err))
      setCodeAgents([])
    } finally {
      setProbingCodeAgents(false)
    }
  }

  const installCodeAgent = async (agent: CodeAgentProbeResult) => {
    if (!agent.install || agent.status === 'ready') return
    setInstallingCodeAgentId(agent.id)
    setCodeAgentInstallError(null)
    try {
      await installWorkspaceCodeAgent(agent.id)
      setCodeAgents(await probeWorkspaceCodeAgents())
    } catch (err) {
      setCodeAgentInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstallingCodeAgentId(null)
    }
  }

  useEffect(() => {
    probeCodeAgents()
  }, [])

  const updateWorkspace = (id: string, patch: Partial<WorkspaceConfig>) => {
    update(s => ({
      ...s,
      workspaces: s.workspaces.map(workspace => (
        workspace.id === id ? { ...workspace, ...patch } : workspace
      )),
    }))
  }

  const addWorkspace = () => {
    const name = newWorkspaceName.trim()
    if (!name) return
    const id = `workspace-${Date.now().toString(36)}`
    update(s => ({
      ...s,
      workspaces: [
        ...s.workspaces,
        {
          id,
          name,
          kind: 'pc',
          fileAccess: false,
          pcControl: false,
          builtin: false,
        },
      ],
    }))
    setNewWorkspaceName('')
  }

  const removeWorkspace = (id: string) => {
    update(s => ({
      ...s,
      workspaces: s.workspaces.filter(workspace => workspace.id !== id || workspace.builtin),
    }))
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-text">{t('settings.workspace', 'Workspace')}</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-3">
          {t('settings.workspace_desc', 'Control which computers Ava can work in. Local PC is the computer currently running Ava.')}
        </p>
      </div>

      <div className="rounded-2xl border border-border-subtle bg-surface/80 p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-3">
          {t('settings.workspace_add_pc', 'Add Workspace PC')}
        </div>
        <div className="flex flex-col gap-2 md:flex-row">
          <input
            value={newWorkspaceName}
            onChange={e => setNewWorkspaceName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') addWorkspace()
              if (e.key === 'Escape') setNewWorkspaceName('')
            }}
            placeholder={t('settings.workspace_name_placeholder', 'Workspace name, e.g. Studio PC')}
            className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-black/40 px-3 py-1.5 text-sm text-text outline-none transition-all placeholder:text-text-3 hover:border-text-3 focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          <button
            type="button"
            onClick={addWorkspace}
            disabled={!newWorkspaceName.trim()}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={14} />
            {t('settings.workspace_add', 'Add')}
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {settings.workspaces.map(workspace => (
          <WorkspaceCard
            key={workspace.id}
            workspace={workspace}
            runtime={workspace.id === LOCAL_WORKSPACE_ID ? runtime['windows-mcp'] : undefined}
            codeAgents={workspace.id === LOCAL_WORKSPACE_ID ? codeAgents : []}
            probingCodeAgents={workspace.id === LOCAL_WORKSPACE_ID ? probingCodeAgents : false}
            codeAgentProbeError={workspace.id === LOCAL_WORKSPACE_ID ? codeAgentProbeError : null}
            installingCodeAgentId={workspace.id === LOCAL_WORKSPACE_ID ? installingCodeAgentId : null}
            codeAgentInstallError={workspace.id === LOCAL_WORKSPACE_ID ? codeAgentInstallError : null}
            onProbeCodeAgents={workspace.id === LOCAL_WORKSPACE_ID ? probeCodeAgents : undefined}
            onInstallCodeAgent={workspace.id === LOCAL_WORKSPACE_ID ? installCodeAgent : undefined}
            onChange={patch => updateWorkspace(workspace.id, patch)}
            onRemove={workspace.builtin ? undefined : () => removeWorkspace(workspace.id)}
          />
        ))}
      </div>
    </section>
  )
}

function WorkspaceCard({
  workspace,
  runtime,
  codeAgents,
  probingCodeAgents,
  codeAgentProbeError,
  installingCodeAgentId,
  codeAgentInstallError,
  onProbeCodeAgents,
  onInstallCodeAgent,
  onChange,
  onRemove,
}: {
  workspace: WorkspaceConfig
  runtime?: Awaited<ReturnType<typeof window.ava.mcp.listServers>>[number]
  codeAgents: CodeAgentProbeResult[]
  probingCodeAgents: boolean
  codeAgentProbeError: string | null
  installingCodeAgentId: CodeAgentProbeResult['id'] | null
  codeAgentInstallError: string | null
  onProbeCodeAgents?: () => void
  onInstallCodeAgent?: (agent: CodeAgentProbeResult) => void
  onChange: (patch: Partial<WorkspaceConfig>) => void
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  const isLocal = workspace.id === LOCAL_WORKSPACE_ID

  return (
    <article className="rounded-2xl border border-border-subtle bg-surface p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
            <Monitor size={17} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-text">{workspace.name}</h3>
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-3">
                {isLocal ? t('settings.workspace_local', 'Local PC') : t('settings.workspace_pc', 'PC')}
              </span>
            </div>
            <p className="mt-1 text-xs text-text-3">
              {isLocal
                ? t('settings.workspace_local_desc', 'Default workspace running Ava.')
                : t('settings.workspace_remote_desc', 'Saved workspace record. Remote environment driver wiring comes later.')}
            </p>
          </div>
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-lg p-1.5 text-text-3 hover:bg-error/10 hover:text-error"
            title={t('settings.workspace_remove', 'Remove workspace')}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>

      <div className="space-y-3">
        <WorkspacePermissionRow
          title={t('settings.workspace_file_access', 'File Access')}
          description={t('settings.workspace_file_access_desc', 'Allow Ava to read and write this PC file system. System file changes require explicit confirmation.')}
          value={workspace.fileAccess}
          onChange={value => onChange({ fileAccess: value })}
        />
        <WorkspacePermissionRow
          title={t('settings.workspace_pc_control', 'PC Control')}
          description={t('settings.workspace_pc_control_desc', 'Allow Ava to observe and control this PC through the environment driver.')}
          value={workspace.pcControl}
          onChange={value => onChange({ pcControl: value })}
        />
      </div>

      {isLocal && (
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-border-subtle bg-bg/50 px-3 py-2 text-xs text-text-3">
            <div className="flex items-center justify-between gap-3">
              <span>{t('settings.workspace_runtime_status', 'PC control runtime')}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${runtimeStatusClass(runtime?.status ?? 'stopped')}`}>
                {runtime?.status ?? 'stopped'}
              </span>
            </div>
            {runtime?.lastError && <div className="mt-1 text-error">{runtime.lastError}</div>}
          </div>
          <div className="rounded-xl border border-border-subtle bg-bg/50 px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-text">{t('settings.workspace_code_agents', 'Code Agents')}</span>
              <button
                type="button"
                onClick={onProbeCodeAgents}
                disabled={probingCodeAgents}
                className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-3 hover:text-text disabled:opacity-50"
              >
                {probingCodeAgents ? t('settings.workspace_code_agents_probing', 'Probing') : t('settings.workspace_code_agents_reprobe', 'Probe')}
              </button>
            </div>
            <div className="grid gap-1.5">
              {codeAgents.map(agent => (
                <div key={agent.id} className="flex items-center justify-between gap-3 rounded-lg bg-surface/70 px-2 py-1.5 text-xs">
                  <div className="min-w-0">
                    <div className="truncate text-text">{agent.name}</div>
                    <div className="truncate text-[11px] text-text-3">
                      {agent.version ?? agent.error ?? agent.install?.label ?? agent.command}
                    </div>
                  </div>
                  <div className="flex flex-none items-center gap-1.5">
                    {agent.status !== 'ready' && agent.install && (
                      <button
                        type="button"
                        onClick={() => onInstallCodeAgent?.(agent)}
                        disabled={!onInstallCodeAgent || Boolean(installingCodeAgentId) || probingCodeAgents}
                        title={agent.install.label}
                        className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {installingCodeAgentId === agent.id ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                        {installingCodeAgentId === agent.id
                          ? t('settings.workspace_code_agent_installing', 'Installing')
                          : t('settings.workspace_code_agent_install', 'Install')}
                      </button>
                    )}
                    <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${agentStatusClass(agent.status)}`}>
                      {agent.status}
                    </span>
                  </div>
                </div>
              ))}
              {codeAgentProbeError && (
                <div className="rounded-lg bg-error/10 px-2 py-1.5 text-xs text-error">
                  {codeAgentProbeError}
                </div>
              )}
              {codeAgentInstallError && (
                <div className="rounded-lg bg-error/10 px-2 py-1.5 text-xs text-error">
                  {codeAgentInstallError}
                </div>
              )}
              {!codeAgents.length && (
                <div className="rounded-lg bg-surface/70 px-2 py-1.5 text-xs text-text-3">
                  {probingCodeAgents
                    ? t('settings.workspace_code_agents_probing_desc', 'Checking local code agent CLIs...')
                    : t('settings.workspace_code_agents_empty', 'No code agent probe result yet.')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </article>
  )
}

function agentStatusClass(status: CodeAgentProbeResult['status']): string {
  if (status === 'ready') return 'bg-success/15 text-success'
  if (status === 'error') return 'bg-warning/15 text-warning'
  return 'bg-surface-2 text-text-3'
}

function runtimeStatusClass(status: string): string {
  if (status === 'running') return 'bg-success/15 text-success'
  if (status === 'error') return 'bg-error/15 text-error'
  if (status === 'starting') return 'bg-warning/15 text-warning'
  return 'bg-surface-2 text-text-3'
}

async function probeWorkspaceCodeAgents(): Promise<CodeAgentProbeResult[]> {
  const api = window.ava.workspace as typeof window.ava.workspace & {
    probeCodeAgents?: () => Promise<CodeAgentProbeResult[]>
  }
  if (typeof api.probeCodeAgents === 'function') {
    return api.probeCodeAgents()
  }

  // Allows Vite hot reload to work before Electron main/preload is restarted.
  const response = await fetch('http://127.0.0.1:17871/workspace/code-agents')
  if (!response.ok) throw new Error(`Code agent probe failed: HTTP ${response.status}`)
  const payload = await response.json() as { ok?: boolean; result?: CodeAgentProbeResult[]; error?: string }
  if (!payload.ok) throw new Error(payload.error ?? 'Code agent probe failed.')
  return Array.isArray(payload.result) ? payload.result : []
}

async function installWorkspaceCodeAgent(agentId: CodeAgentProbeResult['id']): Promise<unknown> {
  const api = window.ava.workspace as typeof window.ava.workspace & {
    installCodeAgent?: (agentId: CodeAgentProbeResult['id']) => Promise<unknown>
  }
  if (typeof api.installCodeAgent === 'function') {
    return api.installCodeAgent(agentId)
  }

  // Allows Vite hot reload to work before Electron main/preload is restarted.
  const response = await fetch('http://127.0.0.1:17871/workspace/code-agents/install', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agentId }),
  })
  const payload = await response.json().catch(() => null) as { ok?: boolean; result?: unknown; error?: string } | null
  if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `Code agent install failed: HTTP ${response.status}`)
  return payload.result
}

function WorkspacePermissionRow({
  title,
  description,
  value,
  onChange,
}: {
  title: string
  description: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl border border-border-subtle bg-bg/45 px-3 py-2">
      <div className="min-w-0 pr-2">
        <div className="text-sm font-medium text-text">{title}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-text-3">{description}</div>
      </div>
      <div className="flex w-11 justify-end">
        <Toggle value={value} onChange={onChange} />
      </div>
    </div>
  )
}
