import { useEffect, useRef, useState } from 'react'
import { GitBranch, X } from 'lucide-react'
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
    const onMove = (event: MouseEvent) => {
      const start = dragStartRef.current
      if (!start) return
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, start.w + (start.x - event.clientX)))
      setWidth(next)
    }
    const onUp = () => {
      setDragging(false)
      dragStartRef.current = null
    }
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
    }
  }, [dragging])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(width))
    } catch {
      // Ignore localStorage failures in restricted preview contexts.
    }
  }, [width])

  const onResizeStart = (event: React.MouseEvent) => {
    event.preventDefault()
    dragStartRef.current = { x: event.clientX, w: width }
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
        title="Drag to resize, double-click to reset"
        className={`absolute left-0 top-0 bottom-0 z-10 -ml-0.5 w-1 cursor-col-resize group ${dragging ? 'bg-accent/40' : ''}`}
      >
        <div className="absolute inset-y-0 left-0 w-px bg-border-subtle transition-colors group-hover:bg-accent/60" />
      </div>

      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle px-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-text-2">
          <GitBranch size={14} className="text-accent" />
          <span>Task Panel</span>
        </div>
        <button
          onClick={close}
          className="cursor-pointer rounded-md p-1 text-text-3 transition-all hover:bg-white/5 hover:text-text active:scale-95"
          title="Close panel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
        {plan ? (
          <TaskGraphWidget plan={plan} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-text-3">
            <GitBranch size={32} className="mb-3 opacity-40" />
            <div className="text-sm">No active task plan.</div>
            <div className="mt-1 text-xs opacity-70">
              Start a multi-step task and the plan will appear here.
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
