import type { Settings } from '../../types'
import { LabeledInput } from './shared'

export function PersonaSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
  return (
    <section>
      <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide mb-3">用户 / 助手</h2>
      <div className="grid grid-cols-2 gap-3">
        <LabeledInput
          label="你的名字"
          value={settings.persona.userName}
          onChange={v => update(s => ({ ...s, persona: { ...s.persona, userName: v } }))}
        />
        <LabeledInput
          label="助手名字"
          value={settings.persona.assistantName}
          onChange={v => update(s => ({ ...s, persona: { ...s.persona, assistantName: v } }))}
        />
      </div>
    </section>
  )
}
