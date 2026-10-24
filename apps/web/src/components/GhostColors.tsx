import { GHOST_COLORS, GHOST_PALETTES, type GhostAppearance } from "@wisp/core/src/appearance.ts";
import { cx } from "./ui.tsx";

type Colors = Pick<GhostAppearance, "color" | "color2">;

const lower = (c: string | undefined) => c?.toLowerCase();
/** One color top to bottom (no second color, or the same one twice). */
export const isPlain = (look: Colors) => !look.color2 || lower(look.color2) === lower(look.color);

/** The plain colors and gradients offered, in order (each row is one line, so it's a short list). */
const PLAIN = ["White", "Mist", "Sky", "Mint", "Lavender", "Peach", "Rose", "Midnight"];
const GRADIENT = ["Bubblegum sky", "Orchid peach", "Coral mint", "Lime lagoon", "Arctic blue", "Solar flare", "Violet ember", "Ultraviolet tide"];

/**
 * A ghost's colors in two rows: plain colors (white first) and gradients, each ending with a
 * picker for your own. `limit` shows only the first few of each (the New agent card is small).
 */
export function GhostColors({ look, onChange, limit = 8, size = 32, disabled, labels = false }: { look: Colors; onChange: (c: Colors) => void; limit?: number; size?: number; disabled?: boolean; labels?: boolean }) {
  const plain = isPlain(look);
  const plains = PLAIN.map((n) => GHOST_COLORS.find((c) => c.name === n)!).slice(0, limit);
  const gradients = GRADIENT.map((n) => GHOST_PALETTES.find((p) => p.name === n)!).slice(0, limit);
  const knownPlain = plain && plains.some((c) => c.hex === lower(look.color));
  const knownGradient = !plain && gradients.some((p) => p.color === lower(look.color) && p.color2 === lower(look.color2));
  const dot = (on: boolean) => cx("rounded-full border-[3px] border-panel transition-transform disabled:opacity-50", on ? "ring-2 ring-ink" : "ring-1 ring-line hover:scale-105");
  // each row stays one line: on a narrow screen the dots shrink a little instead of wrapping
  const box = { flex: `0 1 ${size}px`, minWidth: 20, aspectRatio: "1" };
  return (
    <div className="space-y-2">
      <div className={cx("flex items-center gap-2", !labels && "justify-center")} role="group" aria-label="Plain colors">
        {labels && <span className="w-16 shrink-0 text-[13px] text-muted">Plain</span>}
        {plains.map((c) => {
          const on = plain && lower(look.color) === c.hex;
          return <button key={c.hex} type="button" disabled={disabled} aria-label={c.name} title={c.name} aria-pressed={on} onClick={() => onChange({ color: c.hex, color2: c.hex })} className={dot(on)} style={{ ...box, background: c.hex }} />;
        })}
        {/* your own plain color */}
        <label className={cx(dot(plain && !knownPlain), "relative overflow-hidden cursor-pointer", disabled && "pointer-events-none opacity-50")} style={{ ...box, background: plain && !knownPlain ? look.color : "conic-gradient(#ff5f5f, #ffd84d, #5fe08a, #4dabf7, #b07cff, #ff5f5f)" }} title="Pick your own color">
          <input type="color" disabled={disabled} value={plain ? look.color : "#ffffff"} onChange={(e) => onChange({ color: e.target.value, color2: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Your own plain color" />
        </label>
      </div>
      <div className={cx("flex items-center gap-2", !labels && "justify-center")} role="group" aria-label="Gradients">
        {labels && <span className="w-16 shrink-0 text-[13px] text-muted">Gradient</span>}
        {gradients.map((p) => {
          const on = !plain && lower(look.color) === p.color && lower(look.color2) === p.color2;
          return <button key={p.name} type="button" disabled={disabled} aria-label={p.name} title={p.name} aria-pressed={on} onClick={() => onChange({ color: p.color, color2: p.color2 })} className={dot(on)} style={{ ...box, background: `linear-gradient(180deg, ${p.color}, ${p.color2})` }} />;
        })}
        {/* your own gradient: the top half picks the top color, the bottom half the bottom */}
        <span className={cx(dot(!plain && !knownGradient), "relative overflow-hidden flex flex-col", disabled && "pointer-events-none opacity-50")} style={box} title="Pick your own top and bottom colors">
          <label className="relative flex-1 cursor-pointer" style={{ background: !plain && !knownGradient ? look.color : "linear-gradient(90deg, #ff5f5f, #ffd84d, #5fe08a)" }}>
            <input type="color" disabled={disabled} value={look.color} onChange={(e) => onChange({ color: e.target.value, color2: plain ? "#6262ff" : look.color2 })} className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Your own gradient: top color" />
          </label>
          <label className="relative flex-1 cursor-pointer" style={{ background: !plain && !knownGradient ? look.color2 : "linear-gradient(90deg, #4dabf7, #b07cff, #ff5fa8)" }}>
            <input type="color" disabled={disabled} value={look.color2 ?? look.color} onChange={(e) => onChange({ color: look.color, color2: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Your own gradient: bottom color" />
          </label>
        </span>
      </div>
    </div>
  );
}
