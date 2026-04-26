import { useMemo, useState } from 'react'

// ── Toggle ──────────────────────────────────────────────────────────

export function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      disabled={disabled}
      className={`relative inline-flex items-center h-5 w-9 rounded-full transition-colors cursor-pointer ${
        value ? 'bg-accent' : 'bg-surface-3'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
      aria-pressed={value}
    >
      <span
        className={`inline-block w-4 h-4 rounded-full bg-white transition-transform ${
          value ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

// ── LabeledInput ────────────────────────────────────────────────────

export function LabeledInput({
  label, value, onChange, placeholder, type, list,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  list?: string[]
}) {
  const id = `inp-${label.replace(/\s+/g, '-')}`
  const listId = list && list.length > 0 ? `${id}-list` : undefined
  return (
    <label className="block">
      <span className="block text-xs text-text-3 mb-1">{label}</span>
      <input
        type={type ?? 'text'}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        list={listId}
        className="w-full px-3 py-1.5 text-sm text-text bg-bg border border-border-subtle rounded-md outline-none focus:border-accent/60"
      />
      {listId && (
        <datalist id={listId}>
          {list!.map(m => <option key={m} value={m} />)}
        </datalist>
      )}
    </label>
  )
}

// ── ModelChips ───────────────────────────────────────────────────────

export function ModelChips({
  models, value, onPick,
}: { models: string[]; value: string; onPick: (v: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const THRESHOLD = 16
  // If the current defaultModel isn't in the discovered catalog (e.g. a custom
  // alias, or a half-typed string), show it as a virtual leading chip so user
  // still sees which one is active. This does NOT persist to `provider.models`.
  const displayModels = useMemo(
    () => (value && !models.includes(value) ? [value, ...models] : models),
    [models, value],
  )
  const shown = expanded ? displayModels : displayModels.slice(0, THRESHOLD)
  const rest = displayModels.length - shown.length

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
        {shown.map(m => {
          const active = m === value
          return (
            <button
              key={m}
              type="button"
              onClick={() => onPick(m)}
              className={`px-2 py-0.5 text-xs rounded-full cursor-pointer transition-colors border ${
                active
                  ? 'text-accent bg-accent/15 border-accent/40'
                  : 'text-text-2 bg-surface-2 border-border-subtle hover:text-text hover:bg-surface-3'
              }`}
              title={m}
            >
              {m}
            </button>
          )
        })}
        {rest > 0 && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="px-2 py-0.5 text-xs rounded-full cursor-pointer text-text-3 bg-surface-2 border border-border-subtle hover:text-text-2"
          >
            还有 {rest} 个…
          </button>
        )}
        {expanded && models.length > THRESHOLD && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="px-2 py-0.5 text-xs rounded-full cursor-pointer text-text-3 bg-surface-2 border border-border-subtle hover:text-text-2"
          >
            收起
          </button>
        )}
      </div>
    </div>
  )
}
