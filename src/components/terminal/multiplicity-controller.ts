export type MultiplicityTerminalCallbacks = {
  id: string;
  deliverInput: (text: string) => void;
  setIndicatorState: (active: boolean) => void;
};

class MultiplicityController {
  private terminals = new Map<string, MultiplicityTerminalCallbacks>();
  private listeners = new Set<(active: boolean) => void>();
  private active = false;

  register(callbacks: MultiplicityTerminalCallbacks) {
    this.terminals.set(callbacks.id, callbacks);
    callbacks.setIndicatorState(this.active);
  }

  unregister(id: string) {
    this.terminals.delete(id);
  }

  inputFrom(sourceId: string, text: string) {
    if (!this.active) return;
    this.terminals.forEach((callbacks, id) => {
      if (id === sourceId) return;
      callbacks.deliverInput(text);
    });
  }

  toggle() {
    this.setActive(!this.active);
  }

  setActive(next: boolean) {
    if (this.active === next) return;
    this.active = next;
    this.terminals.forEach((callbacks) => {
      callbacks.setIndicatorState(this.active);
    });
    this.listeners.forEach((listener) => listener(this.active));
  }

  isActive() {
    return this.active;
  }

  onStateChange(listener: (active: boolean) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const multiplicityController = new MultiplicityController();
