import { InitiativeTrait } from '../../types'
import { 
  MessageSquare, Film, Terminal, Briefcase, GraduationCap, 
  Globe, UserSearch, Beaker, Flame, Lightbulb, Tag, Palette
} from 'lucide-react'

interface TraitDefinition {
  id: string
  keywords: string[]
  icon: any
  color: string
  label: string
}

/**
 * 特性注册表：这里是 Ava 的“感知基因库”
 * 您可以随时在这里增加新的特性定义，代码会自动适配。
 */
export const TRAIT_REGISTRY: Record<string, TraitDefinition> = {
  chat: { id: 'chat', label: '对话', keywords: [], icon: MessageSquare, color: 'text-text-3' },
  video: { id: 'video', label: '视频', keywords: ['video', 'mp4', 'mov', 'clip', 'movie', 'script', 'storyboard', '视频', '剪辑', '剧本'], icon: Film, color: 'text-purple-400' },
  code: { id: 'code', label: '代码', keywords: ['code', 'bug', 'debug', 'function', 'react', 'python', 'javascript', '代码', '调试', '架构'], icon: Terminal, color: 'text-blue-400' },
  business: { id: 'business', label: '商业', keywords: ['business', 'revenue', 'market', 'profit', 'startup', '商业', '市场', '创业', '营销'], icon: Briefcase, color: 'text-amber-400' },
  design: { id: 'design', label: '设计', keywords: ['design', 'ui', 'ux', 'logo', 'mockup', 'poster', 'sketch', 'figma', 'icon', 'color', 'font', '设计', '画图', '图标'], icon: Palette, color: 'text-pink-400' },
  mastery: { id: 'mastery', label: '技能', keywords: ['learn', 'skill', 'study', 'course', 'teach', '学习', '技能', '教程'], icon: GraduationCap, color: 'text-emerald-400' },
  intelligence: { id: 'intelligence', label: '情报', keywords: ['news', 'current', 'event', 'world', '资讯', '新闻', '时事', '情报'], icon: Globe, color: 'text-sky-400' },
  profile: { id: 'profile', label: '肖像', keywords: ['persona', 'analyze person', 'character', '肖像', '画像', '性格', '侧写'], icon: UserSearch, color: 'text-rose-400' },
  laboratory: { id: 'laboratory', label: '实验室', keywords: ['benchmark', 'model', 'speed', 'compare models', '测评', '跑分', '性能'], icon: Beaker, color: 'text-indigo-400' },
  forge: { id: 'forge', label: '熔炉', keywords: ['train', 'fine-tune', 'dataset', 'weights', '训练', '微调', '数据集'], icon: Flame, color: 'text-orange-500' },
  idea: { id: 'idea', label: '灵感', keywords: ['idea', 'brainstorm', 'creative', '创意', '灵感', '头脑风暴'], icon: Lightbulb, color: 'text-yellow-400' },
}

/**
 * 获取特性的 UI 配置（支持回退到未知标签）
 */
export function getTraitConfig(traitId: string) {
  return TRAIT_REGISTRY[traitId] || {
    id: traitId,
    label: traitId,
    icon: Tag,
    color: 'text-text-3 opacity-40'
  }
}

/**
 * 根据文本内容检测匹配的特性
 */
export function detectTraitsFromText(text: string): string[] {
  const lowerText = text.toLowerCase()
  const results: { trait: string; score: number }[] = []

  Object.values(TRAIT_REGISTRY).forEach(def => {
    if (def.id === 'chat') return
    
    let score = 0
    def.keywords.forEach(kw => {
      if (lowerText.includes(kw.toLowerCase())) {
        score += 1
      }
    })
    
    if (score > 0) {
      results.push({ trait: def.id, score })
    }
  })

  results.sort((a, b) => b.score - a.score)
  const finalTraits = results.map(r => r.trait)
  
  return finalTraits.length > 0 ? finalTraits : ['chat']
}
