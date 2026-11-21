// Voice memos become text (channels/imessage.ts): someone talks to Amb instead of typing, and Amb
// gets what they said as their message. The audio goes to a speech-to-text service that speaks
// OpenAI's transcription API (POST …/audio/transcriptions: OpenAI itself, or any service or
// self-hosted Whisper server with the same endpoint), with the operator's key. Without a key
// there's no transcription and a voice memo is answered with a line saying so.
export interface TranscribeConfig {
  apiKey: string;
  /** The transcription endpoint (default: OpenAI's). */
  url: string;
  model: string;
}

const DEFAULT_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "gpt-4o-transcribe";
/** The transcription API's limit for one file. */
export const AUDIO_BYTES_MAX = 25 * 1024 * 1024;

export function loadTranscribe(env: Record<string, string | undefined>): TranscribeConfig | undefined {
  const apiKey = env.BRAIN_TRANSCRIBE_API_KEY?.trim();
  if (!apiKey) return undefined;
  const url = env.BRAIN_TRANSCRIBE_URL?.trim() || DEFAULT_URL;
  if (!/^https?:\/\//.test(url)) throw new Error("BRAIN_TRANSCRIBE_URL must be an http(s) address.");
  return { apiKey, url, model: env.BRAIN_TRANSCRIBE_MODEL?.trim() || DEFAULT_MODEL };
}

/**
 * The name the audio is sent under: the service picks its decoder from the extension, so the
 * wrong one fails outright. iMessage's voice memos arrive as CAF, AMR or QuickTime, which decode
 * as MP4 containers there.
 */
const NAMES: Record<string, string> = {
  "audio/mp4": "audio.m4a",
  "audio/x-m4a": "audio.m4a",
  "audio/m4a": "audio.m4a",
  "audio/aac": "audio.m4a",
  "audio/mpeg": "audio.mp3",
  "audio/mp3": "audio.mp3",
  "audio/wav": "audio.wav",
  "audio/x-wav": "audio.wav",
  "audio/ogg": "audio.ogg",
  "audio/opus": "audio.ogg",
  "audio/flac": "audio.flac",
  "audio/webm": "audio.webm",
};

export function isAudio(type: string, name: string): boolean {
  return type.startsWith("audio/") || /\.(caf|m4a|mp3|aac|wav|aiff?|amr|ogg|opus)$/i.test(name);
}

export class Transcriber {
  constructor(private d: { config: TranscribeConfig; fetchImpl?: typeof fetch }) {}

  /** What was said, as text ("" when nothing could be made out). Throws when the service refuses. */
  async transcribe(bytes: Buffer, type: string): Promise<string> {
    const form = new FormData();
    form.append("model", this.d.config.model);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: type || "audio/mp4" }), NAMES[type.split(";")[0]!.trim().toLowerCase()] ?? "audio.mp4");
    const res = await (this.d.fetchImpl ?? fetch)(this.d.config.url, { method: "POST", headers: { authorization: `Bearer ${this.d.config.apiKey}` }, body: form, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`the transcription service answered ${res.status}`);
    const json = (await res.json().catch(() => ({}))) as { text?: string };
    return (json.text ?? "").trim();
  }
}
