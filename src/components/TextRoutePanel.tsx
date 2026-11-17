import { useState } from "react";

export type FontStatus = "loading" | "ready" | "error";

interface TextRoutePanelProps {
  fontStatus: FontStatus;
  error: string | null;
  onGenerate: (text: string, letterHeightMeters: number) => void;
}

const DEFAULT_HEIGHT_M = 250;

export default function TextRoutePanel({ fontStatus, error, onGenerate }: TextRoutePanelProps) {
  const [text, setText] = useState("");
  const [heightMeters, setHeightMeters] = useState(DEFAULT_HEIGHT_M);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onGenerate(text, heightMeters);
  };

  return (
    <form className="text-route-panel" onSubmit={handleSubmit}>
      <h2>Type a route</h2>
      <p className="panel-hint">
        Spell a word and it's placed on the map centered on the current view, then snapped to
        nearby roads/paths just like a drawn shape.
      </p>

      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. RUN"
        maxLength={40}
      />

      <label className="height-label">
        Letter height (m)
        <input
          type="number"
          min={30}
          max={5000}
          step={10}
          value={heightMeters}
          onChange={(e) => setHeightMeters(Number(e.target.value))}
        />
      </label>

      <button type="submit" disabled={fontStatus !== "ready" || text.trim().length === 0}>
        {fontStatus === "loading" ? "Loading font…" : "Place on map"}
      </button>

      {fontStatus === "error" && (
        <div className="error-text">Couldn't load the text font. Try reloading the page.</div>
      )}
      {error && <div className="error-text">{error}</div>}
    </form>
  );
}
