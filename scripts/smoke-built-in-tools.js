const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const sourcePath = path.join(root, 'apps/shell/electron/services/builtInTools.ts')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-builtins-compiled-'))
const outPath = path.join(outDir, 'builtInTools.cjs')

const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText
fs.writeFileSync(outPath, compiled, 'utf8')

const { builtInTools } = require(outPath)

async function call(name, args, context) {
  const result = await builtInTools.callTool(name, args, context)
  assert.equal(result.ok, true, `${name} failed: ${result.error}`)
  assert.equal(result.isError, true, `${name} returned non-error result unexpectedly`)
  return result
}

async function callOk(name, args, context) {
  const result = await builtInTools.callTool(name, args, context)
  assert.equal(result.ok, true, `${name} failed: ${result.error}`)
  assert.notEqual(result.isError, true, `${name} returned tool error: ${JSON.stringify(result.content)}`)
  return result
}

function hasCommand(command) {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(probe, [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-builtins-'))
  const context = { activeFolderPath: tmp, allowedDirs: [root] }

  await callOk('file.create_dir', { path: path.join(tmp, 'src') }, context)
  await callOk('file.write_text', { path: path.join(tmp, 'src/hello.txt'), content: 'hello Ava\n' }, context)

  const read = await callOk('file.read_text', { path: path.join(tmp, 'src/hello.txt') }, context)
  assert.match(read.content.content, /hello Ava/)

  await callOk('file.patch', {
    path: path.join(tmp, 'src/hello.txt'),
    oldText: 'hello Ava',
    newText: 'hello built-in tools',
  }, context)

  const patched = await callOk('file.read_text', { path: path.join(tmp, 'src/hello.txt') }, context)
  assert.match(patched.content.content, /built-in tools/)

  const listed = await callOk('file.list_dir', { path: path.join(tmp, 'src') }, context)
  assert.equal(listed.content.entries.some(entry => entry.name === 'hello.txt'), true)

  const stats = await callOk('file.stat', { path: path.join(tmp, 'src/hello.txt') }, context)
  assert.equal(stats.content.type, 'file')

  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'node -e "process.exit(0)"',
    },
    devDependencies: {
      vite: '^7.0.0',
    },
    dependencies: {
      react: '^19.0.0',
    },
  }, null, 2), 'utf8')

  const detected = await callOk('project.detect', { cwd: tmp }, context)
  assert.equal(detected.content.types.includes('node'), true)
  assert.equal(detected.content.packageManager, 'npm')

  await callOk('project.validate', { cwd: tmp, level: 'quick', timeoutMs: 30_000 }, context)

  if (hasCommand('rg')) {
    const search = await callOk('search.ripgrep', { cwd: tmp, query: 'built-in', maxMatches: 10 }, context)
    assert.match(search.content.stdout, /hello.txt/)
  } else {
    console.warn('Skipping search.ripgrep smoke check because rg is not installed.')
  }

  const shell = await callOk('shell.run_command', {
    command: 'node',
    args: ['-e', 'console.log("shell-ok")'],
    cwd: tmp,
    timeoutMs: 30_000,
  }, context)
  assert.match(shell.content.stdout, /shell-ok/)

  await callOk('git.status', { cwd: root }, context)

  const serverFile = path.join(tmp, 'dev-server.js')
  fs.writeFileSync(serverFile, [
    'const http = require("node:http");',
    'const server = http.createServer((_req, res) => res.end("ok"));',
    'server.listen(0, "127.0.0.1", () => {',
    '  const address = server.address();',
    '  console.log(`Local: http://127.0.0.1:${address.port}/`);',
    '});',
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
  ].join('\n'), 'utf8')
  const dev = await callOk('devserver.start', {
    command: 'node',
    args: [serverFile],
    cwd: tmp,
  }, context)
  assert.equal(dev.content.status, 'running')
  assert.match(dev.content.url, /^http:\/\/127\.0\.0\.1:\d+\//)

  const devStatus = await callOk('devserver.status', { id: dev.content.id }, context)
  assert.equal(devStatus.content.status, 'running')

  const preview = await callOk('preview.open', { url: dev.content.url }, context)
  assert.equal(preview.content.url, dev.content.url)

  const devStop = await callOk('devserver.stop', { id: dev.content.id }, context)
  assert.equal(devStop.content.stopped, true)

  const blocked = await builtInTools.callTool('file.read_text', { path: path.join(os.tmpdir(), 'outside.txt') }, { activeFolderPath: tmp })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /outside the active project/)

  console.log('built-in tools smoke test passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
