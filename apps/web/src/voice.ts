/**
 * Voice v1 — browser-native speech (zero deps, zero keys).
 *
 * Input:  SpeechRecognition / webkitSpeechRecognition (Chrome, Edge, Safari).
 * Output: speechSynthesis (universal).
 *
 * Both features degrade gracefully: `isRecognitionAvailable()` gates the mic
 * button; synthesis is silent when unavailable. A proper streaming voice
 * stack (Pipecat / OpenAI Realtime with orb-ui adapters) is the v2 path —
 * this module is deliberately the smallest thing that makes Dream talk.
 */

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isRecognitionAvailable(): boolean {
  return recognitionCtor() !== null;
}

export function isSynthesisAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export interface RecognitionCallbacks {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
  onEnd(): void;
}

export interface RecognitionHandle {
  stop(): void;
}

export function startRecognition(callbacks: RecognitionCallbacks): RecognitionHandle | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.lang = navigator.language || 'en-US';
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]!;
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal) callbacks.onFinal(transcript.trim());
      else interim += transcript;
    }
    if (interim) callbacks.onInterim(interim.trim());
  };
  recognition.onerror = (event) => callbacks.onError(event.error ?? 'recognition error');
  recognition.onend = () => callbacks.onEnd();

  try {
    recognition.start();
  } catch (err) {
    callbacks.onError(String(err));
    return null;
  }
  return { stop: () => recognition.stop() };
}

export function speak(text: string): void {
  if (!isSynthesisAvailable() || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.02;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (isSynthesisAvailable()) window.speechSynthesis.cancel();
}
