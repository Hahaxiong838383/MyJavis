export interface PublicVoiceTuning {
  vadSilenceMs: number;
  vadAivad: boolean;
  interruptSpeechMs: number;
  llmPrefill: boolean;
  fillerEnabled: boolean;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Public browser audio needs a faster, deterministic turn boundary than the
 * private MyJavis room profile. In particular, Prefill can create an abort
 * storm when browser echo or interim ASR keeps updating the same utterance.
 */
export function resolvePublicVoiceTuning(): PublicVoiceTuning {
  return {
    vadSilenceMs: numberEnv('PUBLIC_VOICE_VAD_SILENCE_MS', 500, 200, 2_000),
    vadAivad: boolEnv('PUBLIC_VOICE_VAD_AIVAD', false),
    interruptSpeechMs: numberEnv('PUBLIC_VOICE_INTERRUPT_SPEECH_MS', 300, 0, 3_000),
    llmPrefill: boolEnv('PUBLIC_VOICE_LLM_PREFILL', false),
    fillerEnabled: boolEnv('PUBLIC_VOICE_FILLER_ENABLED', false),
  };
}
