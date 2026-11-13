import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Pencil, Plus } from "lucide-react";
import type { BotView } from "../../server/src/protocol";
import type { Port } from "../port";
import { Mascot } from "../Mascot";

/** The conversation title is the bot menu: switch, edit or create without leaving the thread. */
export function BotSwitcher({ port, bot }: { port: Port; bot: BotView }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const items = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [],
    );
  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) button.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    items()
      .find((item) => item.getAttribute("aria-checked") === "true")
      ?.focus();
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function act(run: () => void) {
    close(true);
    run();
  }
  return (
    <div className="switcher">
      <button
        ref={button}
        className="bot-title"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Mascot shape={bot.shape} color={bot.color} size={30} />
        <strong>{bot.name}</strong>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Personnages"
          className="switcher-menu"
          onKeyDown={(e) => {
            const list = items(),
              at = list.indexOf(document.activeElement as HTMLElement);
            const move = (to: number) => {
              e.preventDefault();
              list[(to + list.length) % list.length]?.focus();
            };
            if (e.key === "ArrowDown") move(at + 1);
            else if (e.key === "ArrowUp") move(at - 1);
            else if (e.key === "Home") move(0);
            else if (e.key === "End") move(list.length - 1);
            else if (e.key === "Escape") {
              e.preventDefault();
              close(true);
            } else if (e.key === "Tab") close(false);
          }}
        >
          {port.view.bots.map((b) => (
            <button
              key={b.id}
              role="menuitemradio"
              aria-checked={b.id === bot.id}
              tabIndex={-1}
              onClick={() => act(() => port.go({ page: "chat", botId: b.id }))}
            >
              <Mascot shape={b.shape} color={b.color} size={32} />
              <span>
                <strong>{b.name}</strong>
                {b.title && <small>{b.title}</small>}
              </span>
              {b.id === bot.id && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
          <hr />
          <button
            role="menuitem"
            tabIndex={-1}
            onClick={() =>
              act(() => port.openBot({ mode: "edit", botId: bot.id }))
            }
          >
            <Pencil size={16} aria-hidden="true" />
            Modifier {bot.name}
          </button>
          <button
            role="menuitem"
            tabIndex={-1}
            onClick={() => act(() => port.openBot({ mode: "create" }))}
          >
            <Plus size={16} aria-hidden="true" />
            Nouveau personnage
          </button>
        </div>
      )}
    </div>
  );
}
