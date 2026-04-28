import { Sparkles, Zap, Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Settings } from '../../types'

interface Props {
  settings: Settings
  update: (producer: (draft: Settings) => Settings) => void
}

export function AppearanceSection({ settings, update }: Props) {
  const { t } = useTranslation()
  const themes = [
    {
      id: 'aura-glass',
      name: t('settings.theme_aura_name', 'Aura Glass'),
      desc: t('settings.theme_aura_desc', 'Modern glassmorphism effect'),
      icon: Sparkles,
      color: 'from-blue-400 to-purple-500',
    },
    {
      id: 'cyber-zen',
      name: t('settings.theme_cyber_name', 'Cyber Zen'),
      desc: t('settings.theme_cyber_desc', 'Immersive OLED black experience'),
      icon: Zap,
      color: 'from-cyan-400 to-blue-600',
    },
    {
      id: 'nebula-clear',
      name: t('settings.theme_nebula_name', 'Nebula Clear'),
      desc: t('settings.theme_nebula_desc', 'Extreme transparency'),
      icon: Sparkles,
      color: 'from-cyan-300 to-indigo-500',
    },
  ] as const

  return (
    <section className="space-y-6">
      <div className="space-y-4">
        <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide">{t('settings.theme', 'Theme')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {themes.map((t) => (
            <button
              key={t.id}
              onClick={() => update((d) => ({ ...d, theme: t.id }))}
              className={`flex flex-col items-start text-left p-3 rounded-xl border transition-all cursor-pointer group ${
                settings.theme === t.id
                  ? 'bg-accent/10 border-accent shadow-lg shadow-accent/5'
                  : 'bg-surface border-border-subtle hover:border-text-3'
              }`}
            >
              <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${t.color} flex items-center justify-center text-white mb-3 shadow-sm`}>
                <t.icon size={20} />
              </div>
              <div className="text-sm font-medium text-text">{t.name}</div>
              <div className="text-[10px] text-text-3 mt-1 leading-tight">{t.desc}</div>
              
              {settings.theme === t.id && (
                <div className="mt-3 w-full h-1 bg-accent rounded-full" />
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4 pt-4 border-t border-border-subtle">
        <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide">{t('settings.language', 'Language')}</h2>
        <div className="flex items-center gap-4 p-4 rounded-xl bg-surface border border-border-subtle">
          <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
            <Globe size={20} />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium text-text">{t('settings.language_selection', 'Interface Language')}</div>
            <div className="text-xs text-text-3 mt-1">{t('settings.language_desc', 'Choose your preferred language for the interface')}</div>
          </div>
          <select
            value={settings.language}
            onChange={(e) => update((d) => ({ ...d, language: e.target.value as any }))}
            className="bg-black/40 border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text outline-none focus:border-accent ring-accent/20 focus:ring-2 transition-all appearance-none cursor-pointer pr-8 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:20px_20px] bg-[right_0.5rem_center] bg-no-repeat shadow-sm hover:border-text-3"
          >
            <option value="auto" className="bg-[#1a1b1e] text-white">{t('settings.auto', 'System Default')}</option>
            <option value="zh-CN" className="bg-[#1a1b1e] text-white">{t('settings.zh_cn', '简体中文')}</option>
            <option value="en-US" className="bg-[#1a1b1e] text-white">{t('settings.en_us', 'English')}</option>
          </select>
        </div>
      </div>
    </section>
  )
}
