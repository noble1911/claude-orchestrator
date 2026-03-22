import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Subscribe to a Tauri event and automatically clean up on unmount.
 *
 * The handler receives the event payload directly (unwrapped from the
 * Tauri Event envelope). Re-subscribes whenever `deps` change.
 *
 * **Important:** `handler` is _not_ included in the effect deps to avoid
 * re-subscribing on every render when using inline arrows. Any external
 * values the handler closes over must either be stable (refs, dispatch
 * functions) or listed in `deps` so the listener re-subscribes.
 */
export function useTauriListener<T>(
  eventName: string,
  handler: (payload: T) => void,
  deps: React.DependencyList = [],
): void {
  useEffect(() => {
    const unlisten = listen<T>(eventName, (event) => handler(event.payload));
    return () => { void unlisten.then((fn) => fn()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventName, ...deps]);
}
