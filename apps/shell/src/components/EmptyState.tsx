import { useTranslation } from 'react-i18next'

interface Props {
  userName: string
  onPick: (prompt: string) => void
  disabled?: boolean
}

export function EmptyState({ userName, onPick, disabled }: Props) {
  const { t } = useTranslation()

  const QUICK_PROMPTS: { title: string; subtitle: string; prompt: string }[] = [
    {
      title: t('chat.prompt_intro_title', 'Introduce Myself'),
      subtitle: t('chat.prompt_intro_desc', 'Check if LLM is connected'),
      prompt: t('chat.prompt_intro_body', 'Hello, introduce yourself in two sentences.'),
    },
    {
      title: t('chat.prompt_code_title', 'Explain Code'),
      subtitle: t('chat.prompt_code_desc', 'Paste and let me explain'),
      prompt: t('chat.prompt_code_body', 'Please explain this code:\n\n```\n\n```'),
    },
    {
      title: t('chat.prompt_sum_title', 'Quick Summary'),
      subtitle: t('chat.prompt_sum_desc', 'Give me a text, I give points'),
      prompt: t('chat.prompt_sum_body', 'Help me summarize the following content using bullet points:\n\n'),
    },
    {
      title: t('chat.prompt_edit_title', 'Translate / Polish'),
      subtitle: t('chat.prompt_edit_desc', 'Translate or rewrite'),
      prompt: t('chat.prompt_edit_body', 'Please translate the following content into English and make it sound natural:\n\n'),
    },
  ]

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-6 animate-fade-in">
      <h1 className="text-3xl font-medium mb-2 gradient-text select-none">
        {t('chat.welcome', { name: userName || 'User' })}
      </h1>
      <p className="text-sm text-text-3 mb-8">{t('chat.what_to_chat', 'What would you like to chat about today?')}</p>

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
          {t('chat.no_provider_error', 'No LLM provider enabled, go to settings to configure one.')}
        </p>
      )}
    </div>
  )
}
