import { component$, useSignal, useTask$, $ } from "@qwik.dev/core";

const prompt = "stare3";

export default component$(() => {
  const input = useSignal("");
  const history = useSignal<string[]>([]);
  const historyIndex = useSignal(-1);
  const output = useSignal<string[]>([
    "STARE 3 terminal shell online.",
    "Type `help` for available commands.",
  ]);

  const searchMode = useSignal(false);
  const searchQuery = useSignal("");
  const searchMatch = useSignal("");
  const outputEndRef = useSignal<HTMLElement>();

  const updateSearchMatch = $(() => {
    if (!searchQuery.value) {
      searchMatch.value = "";
      return;
    }
    const reversed = [...history.value].reverse();
    const match = reversed.find((line) =>
      line.toLowerCase().includes(searchQuery.value.toLowerCase()),
    );
    searchMatch.value = match ?? "";
  });

  const pushOutput = $((line: string) => {
    output.value = [...output.value, line];
  });

  const runCommand = $((command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;

    if (trimmed === "help") {
      output.value = [
        ...output.value,
        "Available commands:",
        "  help    Show this list",
        "  clear   Clear the terminal",
      ];
      return;
    }

    if (trimmed === "clear") {
      output.value = [];
      return;
    }

    output.value = [...output.value, `Command not found: ${trimmed}`];
  });

  useTask$(({ track }) => {
    track(() => output.value.length);
    if (typeof document === "undefined") return;
    outputEndRef.value?.scrollIntoView({ block: "end" });
  });

  return (
    <div class="stare-terminal">
      <div class="stare-terminal-header">
        <div>
          <span class="stare-terminal-status" />
          SESSION: A-003
        </div>
        <div class="stare-terminal-meta">CTRL+R search · SHIFT+ENTER newline</div>
      </div>

      <div class="stare-terminal-body" role="log" aria-live="polite">
        {output.value.map((line, index) => (
          <div key={`line-${index}`} class="stare-terminal-line">
            {line}
          </div>
        ))}
        {searchMode.value && (
          <div class="stare-terminal-search">
            <span class="label">(reverse-i-search)</span>
            <span class="query">`{searchQuery.value}`</span>
            <span class="match">{searchMatch.value}</span>
          </div>
        )}
        <div class="stare-terminal-prompt">
          <span class="prompt">{prompt}</span>
          <span class="path">~/</span>
          <span class="caret">›</span>
          <textarea
            class="stare-terminal-input"
            rows={1}
            value={input.value}
            onInput$={(event) => {
              input.value = (event.target as HTMLTextAreaElement).value;
            }}
            onKeyDown$={async (event) => {
              if (searchMode.value) {
                if (event.key === "Escape") {
                  searchMode.value = false;
                  searchQuery.value = "";
                  searchMatch.value = "";
                  event.preventDefault();
                  return;
                }

                if (event.key === "Enter") {
                  if (searchMatch.value) {
                    input.value = searchMatch.value;
                  }
                  searchMode.value = false;
                  searchQuery.value = "";
                  searchMatch.value = "";
                  event.preventDefault();
                  return;
                }

                if (event.key === "Backspace") {
                  searchQuery.value = searchQuery.value.slice(0, -1);
                  await updateSearchMatch();
                  event.preventDefault();
                  return;
                }

                if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
                  searchQuery.value += event.key;
                  await updateSearchMatch();
                  event.preventDefault();
                }
                return;
              }

              if (event.ctrlKey && event.key.toLowerCase() === "r") {
                searchMode.value = true;
                searchQuery.value = "";
                await updateSearchMatch();
                event.preventDefault();
                return;
              }

              if (event.ctrlKey && event.key.toLowerCase() === "l") {
                output.value = [];
                event.preventDefault();
                return;
              }

              if (event.ctrlKey && event.key.toLowerCase() === "c") {
                await pushOutput(`^C`);
                input.value = "";
                historyIndex.value = -1;
                event.preventDefault();
                return;
              }

              if (event.key === "ArrowUp") {
                if (!history.value.length) return;
                if (historyIndex.value === -1) {
                  historyIndex.value = history.value.length - 1;
                } else {
                  historyIndex.value = Math.max(0, historyIndex.value - 1);
                }
                input.value = history.value[historyIndex.value] ?? "";
                event.preventDefault();
                return;
              }

              if (event.key === "ArrowDown") {
                if (historyIndex.value === -1) return;
                if (historyIndex.value >= history.value.length - 1) {
                  historyIndex.value = -1;
                  input.value = "";
                } else {
                  historyIndex.value += 1;
                  input.value = history.value[historyIndex.value] ?? "";
                }
                event.preventDefault();
                return;
              }

              if (event.key === "Enter" && !event.shiftKey) {
                const command = input.value;
                if (!command.trim()) {
                  event.preventDefault();
                  return;
                }
                await pushOutput(`${prompt} ~/ › ${command}`);
                history.value = [...history.value, command];
                historyIndex.value = -1;
                input.value = "";
                await runCommand(command);
                event.preventDefault();
              }
            }}
          />
        </div>
        <span ref={outputEndRef} />
      </div>
    </div>
  );
});
