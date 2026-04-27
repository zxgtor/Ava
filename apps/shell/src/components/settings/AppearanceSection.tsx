import { Settings } from '../../types'
import { Sparkles, Zap } from 'lucide-react'

interface Props {
  settings: Settings
  update: (producer: (draft: Settings) => Settings) => void
}

export function AppearanceSection({ settings, update }: Props) {
  const themes = [
    {
      id: 'aura-glass',
      name: '极光通透',
      desc: '现代感十足的毛玻璃效果',
      icon: Sparkles,
      color: 'from-blue-400 to-purple-500',
    },
    {
      id: 'cyber-zen',
      name: '赛博极简',
      desc: '沉浸式的纯黑 OLED 体验',
      icon: Zap,
      color: 'from-cyan-400 to-blue-600',
    },
    {
      id: 'nebula-clear',
      name: '星云全透',
      desc: '极致的原生透明壁纸穿透',
      icon: Sparkles,
      color: 'from-cyan-300 to-indigo-500',
    },
  ] as const

  return (
    <section className="space-y-4">
      <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide">外观与风格</h2>
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
    </section>
  )
}
