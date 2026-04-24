interface Props {
  userName: string
  onPick: (prompt: string) => void
  disabled?: boolean
}

const QUICK_PROMPTS: { title: string; subtitle: string; prompt: string }[] = [
  {
    title: '介绍自己',
    subtitle: '看看 LLM 连通了没',
    prompt: '你好，用两句话介绍一下你自己。',
  },
  {
    title: '解释一段代码',
    subtitle: '粘贴后让我讲解',
    prompt: '请解释这段代码：\n\n```\n\n```',
  },
  {
    title: '快速总结',
    subtitle: '给我一段，我给你要点',
    prompt: '帮我用要点总结下面这段内容：\n\n',
  },
  {
    title: '翻译 / 润色',
    subtitle: '中英互译或改写',
    prompt: '请把下面这段内容翻译成英文，并让语气更自然：\n\n',
  },
]

export function EmptyState({ userName, onPick, disabled }: Props) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 px-6 animate-fade-in">
      <h1 className="text-3xl font-medium mb-2 gradient-text select-none">
        你好 {userName}
      </h1>
      <p className="text-sm text-text-3 mb-8">今天想聊点什么？</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-2xl">
        {QUICK_PROMPTS.map(item => (
          <button
            key={item.title}
            type="button"
            disabled={disabled}
            onClick={() => onPick(item.prompt)}
            className="px-4 py-3 text-left rounded-xl bg-surface border border-border-subtle transition-colors cursor-pointer hover:border-accent/40 hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <div className="text-sm text-text">{item.title}</div>
            <div className="text-xs text-text-3 mt-0.5">{item.subtitle}</div>
          </button>
        ))}
      </div>

      {disabled && (
        <p className="text-xs text-warning mt-6">
          还没启用任何 LLM 供应商，先去设置里配置一个。
        </p>
      )}
    </div>
  )
}
