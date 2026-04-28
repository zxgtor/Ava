import { useTranslation } from 'react-i18next'
import type { Settings } from '../../types'
import { LabeledInput } from './shared'

export function PersonaSection({ settings, update }: { settings: Settings; update: (p: (s: Settings) => Settings) => void }) {
  const { t } = useTranslation()
  return (
    <section>
      <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide mb-3">{t('settings.persona', 'Persona')}</h2>
      <div className="grid grid-cols-2 gap-3">
        <LabeledInput
          label={t('settings.user_name', 'User Name')}
          value={settings.persona.userName}
          onChange={v => update(s => ({ ...s, persona: { ...s.persona, userName: v } }))}
        />
        <LabeledInput
          label={t('settings.assistant_name', 'Assistant Name')}
          value={settings.persona.assistantName}
          onChange={v => update(s => ({ ...s, persona: { ...s.persona, assistantName: v } }))}
        />
      </div>
    </section>
  )
}
