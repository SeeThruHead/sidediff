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

export const sendUtterance = (text: string, handled: boolean) =>
  fetch('/api/utterance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, handled }),
  });

export const useVoice = (onFinal: (text: string) => void) => {
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
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

      finals.filter((text) => text.trim().length > 0).forEach((text) => onFinalRef.current(text.trim()));
      setInterim(pending.join(' '));
    };
    instance.onerror = (event) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') setError(event.error);
    };
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

  useEffect(() => {
    const permissions = navigator.permissions as
      | { query: (descriptor: { name: string }) => Promise<{ state: string }> }
      | undefined;
    void permissions
      ?.query({ name: 'microphone' })
      .then((status) => {
        if (status.state === 'granted') start();
      })
      .catch(() => undefined);

    return () => stop();
  }, [start, stop]);

  return { supported, listening, interim, error, start, stop };
};
