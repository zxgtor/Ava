import type { Settings } from '../../types'
import { LabeledInput, Toggle } from './shared'

export function VoiceSection({
  settings,
  update,
}: {
  settings: Settings
  update: (p: (s: Settings) => Settings) => void
}) {
  const { voice } = settings
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-medium text-text-3 uppercase tracking-wide">语音交互 (Voice)</h2>
        <Toggle
          value={voice.enabled}
          onChange={v => update(s => ({ ...s, voice: { ...s.voice, enabled: v } }))}
        />
      </div>

      <div className={`space-y-4 transition-opacity ${voice.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
        <div className="grid grid-cols-2 gap-3">
          <LabeledInput
            label="STT Server URL (WebSocket)"
            value={voice.sttServerUrl}
            onChange={v => update(s => ({ ...s, voice: { ...s.voice, sttServerUrl: v } }))}
            placeholder="ws://127.0.0.1:8000/ws"
          />
          <LabeledInput
            label="TTS Server URL (HTTP)"
            value={voice.ttsServerUrl}
            onChange={v => update(s => ({ ...s, voice: { ...s.voice, ttsServerUrl: v } }))}
            placeholder="http://127.0.0.1:8002/tts"
          />
        </div>
        
        <div className="grid grid-cols-2 gap-3">
          <LabeledInput
            label="默认发音人 (Voice ID)"
            value={voice.voiceId}
            onChange={v => update(s => ({ ...s, voice: { ...s.voice, voiceId: v } }))}
            placeholder="例如: 中文女"
          />
          <div className="flex items-center gap-3 pt-5">
            <span className="text-sm text-text-2">自动朗读回复</span>
            <Toggle
              value={voice.autoRead}
              onChange={v => update(s => ({ ...s, voice: { ...s.voice, autoRead: v } }))}
            />
          </div>
        </div>
        <p className="text-xs text-text-3 mt-2">
          开启语音交互后，聊天框会出现麦克风图标，收到消息后可自动播放。这需要您的 XiaoMo 服务器在本地运行。
        </p>
      </div>
    </section>
  )
}
