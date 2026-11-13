import { useEffect, useRef, useState } from "react";
import "./mascot.css";

export type MascotActivity = "idle" | "thinking" | "speaking";

export function Mascot({
  shape = "sprout",
  color = "#8de343",
  size = 40,
}: {
  shape?: string;
  color?: string;
  size?: number;
}) {
  return (
    <span
      className="mascot"
      style={{ width: size, height: size * 0.9 }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 100 90"
        style={{ "--bot-color": color } as React.CSSProperties}
      >
        <use href={`/assets/symbols.svg#profile-${shape}`} />
      </svg>
    </span>
  );
}

type Parts = { body: string; eyes: string };
let sheet: Promise<Document | null> | null = null;
const cache = new Map<string, Parts | null>();

/** Splits a profile symbol into its body and its eyes, which are always the symbol's last group. */
function parts(doc: Document | null, shape: string): Parts | null {
  if (cache.has(shape)) return cache.get(shape)!;
  const children = Array.from(
    doc?.getElementById(`profile-${shape}`)?.children ?? [],
  );
  const eyes = children.pop();
  const serializer = new XMLSerializer();
  const result =
    eyes && children.length
      ? {
          body: children.map((n) => serializer.serializeToString(n)).join(""),
          eyes: serializer.serializeToString(eyes),
        }
      : null;
  cache.set(shape, result);
  return result;
}

function useParts(shape: string): Parts | null {
  const [found, setFound] = useState(() => cache.get(shape) ?? null);
  useEffect(() => {
    let live = true;
    sheet ??= fetch("/assets/symbols.svg")
      .then((r) => r.text())
      .then((raw) => new DOMParser().parseFromString(raw, "image/svg+xml"))
      .catch(() => null);
    void sheet.then((doc) => live && setFound(parts(doc, shape)));
    return () => {
      live = false;
    };
  }, [shape]);
  return found;
}

const REACH = 240;
const TRAVEL = 3.2;

/**
 * The bot's present self in the conversation: eyes follow a fine pointer, and the body
 * thinks or speaks while a reply is in progress. Pointer moves schedule one frame each;
 * nothing runs between moves.
 */
export function LiveMascot({
  shape,
  color,
  size = 34,
  activity = "idle",
}: {
  shape: string;
  color: string;
  size?: number;
  activity?: MascotActivity;
}) {
  const found = useParts(shape);
  const host = useRef<HTMLSpanElement>(null);
  const gaze = useRef<SVGGElement>(null);
  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    const fine = matchMedia("(hover: hover) and (pointer: fine)");
    let frame = 0;
    let at: { x: number; y: number } | null = null;
    const look = () => {
      frame = 0;
      const node = host.current;
      if (!node || !gaze.current) return;
      let x = 0,
        y = 0;
      if (at) {
        const box = node.getBoundingClientRect();
        const dx = at.x - (box.left + box.width / 2);
        const dy = at.y - (box.top + box.height / 2);
        const distance = Math.hypot(dx, dy) || 1;
        const pull = (TRAVEL * Math.min(1, distance / REACH)) / distance;
        x = dx * pull;
        y = dy * pull;
      }
      gaze.current.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(look);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      at = { x: e.clientX, y: e.clientY };
      schedule();
    };
    const leave = (e: PointerEvent) => {
      if (e.relatedTarget) return;
      at = null;
      schedule();
    };
    const sync = () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      at = null;
      schedule();
      if (still.matches || !fine.matches) return;
      window.addEventListener("pointermove", move, { passive: true });
      document.documentElement.addEventListener("pointerleave", leave);
    };
    sync();
    still.addEventListener("change", sync);
    fine.addEventListener("change", sync);
    return () => {
      cancelAnimationFrame(frame);
      still.removeEventListener("change", sync);
      fine.removeEventListener("change", sync);
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, [found]);
  return (
    <span
      ref={host}
      className="mascot mascot-live"
      data-activity={activity}
      style={{ width: size, height: size * 0.9 }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 100 90"
        style={{ "--bot-color": color } as React.CSSProperties}
      >
        {found ? (
          <g className="mascot-figure">
            <g dangerouslySetInnerHTML={{ __html: found.body }} />
            <g ref={gaze} className="mascot-gaze">
              <g
                className="mascot-eyes"
                dangerouslySetInnerHTML={{ __html: found.eyes }}
              />
            </g>
          </g>
        ) : (
          <use href={`/assets/symbols.svg#profile-${shape}`} />
        )}
      </svg>
    </span>
  );
}
