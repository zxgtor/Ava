import type { Settings } from '../types'

export const SPEECH_PLUGIN_ID = 'bundled-ava-speech'

export function isSpeechPluginEnabled(settings: Settings): boolean {
  return settings.pluginStates[SPEECH_PLUGIN_ID]?.enabled ?? true
}

export function isSpeechEnabled(settings: Settings): boolean {
  return Boolean(settings.voice?.enabled && isSpeechPluginEnabled(settings))
}
