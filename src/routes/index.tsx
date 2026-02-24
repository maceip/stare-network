import { component$, useTask$, isServer } from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";

export default component$(() => {
  useTask$(async () => {
    if (isServer) return;
    const { initStare } = await import("../components/stare-init");
    await initStare();
  });

  return (
    <>
      <div class="stare-page">
        <nav class="stare-nav">
          <div class="stare-brand">stare.network</div>
          <div class="stare-links">
            <a href="/docs">docs</a>
            <a href="https://github.com/" target="_blank" rel="noreferrer">
              github
            </a>
            <button class="stare-login">login</button>
          </div>
        </nav>

        <main class="stare-shell">
          <section class="stare-terminal-pane terminal-a" data-pane>
            <header class="stare-terminal-title">
              <div class="stare-terminal-left">
                <span class="stare-terminal-dot"></span>
                <span class="stare-terminal-name">alpine</span>
                <span class="stare-terminal-session">S-----</span>
              </div>
              <div class="stare-terminal-right">
                <span class="stare-terminal-chip" data-chip="latency">
                  lat 18ms
                </span>
                <span class="stare-terminal-chip" data-chip="backend">
                  booting
                </span>
                <span class="stare-terminal-chip" data-chip="sync">
                  sync idle
                </span>
                <span class="stare-terminal-chip" data-chip="sync-time">
                  synced --:--
                </span>
                <button class="stare-terminal-btn ghost">⋯</button>
              </div>
            </header>
            <stare-terminal
              data-terminal="alpine"
              data-backend="friscy"
              data-example="alpine"
              data-base-path="/friscy-golden"
              data-network="1"
            ></stare-terminal>
          </section>

          <section class="stare-terminal-pane terminal-b" data-pane>
            <header class="stare-terminal-title">
              <div class="stare-terminal-left">
                <span class="stare-terminal-dot"></span>
                <span class="stare-terminal-name">nodejs</span>
                <span class="stare-terminal-session">S-----</span>
              </div>
              <div class="stare-terminal-right">
                <span class="stare-terminal-chip" data-chip="latency">
                  lat 18ms
                </span>
                <span class="stare-terminal-chip" data-chip="backend">
                  booting
                </span>
                <span class="stare-terminal-chip" data-chip="sync">
                  sync idle
                </span>
                <span class="stare-terminal-chip" data-chip="sync-time">
                  synced --:--
                </span>
                <button class="stare-terminal-btn ghost">⋯</button>
              </div>
            </header>
            <stare-terminal
              data-terminal="nodejs"
              data-backend="friscy"
              data-example="nodejs"
              data-base-path="/friscy-golden"
              data-network="1"
            ></stare-terminal>
          </section>

          <section class="stare-terminal-pane terminal-c" data-pane>
            <header class="stare-terminal-title">
              <div class="stare-terminal-left">
                <span class="stare-terminal-dot"></span>
                <span class="stare-terminal-name">claude-cli</span>
                <span class="stare-terminal-session">S-----</span>
              </div>
              <div class="stare-terminal-right">
                <span class="stare-terminal-chip" data-chip="latency">
                  lat 18ms
                </span>
                <span class="stare-terminal-chip" data-chip="backend">
                  booting
                </span>
                <span class="stare-terminal-chip" data-chip="sync">
                  sync idle
                </span>
                <span class="stare-terminal-chip" data-chip="sync-time">
                  synced --:--
                </span>
                <button class="stare-terminal-btn ghost">⋯</button>
              </div>
            </header>
            <stare-terminal
              data-terminal="claude-cli"
              data-backend="friscy"
              data-example="claude-cli"
              data-base-path="/friscy-golden"
              data-network="1"
            ></stare-terminal>
          </section>
        </main>

        <div class="stare-status-rail">
          <div class="stare-status-message">
            drag & drop a folder or click mount
          </div>
          <div class="stare-status-actions">
            <button id="stare-mount-btn" class="stare-status-action">
              mount
            </button>
            <button id="stare-mount-files" class="stare-status-action secondary">
              files
            </button>
            <button id="stare-sync-btn" class="stare-status-action ghost">
              sync
            </button>
            <button id="stare-sync-auto" class="stare-status-action ghost">
              sync auto
            </button>
            <button
              id="stare-reauth-btn"
              class="stare-status-action danger hidden"
            >
              reauth
            </button>
            <div class="stare-status-popover">
              <button class="stare-status-action ghost">mounts</button>
              <div class="stare-status-popover-card">
                <div class="stare-status-popover-title">mounted</div>
                <div class="stare-status-popover-list"></div>
              </div>
            </div>
            <button id="stare-rail-auto" class="stare-status-action ghost">
              auto
            </button>
            <button id="stare-rail-toggle" class="stare-status-action ghost">
              hide
            </button>
          </div>
        </div>

        <div class="stare-drop-overlay">
          <div class="stare-drop-mesh"></div>
          <div class="stare-drop-ripples"></div>
          <div class="stare-drop-label">drop to mount</div>
        </div>
      </div>
    </>
  );
});

export const head: DocumentHead = {
  title: "Welcome to Qwik",
  meta: [
    {
      name: "description",
      content: "Qwik site description",
    },
  ],
};
