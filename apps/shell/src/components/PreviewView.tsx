import { useEffect, useState } from 'react'

export function PreviewView() {
  const [content, setContent] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [msgCount, setMsgCount] = useState(0)

  useEffect(() => {
    try {
      if (!window.ava?.window?.onUpdate) {
        setError('Bridge API not found')
        return
      }
      const cleanup = window.ava.window.onUpdate((newContent) => {
        setContent(newContent)
        setLastUpdate(new Date())
        setMsgCount(prev => prev + 1)
      })
      return cleanup
    } catch (err) {
      setError(String(err))
    }
  }, [])

  if (error) {
    return (
      <div className="h-screen bg-[#1a1b1e] flex items-center justify-center text-error p-10 text-center">
        Error: {error}
      </div>
    )
  }

  if (!content) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#1a1b1e] text-white/50">
        <div className="w-8 h-8 rounded-full border-2 border-white/10 border-t-accent animate-spin mb-4" />
        <p className="text-[10px] font-medium tracking-[0.3em] uppercase opacity-50">Ava Design Engine</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-[#1a1b1e] relative overflow-hidden text-white border border-white/5">
      {/* 沉浸式标题栏：强化拖拽逻辑 */}
      <div 
        className="h-11 shrink-0 flex items-center justify-between px-4 pr-[140px] border-b border-white/5 bg-black/60 relative z-50" 
        style={{ webkitAppRegion: 'drag' } as any}
      >
        <div className="flex items-center gap-3 relative z-[60]" style={{ webkitAppRegion: 'no-drag' } as any}>
           <span className="text-[10px] font-bold text-white/40 tracking-[0.2em] uppercase">Preview Canvas</span>
           <span className="px-1.5 py-0.5 rounded bg-white/5 text-[8px] text-white/30 border border-white/5">
             RECV: {msgCount}
           </span>
        </div>
        
        <div className="flex items-center gap-2 relative z-[60]" style={{ webkitAppRegion: 'no-drag' } as any}>
          {lastUpdate && (
            <span className="text-[8px] text-white/20 uppercase tracking-tighter">
              {lastUpdate.toLocaleTimeString()}
            </span>
          )}
          <div className="w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_8px_rgba(59,130,246,0.8)] animate-pulse" />
        </div>
      </div>
      
      {/* 渲染区域 */}
      <div className="flex-1 overflow-auto bg-[#0a0a0a] flex items-center justify-center p-8">
        <div 
          className="max-w-full max-h-full"
          dangerouslySetInnerHTML={{ __html: content }} 
        />
      </div>

      <div className="h-1 bg-accent/20" />
    </div>
  )
}
