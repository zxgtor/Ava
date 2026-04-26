/**
 * Handles Web Audio API recording, downsampling to 16kHz,
 * and converting to Int16 PCM (binary).
 */

export class AudioRecorder {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private onData: ((pcmInt16: Int16Array) => void) | null = null

  async start(onData: (pcmInt16: Int16Array) => void) {
    this.onData = onData
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    
    // Request 16kHz context if browser supports it
    this.context = new window.AudioContext({ sampleRate: 16000 })
    const source = this.context.createMediaStreamSource(this.stream)
    
    // 4096 buffer size = ~256ms of audio at 16kHz
    this.processor = this.context.createScriptProcessor(4096, 1, 1)

    this.processor.onaudioprocess = (e) => {
      if (!this.onData) return
      const float32Data = e.inputBuffer.getChannelData(0)
      const int16Data = this.floatTo16BitPCM(float32Data)
      this.onData(int16Data)
    }

    source.connect(this.processor)
    this.processor.connect(this.context.destination)
  }

  stop() {
    this.onData = null
    if (this.processor && this.context) {
      this.processor.disconnect()
      // Note: we don't disconnect the context destination here as it might be shared 
      // but it's safe to close the context.
    }
    if (this.context) {
      this.context.close().catch(() => {})
      this.context = null
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
  }

  private floatTo16BitPCM(input: Float32Array): Int16Array {
    const output = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]))
      output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
    }
    return output
  }
}
