/* eslint-disable no-console */
// Kill any process holding the vite dev-server ports (and its child tree —
// usually that's the electron-vite parent + electron renderer/main), then
// start `npm run dev` fresh. Surgical: only touches port owners and their
// children, so unrelated electron apps (VS Code, Slack, etc.) are safe.

const { spawnSync, spawn } = require('child_process')
const PORTS = ['5173', '5174', '5175']
const isWin = process.platform === 'win32'

function pidsOnPorts() {
  if (isWin) {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || ''
    const pids = new Set()
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/\s(?:5173|5174|5175)\b.*\bLISTENING\s+(\d+)/)
      if (m) pids.add(m[1])
    }
    return [...pids]
  }
  const out = spawnSync('sh', ['-c', `lsof -tiTCP:${PORTS.join(',')} -sTCP:LISTEN || true`], { encoding: 'utf8' }).stdout || ''
  return out.split(/\s+/).filter(Boolean)
}

function killTree(pid) {
  if (isWin) {
    spawnSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore' })
  } else {
    spawnSync('sh', ['-c', `kill -9 ${pid} 2>/dev/null || true`], { stdio: 'ignore' })
  }
}

function pidsOfStaleElectron() {
  // Kill leftover electron / electron-vite processes from previous runs whose
  // main process is no longer listening on a port (so pidsOnPorts misses them)
  // but is still keeping renderer windows alive. We scope by:
  //   • CommandLine containing 'electron-vite' OR
  //   • ExecutablePath inside this repo's node_modules\\electron
  if (!isWin) return []
  const repoElectron = require('path').resolve(__dirname, '..', 'node_modules', 'electron').toLowerCase()
  const ps = `Get-CimInstance Win32_Process | Where-Object { ` +
    `($_.CommandLine -match 'electron-vite') -or ` +
    `($_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith('${repoElectron.replace(/\\/g, '\\\\')}')) ` +
    `} | Select-Object -ExpandProperty ProcessId`
  const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout || ''
  return out.split(/\s+/).filter(Boolean)
}

const portPids = pidsOnPorts()
const stalePids = pidsOfStaleElectron()
const allPids = [...new Set([...portPids, ...stalePids])]
if (allPids.length === 0) {
  console.log('[dev-fresh] no stale dev servers on', PORTS.join(','))
} else {
  console.log('[dev-fresh] killing stale tree(s):', allPids.join(', '))
  for (const pid of allPids) killTree(pid)
}

console.log('[dev-fresh] starting npm run dev')
const child = spawn('npm', ['run', 'dev'], {
  stdio: 'inherit',
  shell: true,
})
child.on('exit', code => process.exit(code ?? 0))
