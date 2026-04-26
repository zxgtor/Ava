import { AudioRecorder } from './audioRecorder'

// ── TTS Client ────────────────────────────────────────────────────────

export async function playTTS(text: string, ttsServerUrl: string, voiceId: string): Promise<HTMLAudioElement | null> {
  if (!text.trim() || !ttsServerUrl) return null
  
  try {
    const res = await fetch(ttsServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voiceId }),
    })
    
    if (!res.ok) {
      console.warn('[TTS] request failed:', res.status, await res.text())
      return null
    }

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    
    // Auto cleanup object url after play ends
    audio.addEventListener('ended', () => URL.revokeObjectURL(url))
    audio.addEventListener('error', () => URL.revokeObjectURL(url))
    
    return audio
  } catch (err) {
    console.warn('[TTS] error:', err)
    return null
  }
}

// ── STT WebSocket Client ──────────────────────────────────────────────

type SttMessage = 
  | { type: 'transcript_final'; segments: { text: string }[]; segment_id: number }
  | { type: 'endpoint_detected' }

export class STTClient {
  private ws: WebSocket | null = null
  private recorder: AudioRecorder | null = null
  private sttServerUrl: string
  public onFinalTranscript: ((text: string) => void) | null = null
  public onEndpoint: (() => void) | null = null

  constructor(sttServerUrl: string) {
    this.sttServerUrl = sttServerUrl
  }

  async start(): Promise<void> {
    if (this.ws) return
    
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.sttServerUrl)
        this.ws.onopen = async () => {
          this.recorder = new AudioRecorder()
          await this.recorder.start((pcmInt16) => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(pcmInt16.buffer)
            }
          })
          resolve()
        }
        
        this.ws.onmessage = (event) => {
          if (typeof event.data === 'string') {
            try {
              const data = JSON.parse(event.data) as SttMessage
              if (data.type === 'transcript_final') {
                const text = data.segments.map(s => s.text).join(' ')
                if (text && this.onFinalTranscript) {
                  this.onFinalTranscript(text)
                }
              } else if (data.type === 'endpoint_detected') {
                if (this.onEndpoint) this.onEndpoint()
              }
            } catch (err) {
              console.warn('[STT] WS parse error:', err)
            }
          }
        }
        
        this.ws.onerror = (err) => {
          console.warn('[STT] WS error:', err)
          this.stop()
          reject(err)
        }
        
        this.ws.onclose = () => {
          this.stop()
        }
      } catch (err) {
        reject(err)
      }
    })
  }

  stop() {
    if (this.recorder) {
      this.recorder.stop()
      this.recorder = null
    }
    if (this.ws) {
      // Don't trigger onclose loop
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }

  sendBotState(speaking: boolean) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'bot_state', speaking }))
    }
  }
}
