import htermScriptUrl from "hterm/dist/amd/lib/hterm.amd.js?url";
import { bootFriscy, type FriscyRuntime } from "./friscy-client";
import { ensureHighlighterReady, highlightCodeFence } from "./shiki-ansi";
import { multiplicityController } from "./multiplicity-controller";

type HtermModule = {
  Terminal: new (options?: any) => any;
};

type TerminalInstance = {
  decorate: (node: HTMLElement) => void;
  installKeyboard: () => void;
  setFontFamily: (family: string) => void;
  setFontSize: (size: number) => void;
  setCursorBlink: (enabled: boolean) => void;
  io: {
    push: () => {
      onVTKeystroke?: (str: string) => void;
      sendString?: (str: string) => void;
      println: (str: string) => void;
      print: (str: string) => void;
    };
  };
  onTerminalReady: () => void;
};

const ELEMENT_NAME = "stare-terminal";

const CODE_FENCE_REGEX = /```(\\w+)?\\n([\\s\\S]*?)```/g;
const CODE_FENCE_DETECT = /```(\\w+)?\\n([\\s\\S]*?)```/;

ensureHighlighterReady();

type ShikiMode = "auto" | "force" | "off";
const normalizeShikiMode = (value: string | null): ShikiMode => {
  if (value === "force") return "force";
  if (value === "off") return "off";
  return "auto";
};

const DEFAULT_HIGHLIGHT_PATTERNS: Array<{
  name: string;
  regex: RegExp;
  color: string;
  underline?: boolean;
}> = [
  {
    name: "url",
    regex: /https?:\/\/[^^\s<>()]+/g,
    color: "56,189,248",
    underline: true,
  },
  {
    name: "path",
    regex:
      /(?<!https?:)\b(?:~\/|\.?\/)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\/?/g,
    color: "129,230,217",
  },
];

const renderCodeFences = (text: string) => {
  CODE_FENCE_REGEX.lastIndex = 0;
  return text.replace(CODE_FENCE_REGEX, (_match, lang = "plaintext", code) => {
    const normalized = lang.trim() || "plaintext";
    const highlighted = highlightCodeFence(code, normalized);
    return `
${highlighted}
`;
  });
};

const hasCodeFence = (text: string) => CODE_FENCE_DETECT.test(text);

const applyHighlight = (text: string) => {
  const patterns =
    (window as any).__STARE_HIGHLIGHT_PATTERNS__ || DEFAULT_HIGHLIGHT_PATTERNS;
  if (!patterns || patterns.length === 0) return text;

  const ansiRegex = /\[[0-9;]*m/g;
  const segments: Array<{ ansi: boolean; value: string }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ansiRegex.exec(text))) {
    if (match.index > lastIndex) {
      segments.push({
        ansi: false,
        value: text.slice(lastIndex, match.index),
      });
    }
    segments.push({ ansi: true, value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ ansi: false, value: text.slice(lastIndex) });
  }

  const decorate = (segment: string) => {
    let output = segment;
    patterns.forEach((pattern) => {
      output = output.replace(pattern.regex, (token) => {
        const start = `[38;2;${pattern.color}m${
          pattern.underline ? "[4m" : ""
        }`;
        const end = "[39m[24m";
        return `${start}${token}${end}`;
      });
    });
    return output;
  };

  return segments
    .map((seg) => (seg.ansi ? seg.value : decorate(seg.value)))
    .join("");
};

const applyShikiHighlight = (text: string, mode: ShikiMode) => {
  const shouldRun =
    mode === "force" || (mode === "auto" && hasCodeFence(text));
  const withCode = shouldRun ? renderCodeFences(text) : text;
  return applyHighlight(withCode);
};

export const defineHtermElements = () => {
  if (customElements.get(ELEMENT_NAME)) return;

  class StareTerminal extends HTMLElement {
    private _initialized = false;
    private _term: TerminalInstance | null = null;
    private _flashTimer: number | null = null;
    private _friscy: FriscyRuntime | null = null;
    private _mountListener: (() => void) | null = null;
    private _outputBuffer = "";
    private _testOverlay = new Map<string, Uint8Array>();
    private _highlightMode: ShikiMode = "auto";
    private _terminalId = "";
    private _mirroring = false;
    private _deliverFromMultiplicity: ((text: string) => void) | null = null;
    private _indicatorEl: HTMLElement | null = null;
    private _registeredWithMultiplicity = false;

    static get observedAttributes() {
      return ["data-highlight-mode"];
    }

    attributeChangedCallback(
      name: string,
      _oldValue: string | null,
      newValue: string | null,
    ) {
      if (name === "data-highlight-mode") {
        this._highlightMode = normalizeShikiMode(newValue);
      }
    }

    private _appendOutput(chunk: string) {
      this._outputBuffer = `${this._outputBuffer}${chunk}`.slice(-20000);
      this.dataset.outputTail = this._outputBuffer.slice(-200);
    }

    private _shouldShareKeystroke(str: string) {
      if (!str) return false;
      if (str === "\u0003" || str === "\x7f") return false;
      if (str.includes("\u001b")) return false;
      return true;
    }

    private _maybeBroadcastKeystroke(str: string) {
      if (this._mirroring) return;
      if (!this._shouldShareKeystroke(str)) return;
      multiplicityController.inputFrom(this._ensureTerminalId(), str);
    }

    private _ensureTerminalId() {
      if (this._terminalId) return this._terminalId;
      const fallback = `stare-term-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2)}`;
      const generated =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : fallback;
      this._terminalId = generated;
      return generated;
    }

    private _buildMultiplicityIndicator(host: HTMLElement) {
      if (this._indicatorEl) return;
      const indicator = document.createElement("div");
      indicator.className = "stare-multiplicity-indicator";
      indicator.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 2; i += 1) {
        const cursor = document.createElement("span");
        cursor.className = "stare-multiplicity-cursor";
        indicator.appendChild(cursor);
      }
      host.appendChild(indicator);
      this._indicatorEl = indicator;
    }

    private _setMultiplicityIndicatorState(active: boolean) {
      this.classList.toggle("multiplicity-active", active);
      if (this._indicatorEl) {
        this._indicatorEl.dataset.active = active ? "1" : "0";
      }
    }

    private _registerWithMultiplicity() {
      if (this._registeredWithMultiplicity) return;
      multiplicityController.register({
        id: this._ensureTerminalId(),
        deliverInput: (text) => {
          this._deliverFromMultiplicity?.(text);
        },
        setIndicatorState: (active) => {
          this._setMultiplicityIndicatorState(active);
        },
      });
      this._registeredWithMultiplicity = true;
    }

    private _unregisterMultiplicity() {
      if (!this._registeredWithMultiplicity) return;
      multiplicityController.unregister(this._terminalId);
      this._registeredWithMultiplicity = false;
    }

    async connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;

      this.style.display = "block";
      this.style.width = "100%";
      this.style.height = "100%";
      this.style.position = "relative";
      this.classList.add("stare-terminal");

      const host = document.createElement("div");
      host.className = "stare-terminal-host";
      host.style.position = "relative";
      host.style.width = "100%";
      host.style.height = "100%";
      this.appendChild(host);
      this._buildMultiplicityIndicator(host);
      this._highlightMode = normalizeShikiMode(
        this.getAttribute("data-highlight-mode"),
      );

      const hterm = await loadHterm();

      const term = new hterm.Terminal();
      this._term = term as TerminalInstance;

      const prompt = this.getAttribute("data-terminal") || "stare";
      const banner = `${prompt} session ready. type 'help' for commands.`;
      const backend = this.getAttribute("data-backend") || "local";

      let readyFired = false;
      const onReady = () => {
        if (readyFired) return;
        readyFired = true;
        const io = term.io.push();
        let buffer = "";
        const basePrint = io.print.bind(io);
        const basePrintln = io.println.bind(io);
        const highlight = (value: string) =>
          applyShikiHighlight(value, this._highlightMode);
        io.print = (text: string) => {
          const highlighted = highlight(text);
          this._appendOutput(highlighted);
          basePrint(highlighted);
        };
        io.println = (text: string) => {
          const highlighted = highlight(text);
          this._appendOutput(`${highlighted}\n`);
          basePrintln(highlighted);
        };
        const attachKeystrokeHandler = (handler: (str: string) => void) => {
          io.onVTKeystroke = (str: string) => {
            handler(str);
            this._maybeBroadcastKeystroke(str);
          };
        };
        const sendClipboardText = async () => {
          try {
            let text = "";
            if (navigator.clipboard?.readText) {
              text = await navigator.clipboard.readText();
            }
            if (!text && lastPasteFallback) {
              text = lastPasteFallback;
              lastPasteFallback = "";
            }
            if (text) {
              io.sendString?.(text);
              io.print(text);
              this.classList.add("paste-flash");
              if (this._flashTimer) window.clearTimeout(this._flashTimer);
              this._flashTimer = window.setTimeout(() => {
                this.classList.remove("paste-flash");
              }, 220);
            }
          } catch (err) {
            console.warn(err);
          }
        };
        const showPrompt = () => {
          io.print(`\r\n${prompt} $ `);
        };

        const bufferHandler = (str: string) => {
          if (str === "\r") {
            if (buffer.trim() === "help") {
              io.print("\r\ncommands: help, clear");
            } else if (buffer.trim() === "clear") {
              io.print("\u001b[2J\u001b[H");
            }
            buffer = "";
            showPrompt();
            return;
          }

          if (str === "\u0003") {
            io.print("^C");
            buffer = "";
            showPrompt();
            return;
          }

          if (str === "\x7f") {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              io.print("\b \b");
            }
            return;
          }

          buffer += str;
          io.print(str);
        };

        if (backend === "friscy") {
          bootFriscy({
            onStatus: (message) => {
              this.dispatchEvent(
                new CustomEvent("stare:status", {
                  detail: message,
                  bubbles: true,
                }),
              );
            },
            onBoot: (message) => {
              this.dispatchEvent(
                new CustomEvent("stare:boot", {
                  detail: message,
                  bubbles: true,
                }),
              );
            },
            onStdout: (chunk) => {
              const highlighted = highlight(chunk);
              this._appendOutput(highlighted);
              io.print(highlighted);
            },
          })
            .then((runtime) => {
              this._friscy = runtime;
              this.setAttribute("data-ready", "1");
              io.print(`\\r\\n[friscy] alpine booting...\\r\\n`);
              runtime.syncOpfs();
            })
            .catch((err) => {
              io.print(`\\r\\n[friscy] boot error: ${err.message}\\r\\n`);
            });

          attachKeystrokeHandler((str) => {
            this._friscy?.queueInput(str);
          });
          io.sendString = io.onVTKeystroke;
        } else {
          attachKeystrokeHandler(bufferHandler);
          io.sendString = io.onVTKeystroke;
          io.println(banner);
          io.print(`${prompt} $ `);
        }

        this._deliverFromMultiplicity = (text: string) => {
          this._mirroring = true;
          io.sendString?.(text);
          this._mirroring = false;
        };
        this._registerWithMultiplicity();

        let lastPasteFallback = "";
        this.addEventListener("paste", (event) => {
          const text = event.clipboardData?.getData("text") ?? "";
          if (text) lastPasteFallback = text;
        });

        this.addEventListener("keydown", async (event) => {
          const isPaste =
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "v";
          if (isPaste) {
            event.preventDefault();
            await sendClipboardText();
          }
        });

        this.addEventListener("copy", async (event) => {
          const text = (term as any).getSelectionText?.();
          if (!text) return;
          event.preventDefault();
          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(text);
            } else {
              const selection = window.getSelection();
              const range = document.createRange();
              const holder = document.createElement("pre");
              holder.textContent = text;
              holder.style.cssText = "position:fixed; left:-9999px; top:-9999px;";
              document.body.appendChild(holder);
              range.selectNodeContents(holder);
              selection?.removeAllRanges();
              selection?.addRange(range);
              document.execCommand("copy");
              selection?.removeAllRanges();
              holder.remove();
            }
          } catch (err) {
            console.warn(err);
          }
        });
      };
      term.onTerminalReady = onReady;

      term.decorate(host);
      term.setFontFamily("'Maple Mono', monospace");
      term.setFontSize(13);
      term.setCursorBlink(true);
      term.installKeyboard();
      queueMicrotask(() => {
        if (!readyFired) onReady();
      });

      this._mountListener = () => {
        this._friscy?.syncOpfs();
      };
      window.addEventListener("stare:mounts-changed", this._mountListener);
    }

    disconnectedCallback() {
      if (this._mountListener) {
        window.removeEventListener("stare:mounts-changed", this._mountListener);
        this._mountListener = null;
      }
      this._unregisterMultiplicity();
    }

    exportGuestVfs() {
      if ((window as any).__STARE_TEST_STUB__ === true) {
        const tar = buildTestTar(this._testOverlay);
        this._testOverlay.clear();
        return Promise.resolve(tar);
      }
      return this._friscy?.exportVfs() ?? Promise.resolve(null);
    }

    getOutputText() {
      return this._outputBuffer;
    }

    sendInput(text: string) {
      this._friscy?.queueInput(text);
    }

    testWriteFile(path: string, content: string) {
      const normalized = path.replace(/^\/+/, "");
      const bytes = new TextEncoder().encode(content);
      this._testOverlay.set(normalized, bytes);
    }
  }

  customElements.define(ELEMENT_NAME, StareTerminal);
};

let htermPromise: Promise<HtermModule> | null = null;

const TAR_BLOCK_SIZE = 512;

const padOctal = (value: number, length: number) => {
  const str = value.toString(8);
  return str.padStart(length - 1, "0") + "\0";
};

const writeTarHeader = (name: string, size: number, mtime: number) => {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  const encoder = new TextEncoder();
  const setString = (offset: number, len: number, value: string) => {
    const bytes = encoder.encode(value);
    header.set(bytes.subarray(0, len), offset);
  };

  setString(0, 100, name);
  setString(100, 8, "0000777\0");
  setString(108, 8, "0000000\0");
  setString(116, 8, "0000000\0");
  setString(124, 12, padOctal(size, 12));
  setString(136, 12, padOctal(mtime, 12));
  setString(148, 8, "        ");
  header[156] = 48; // '0'
  setString(257, 6, "ustar\0");
  setString(263, 2, "00");

  let sum = 0;
  for (let i = 0; i < header.length; i++) sum += header[i];
  setString(148, 8, padOctal(sum, 8));
  return header;
};

const buildTestTar = (overlay: Map<string, Uint8Array>) => {
  if (overlay.size === 0) return null;
  const chunks: Uint8Array[] = [];
  const now = Math.floor(Date.now() / 1000);
  overlay.forEach((data, path) => {
    const header = writeTarHeader(path, data.length, now);
    chunks.push(header);
    chunks.push(data);
    const remainder = data.length % TAR_BLOCK_SIZE;
    if (remainder !== 0) {
      chunks.push(new Uint8Array(TAR_BLOCK_SIZE - remainder));
    }
  });
  chunks.push(new Uint8Array(TAR_BLOCK_SIZE * 2));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.length;
  }
  return tar.buffer;
};

const loadHterm = async (): Promise<HtermModule> => {
  if (htermPromise) return htermPromise;
  htermPromise = new Promise((resolve, reject) => {
    const w = window as any;
    if (!w.__stareAmd) {
      const modules = new Map<string, any>();
      const resolving = new Map<string, any>();

      const define = (name: string, deps: string[], factory: Function) => {
        modules.set(name, { deps, factory, exports: {} });
      };

      const require = (name: string) => {
        if (resolving.has(name)) return resolving.get(name);
        const mod = modules.get(name);
        if (!mod) throw new Error(`Module not found: ${name}`);
        const { deps, factory } = mod;
        const exportsObj = mod.exports;
        const resolved = deps.map((dep: string) => {
          if (dep === "exports") return exportsObj;
          return require(dep);
        });
        resolving.set(name, exportsObj);
        factory(...resolved);
        return exportsObj;
      };

      w.define = define;
      w.define.amd = true;
      w.__stareAmd = { require };
    }

    const script = document.createElement("script");
    script.src = htermScriptUrl;
    script.async = true;
    script.onload = () => {
      try {
        const terminalMod = w.__stareAmd.require("hterm/terminal");
        const Terminal =
          terminalMod?.default ?? terminalMod?.Terminal ?? terminalMod;
        resolve({ Terminal } as HtermModule);
      } catch (err) {
        reject(err);
      }
    };
    script.onerror = () => reject(new Error("Failed to load hterm"));
    document.head.appendChild(script);
  });

  return htermPromise;
};
