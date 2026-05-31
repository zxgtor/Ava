import type { Settings } from '../../types'
import { AboutSection } from './AboutSection'
import { AppearanceSection } from './AppearanceSection'
import { PersonaSection } from './PersonaSection'

export function GeneralSettingsSection({
  settings,
  update,
}: {
  settings: Settings
  update: (p: (s: Settings) => Settings) => void
}) {
  return (
    <div className="space-y-8">
      <PersonaSection settings={settings} update={update} />
      <AppearanceSection settings={settings} update={update} />
      <AboutSection />
    </div>
  )
}
