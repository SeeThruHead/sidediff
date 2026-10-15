import type { GuideState } from './guide';
import { useInterim } from './voice';

export const GuideLayer = ({
  state,
  voice,
  onClearCaption,
}: {
  state: GuideState;
  voice: { listening: boolean };
  onClearCaption: () => void;
}) => {
  const interim = useInterim();
  const heard = voice.listening && interim;

  if (!state.caption && !heard) return null;

  return (
    <footer className="guide-bar">
      {state.caption && (
        <div className="caption" onClick={onClearCaption}>
          {state.caption}
        </div>
      )}
      {heard && <div className="interim">🎙 {interim}</div>}
    </footer>
  );
};
