import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AtSign, FileText, FolderOpen, Image, Plus } from "lucide-react";
import "./AttachmentMenu.css";

type Props = {
  onFiles: (files: FileList | File[]) => void;
  /** Absent when no other character can join this thread. */
  onInvite?: () => void;
  disabled: boolean;
};

export function AttachmentMenu({ onFiles, onInvite, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function outside(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        setOpen(false);
        if (
          document.activeElement === document.body ||
          root.current?.contains(document.activeElement)
        )
          trigger.current?.focus();
      }
    }
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, [open]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key === "Tab") setOpen(false);
    const buttons = Array.from(menu.current?.querySelectorAll("button") ?? []);
    const index = buttons.findIndex(
      (button) => button === document.activeElement,
    );
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (index + 1) % buttons.length;
        break;
      case "ArrowUp":
        next = (index - 1 + buttons.length) % buttons.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = buttons.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  }

  function pick(input: HTMLInputElement | null) {
    close();
    input?.click();
  }

  return (
    <div className="ez-attachment-menu" ref={root} onKeyDown={navigate}>
      <button
        ref={trigger}
        className="ez-attachment-trigger"
        type="button"
        aria-label={
          open ? "Fermer les pièces jointes" : "Ajouter des pièces jointes"
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <Plus size={20} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          ref={menu}
          role="menu"
          aria-label="Pièces jointes"
          className="ez-attachment-popover"
        >
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => pick(photos.current)}
          >
            <Image size={18} aria-hidden="true" />
            Photos
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => pick(files.current)}
          >
            <FileText size={18} aria-hidden="true" />
            Fichiers
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => pick(folder.current)}
          >
            <FolderOpen size={18} aria-hidden="true" />
            Dossier
          </button>
          {onInvite && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onInvite();
              }}
            >
              <AtSign size={18} aria-hidden="true" />
              Inviter un personnage
            </button>
          )}
        </div>
      )}
      {[
        {
          ref: photos,
          label: "Joindre des photos",
          accept: "image/png,image/jpeg,image/webp",
        },
        {
          ref: files,
          label: "Joindre photos et fichiers",
          accept:
            "image/png,image/jpeg,image/webp,text/*,.txt,.md,.json,.csv,.html,.css,.js,.ts,.xml,.yaml,.yml",
        },
        { ref: folder, label: "Joindre un dossier", webkitdirectory: "" },
      ].map(({ ref, label, ...attributes }) => (
        <input
          key={label}
          ref={ref}
          aria-label={label}
          type="file"
          hidden
          multiple
          disabled={disabled}
          {...attributes}
          onChange={(event) => {
            if (event.currentTarget.files?.length)
              onFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      ))}
    </div>
  );
}
