import { useCallback, useEffect, useRef, useState } from 'react';

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResult>;
}

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
}

type RecognitionConstructor = new () => Recognition;

const recognitionConstructor = (): RecognitionConstructor | null => {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
};

const send = (text: string) =>
  fetch('/api/utterance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });

export const useVoice = () => {
  const supported = recognitionConstructor() !== null;
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const wanted = useRef(false);

  const start = useCallback(() => {
    const Constructor = recognitionConstructor();
    if (Constructor === null) return;

    const instance = new Constructor();
    instance.continuous = true;
    instance.interimResults = true;
    instance.lang = navigator.language || 'en-US';
    instance.onresult = (event) => {
      const results = Array.from(event.results).slice(event.resultIndex);
      const finals = results.filter((result) => result.isFinal).map((result) => result[0].transcript);
      const pending = results.filter((result) => !result.isFinal).map((result) => result[0].transcript);

      finals.filter((text) => text.trim().length > 0).forEach((text) => void send(text));
      setInterim(pending.join(' '));
    };
    instance.onerror = (event) => setError(event.error);
    instance.onend = () => {
      if (wanted.current) instance.start();
      else setListening(false);
    };

    wanted.current = true;
    recognition.current = instance;
    setError(null);
    instance.start();
    setListening(true);
  }, []);

  const stop = useCallback(() => {
    wanted.current = false;
    recognition.current?.stop();
    setInterim('');
    setListening(false);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { supported, listening, interim, error, start, stop };
};
