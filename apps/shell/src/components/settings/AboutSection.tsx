import { useEffect, useState } from 'react'
import { RefreshCw, CheckCircle2, AlertCircle, Download } from 'lucide-react'

export function AboutSection() {
  const [version, setVersion] = useState<string>('')
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'latest'>('idle')
  const [info, setInfo] = useState<any>(null)
  const [progress, setProgress] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.ava.app.version().then(setVersion).catch(() => setVersion('0.0.0'))

    const unsubscribers = [
      window.ava.app.onUpdateAvailable((info) => {
        setInfo(info)
        setStatus('available')
      }),
      window.ava.app.onUpdateNotAvailable(() => {
        setStatus('latest')
      }),
      window.ava.app.onUpdateProgress((p) => {
        setProgress(p)
        setStatus('downloading')
      }),
      window.ava.app.onUpdateDownloaded((info) => {
        setInfo(info)
        setStatus('downloaded')
      }),
      window.ava.app.onUpdateError((err) => {
        setError(err)
        setStatus('error')
      }),
    ]

    return () => {
      unsubscribers.forEach((unsub) => unsub())
    }
  }, [])

  const checkUpdates = async () => {
    setStatus('checking')
    setError(null)
    const result = await window.ava.app.checkUpdates()
    if (!result.ok) {
      setError(result.error)
      setStatus('error')
    }
  }

  const installUpdate = () => {
    window.ava.app.installUpdate()
  }

  return (
    <section>
      <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide mb-3">关于</h2>
      <div className="bg-surface border border-border-subtle rounded-lg p-4 flex flex-col items-center justify-center text-center space-y-4">
        <div className="flex flex-col items-center gap-1">
          <div className="w-12 h-12 bg-accent/10 rounded-2xl flex items-center justify-center text-accent mb-2">
            <span className="text-xl font-bold italic">A</span>
          </div>
          <div className="text-lg font-medium text-text">Ava Desktop</div>
          <div className="text-xs text-text-3 font-mono">v{version}</div>
        </div>

        <div className="w-full max-w-sm pt-2">
          {status === 'idle' && (
            <button
              onClick={checkUpdates}
              className="w-full py-2 flex items-center justify-center gap-2 text-sm text-text-2 bg-surface-2 border border-border-subtle rounded-md hover:bg-surface-3 transition-colors cursor-pointer"
            >
              <RefreshCw size={14} />
              检查更新
            </button>
          )}

          {status === 'checking' && (
            <div className="flex items-center justify-center gap-2 py-2 text-sm text-text-3">
              <RefreshCw size={14} className="animate-spin" />
              正在检查新版本…
            </div>
          )}

          {status === 'latest' && (
            <div className="flex flex-col items-center gap-2">
              <div className="flex items-center justify-center gap-2 py-2 text-sm text-accent">
                <CheckCircle2 size={14} />
                当前已是最新版本
              </div>
              <button
                onClick={checkUpdates}
                className="text-[10px] text-text-3 hover:text-text-2 underline cursor-pointer"
              >
                重新检查
              </button>
            </div>
          )}

          {status === 'available' && (
            <div className="space-y-3">
              <div className="text-sm text-text">
                发现新版本 <span className="font-mono text-accent">v{info?.version}</span>
              </div>
              <button
                disabled
                className="w-full py-2 flex items-center justify-center gap-2 text-sm text-white bg-accent rounded-md opacity-50 cursor-not-allowed"
              >
                <Download size={14} />
                等待下载开始…
              </button>
              <p className="text-[10px] text-text-3">
                自动下载已开启。如果未开始，请手动从 GitHub 下载。
              </p>
            </div>
          )}

          {status === 'downloading' && (
            <div className="space-y-2">
              <div className="flex justify-between text-[10px] text-text-3">
                <span>正在下载新版本…</span>
                <span>{Math.floor(progress?.percent || 0)}%</span>
              </div>
              <div className="w-full h-1.5 bg-surface-3 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-accent transition-all duration-300" 
                  style={{ width: `${progress?.percent || 0}%` }}
                />
              </div>
            </div>
          )}

          {status === 'downloaded' && (
            <div className="space-y-3">
              <div className="flex items-center justify-center gap-2 text-sm text-accent">
                <CheckCircle2 size={14} />
                更新已下载完成
              </div>
              <button
                onClick={installUpdate}
                className="w-full py-2 flex items-center justify-center gap-2 text-sm text-white bg-accent rounded-md hover:brightness-110 transition-all cursor-pointer shadow-lg shadow-accent/20"
              >
                立即重启并安装
              </button>
            </div>
          )}

          {status === 'error' && (
            <div className="space-y-2">
              <div className="flex items-center justify-center gap-2 py-2 text-sm text-error">
                <AlertCircle size={14} />
                检查更新失败
              </div>
              <div className="text-[10px] text-error/80 px-4 line-clamp-2">{error}</div>
              <button
                onClick={checkUpdates}
                className="text-xs text-text-2 hover:text-text underline cursor-pointer mt-2"
              >
                重试
              </button>
            </div>
          )}
        </div>

        <div className="text-[10px] text-text-3 pt-4 border-t border-border-subtle w-full">
          © 2026 Ava Team · AI Assistant & Plugin Host
        </div>
      </div>
    </section>
  )
}
