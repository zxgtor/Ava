import { useTranslation } from 'react-i18next'
import type { Settings } from '../../types'
import { LabeledInput, Toggle } from './shared'

export function VoiceSection({
  settings,
  update,
}: {
  settings: Settings
  update: (p: (s: Settings) => Settings) => void
}) {
  const { t } = useTranslation()
  const { voice } = settings
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide">{t('settings.voice', 'Voice & STT')}</h2>
        <Toggle
          value={voice.enabled}
          onChange={v => update(s => ({ ...s, voice: { ...s.voice, enabled: v } }))}
        />
      </div>

      <div className={`space-y-4 transition-opacity ${voice.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
        <div className="grid grid-cols-2 gap-3">
          <LabeledInput
            label={t('settings.stt_url', 'STT Server URL (WebSocket)')}
            value={voice.sttServerUrl}
            onChange={v => update(s => ({ ...s, voice: { ...s.voice, sttServerUrl: v } }))}
            placeholder="ws://127.0.0.1:8000/ws"
          />
          <LabeledInput
            label={t('settings.tts_url', 'TTS Server URL (HTTP)')}
            value={voice.ttsServerUrl}
            onChange={v => update(s => ({ ...s, voice: { ...s.voice, ttsServerUrl: v } }))}
            placeholder="http://127.0.0.1:8002/tts"
          />
        </div>
        
        <div className="grid grid-cols-2 gap-3">
          <LabeledInput
            label={t('settings.voice_id', 'Default Voice ID')}
            value={voice.voiceId}
            onChange={v => update(s => ({ ...s, voice: { ...s.voice, voiceId: v } }))}
            placeholder={t('settings.voice_id_placeholder', 'e.g. Chinese Female')}
          />
          <div className="flex items-center gap-3 pt-5">
            <span className="text-sm text-text-2">{t('settings.auto_read', 'Auto-read replies')}</span>
            <Toggle
              value={voice.autoRead}
              onChange={v => update(s => ({ ...s, voice: { ...s.voice, autoRead: v } }))}
            />
          </div>
        </div>
        <p className="text-xs text-text-3 mt-2">
          {t('settings.voice_desc', 'When enabled, a microphone icon appears in the chat box, and messages can be played automatically. Requires a local server.')}
        </p>
      </div>
    </section>
  )
}
