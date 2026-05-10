import { useEffect, useRef, useState } from 'react'
import { X, GitBranch } from 'lucide-react'
import { useStore } from '../store'
import { TaskGraphWidget } from './TaskGraphWidget'

const MIN_WIDTH = 280
const MAX_WIDTH = 800
const DEFAULT_WIDTH = 380
const STORAGE_KEY = 'ava.rightPanelWidth'

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_WIDTH
    const n = Number(raw)
    if (!Number.isFinite(n)) return DEFAULT_WIDTH
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n))
  } catch {
    return DEFAULT_WIDTH
  }
}

export function RightPanel() {
  const { dispatch, activeConversation } = useStore()
  const plan = activeConversation?.activeTaskPlan
  const [width, setWidth] = useState(loadWidth)
  const [dragging, setDragging] = useState(false)
  const dragStartRef = useRef<{ x: number; w: number } | null>(null)

  const close = () => dispatch({ type: 'SET_RIGHT_PANEL', open: false })

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const start = dragStartRef.current
      if (!start) return
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, start.w + (start.x - e.clientX)))
      setWidth(next)
    }
    const onUp = () => {
      setDragging(false)
      dragStartRef.current = null
    }
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
    }
  }, [dragging])

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(width)) } catch { /* noop */ }
  }, [width])

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragStartRef.current = { x: e.clientX, w: width }
    setDragging(true)
  }

  return (
    <aside
      className="relative flex flex-col shrink-0 border-l border-border-subtle bg-surface/30 backdrop-blur-xl"
      style={{ width }}
    >
      <div
        onMouseDown={onResizeStart}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        title="Drag to resize · double-click to reset"
        className={`absolute left-0 top-0 bottom-0 w-1 -ml-0.5 z-10 cursor-col-resize group ${dragging ? 'bg-accent/40' : ''}`}
      >
        <div className="absolute inset-y-0 left-0 w-px bg-border-subtle group-hover:bg-accent/60 transition-colors" />
      </div>

      <div className="flex items-center justify-between h-9 px-3 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-2 text-text-2 text-xs font-semibold">
          <GitBranch size={14} className="text-accent" />
          <span>Task Panel</span>
        </div>
        <button
          onClick={close}
          className="p-1 rounded-md text-text-3 hover:text-text hover:bg-white/5 active:scale-95 cursor-pointer transition-all"
          title="Close panel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {plan ? (
          <TaskGraphWidget plan={plan} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center text-text-3">
            <GitBranch size={32} className="mb-3 opacity-40" />
            <div className="text-sm">No active task plan.</div>
            <div className="text-xs mt-1 opacity-70">
              Start a multi-step task and the plan will appear here.
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
