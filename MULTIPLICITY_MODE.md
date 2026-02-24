# Multiplicity Mode (Shadow Typing)

## Intent
- Deliver an "instant" shock of new terminal capability: when multiple panes are open, a single hotkey enables them all to change simultaneously.
- Keep the experience feeling "just works" (no commands to configure, no extra request) while still being visually distinct via the rainbow cursors.
- Leave room for future networked/multiplexed sessions (Cap'n'Web, shadow boxing) once the local controller is solid.

## Research
1. **hterm input hooks**: `Terminal.prototype.io.push()` exposes `onVTKeystroke`/`sendString`, which let us intercept every character before it hits the backend. The plan is to wrap the handler and mirror only the printable keys (skip ESC sequences, Ctrl+C, DEL).
2. **Visual cues**: Instead of trying to track the real cursor location inside the canvas, we overlay two pseudo-cursors that shimmer via a `stare-multiplicity-indicator` and glow animation whenever the mode is active.
3. **Shadow boxing idea**: The same broadcast channel can later be exposed for remote clients; for now the controller keeps everything local but defines a simple API surface events/data can later be streamed over Cap'n'Web or a WebSocket.

## API Contract
```ts
export type MultiplicityTerminalCallbacks = {
  id: string; // stable, unique identifier for each terminal
  deliverInput: (text: string) => void; // invoked when another terminal sends keystrokes
  setIndicatorState: (active: boolean) => void; // trigger the rainbow cursor
};

class MultiplicityController {
  register(callbacks: MultiplicityTerminalCallbacks): void;
  unregister(id: string): void;
  inputFrom(sourceId: string, text: string): void; // mirror input to every other terminal
  toggle(): void; // hotkey/rail can call this
  setActive(active: boolean): void;
  onStateChange(listener: (active: boolean) => void): () => void;
}
```
- The controller ignores mirror requests unless the mode is active and avoids reflecting the initiating terminal back onto itself.

## UX Spec
- **Toggle**: `Ctrl+Shift+M` globally toggles the mirrored mode. (We purposely avoided an extra chrome button to keep the rail clean—just like VS Code’s multi-cursor toggle.)
- **Animation**: When active, each `<stare-terminal>` renders `.stare-multiplicity-indicator` with two animated bars. The terminal element also receives `multiplicity-active` so we can add an outer outline.
- **Shadow text**: As soon as the user types, the other terminals receive the exact same characters (printable characters and Enter) while `Ctrl+C`, Delete, and escape sequences stay local. A `_mirroring` flag prevents recursion when those inputs are replayed.
- **Shadow boxing future**: This controller can later hook to remote agents/clients; the same `inputFrom` API can receive payloads from a WebSocket, and `deliverInput` would play them locally so the UI looks like another local terminal typing.

## Next Steps (scope guard)
1. Track which terminals have focus so we can optionally broadcast only to the others (for now we broadcast to all extras).
2. Consider exposing a formal wire protocol (Cap'n'Web) that carries `sourceId`, `timestamp`, and `payload` so networked sessions behave the same as local shadow typing.
3. If we add a UI toggle button later, it can dispatch `multiplicityController.toggle()` without any backend change.
