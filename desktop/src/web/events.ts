// In-page replacement for Tauri's event bridge. Native code emitted these
// events from Rust; in the browser the shim modules emit them directly.

type WebEvent<T> = { event: string; id: number; payload: T };
type Handler = (event: WebEvent<unknown>) => void;

const handlers = new Map<string, Set<Handler>>();
let nextEventId = 1;

export function emitWebEvent(event: string, payload?: unknown): void {
  const message = { event, id: nextEventId++, payload };
  for (const handler of [...(handlers.get(event) ?? [])]) {
    try {
      handler(message);
    } catch (error) {
      console.error(`[web] ${event} listener failed:`, error);
    }
  }
}

export async function listen<T>(
  event: string,
  handler: (event: WebEvent<T>) => void,
): Promise<() => void> {
  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(handler as Handler);
  handlers.set(event, set);
  return () => {
    set.delete(handler as Handler);
  };
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  emitWebEvent(event, payload);
}
