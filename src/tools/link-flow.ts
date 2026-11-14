import { useEffect, useRef, useState } from "react";
import type { ToolsReplyOf } from "../../server/src/tools-protocol";
import { toolsRequest } from "../api";

export const failureText = (reason: unknown) =>
  reason instanceof Error ? reason.message : "Le service ne répond pas.";

export type LinkFlowState =
  | { kind: "selection" }
  | { kind: "opening" }
  | { kind: "waiting"; linkId: string; fallback: string | null }
  | { kind: "success" }
  | {
      kind: "error";
      message: string;
      linkId: string | null;
      fallback: string | null;
    };

/** A free account name from this base: the base, then « base 2 », « base 3 ». */
export function freeAlias(base: string, accounts: { alias: string }[]) {
  const stem = base.slice(0, 36);
  const used = new Set(accounts.map((account) => account.alias));
  let name = stem;
  for (let number = 2; used.has(name); number += 1)
    name = `${stem} ${number}`.slice(0, 40);
  return name;
}

/**
 * The provider window, the wait and the checks of one connection.
 * The connection address lives in this state only: it never reaches the view or the browser storage.
 */
export function useLinkFlow(configured: boolean) {
  const [state, setState] = useState<LinkFlowState>({ kind: "selection" });
  const lifecycle = useRef<AbortController | null>(null);
  const opening = useRef(false);
  const popup = useRef<Window | null>(null);
  const checkNow = useRef<(() => void) | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => {
      controller.abort();
      if (opening.current) popup.current?.close();
      lifecycle.current = null;
    };
  }, []);

  const waitingId = state.kind === "waiting" ? state.linkId : null;
  const waitingFallback = state.kind === "waiting" ? state.fallback : null;
  useEffect(() => {
    if (!configured || !waitingId) return;
    const controller = new AbortController();
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (next: LinkFlowState) => {
      controller.abort();
      clearTimeout(timer);
      setState(next);
    };
    const deadline = setTimeout(
      () =>
        finish({
          kind: "error",
          linkId: waitingId,
          fallback: waitingFallback,
          message:
            "La connexion attend encore votre autorisation. Vérifiez de nouveau quand vous avez terminé chez le fournisseur.",
        }),
      120_000,
    );
    async function check() {
      if (inFlight || controller.signal.aborted) return;
      clearTimeout(timer);
      inFlight = true;
      try {
        const reply = await toolsRequest(
          "checked",
          `links/${encodeURIComponent(waitingId ?? "")}/check`,
          {},
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (reply.link.state === "active") finish({ kind: "success" });
        else if (reply.link.state === "failed")
          finish({
            kind: "error",
            linkId: waitingId,
            fallback: waitingFallback,
            message:
              "La connexion n’a pas abouti. Vous pouvez vérifier de nouveau ou choisir un autre compte.",
          });
        else timer = setTimeout(() => void check(), 3_000);
      } catch (reason) {
        if (!controller.signal.aborted)
          finish({
            kind: "error",
            linkId: waitingId,
            fallback: waitingFallback,
            message: failureText(reason),
          });
      } finally {
        inFlight = false;
      }
    }
    const onReturn = () => {
      if (document.visibilityState === "visible") void check();
    };
    checkNow.current = () => void check();
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    timer = setTimeout(() => void check(), 1_000);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
      checkNow.current = null;
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [configured, waitingId, waitingFallback]);

  /** Opens the window during the click, asks for the link, then waits for the provider. True once the wait has started. */
  async function open(
    start: (signal: AbortSignal) => Promise<ToolsReplyOf<"link">>,
  ): Promise<boolean> {
    const controller = lifecycle.current;
    if (!controller || opening.current) return false;
    opening.current = true;
    const child = window.open("about:blank", "_blank");
    popup.current = child;
    if (child) child.opener = null;
    setState({ kind: "opening" });
    try {
      const reply = await start(controller.signal);
      if (controller.signal.aborted) {
        child?.close();
        return false;
      }
      if (new URL(reply.redirectUrl).protocol !== "https:")
        throw Error("Adresse de connexion invalide.");
      let fallback: string | null = null;
      if (child && !child.closed) child.location.href = reply.redirectUrl;
      else fallback = reply.redirectUrl;
      setState({ kind: "waiting", linkId: reply.linkId, fallback });
      return true;
    } catch (reason) {
      child?.close();
      if (!controller.signal.aborted)
        setState({
          kind: "error",
          message: failureText(reason),
          linkId: null,
          fallback: null,
        });
      return false;
    } finally {
      opening.current = false;
    }
  }

  return {
    state,
    busy: state.kind === "opening" || state.kind === "waiting",
    open,
    /** Checks an existing link again, for two minutes at most. */
    check(linkId: string, fallback: string | null = null) {
      setState({ kind: "waiting", linkId, fallback });
    },
    checkNow() {
      checkNow.current?.();
    },
    stop() {
      setState({ kind: "selection" });
    },
  };
}
