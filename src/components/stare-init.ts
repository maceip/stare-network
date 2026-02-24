import { multiplicityController } from "./terminal/multiplicity-controller";

export const initStare = async () => {
  if (typeof window === "undefined") return;
  if ((window as any).__stareInit) return;
  (window as any).__stareInit = true;

  const { defineHtermElements } = await import("./terminal/hterm-element");
  defineHtermElements();

  if ((window as any).__STARE_TEST_FAST_BOOT__ === true) {
    const terms = Array.from(document.querySelectorAll("stare-terminal")) as
      | HTMLElement[];
    terms.forEach((term) => {
      let buffer = "";
      if (!(term as any).getOutputText) {
        (term as any).getOutputText = () => buffer;
      }
      if (!(term as any).sendInput) {
        (term as any).sendInput = (text: string) => {
          buffer += text;
          term.textContent = buffer;
        };
      }
      term.setAttribute("data-ready", "1");
      term.setAttribute("data-network", "1");
    });
    return;
  }

  const {
    isFsAccessSupported,
    mountHandlesToOpfs,
    handlesFromDragEvent,
    loadHandles,
    saveHandles,
    listOpfsMounts,
  } = await import("./fs/fs-manager");

  const statusEl = document.querySelector(
    ".stare-status-message",
  ) as HTMLElement | null;
  const backendChip = document.querySelector(
    '[data-chip="backend"]',
  ) as HTMLElement | null;
  const syncChip = document.querySelector('[data-chip="sync"]') as
    | HTMLElement
    | null;
  const syncTimeChip = document.querySelector('[data-chip="sync-time"]') as
    | HTMLElement
    | null;

  const reauthBtn = document.querySelector(
    "#stare-reauth-btn",
  ) as HTMLButtonElement | null;
  const rail = document.querySelector(".stare-status-rail") as HTMLElement | null;
  const railToggle = document.querySelector(
    "#stare-rail-toggle",
  ) as HTMLButtonElement | null;
  const railAuto = document.querySelector(
    "#stare-rail-auto",
  ) as HTMLButtonElement | null;

  const setStatus = (message: string) => {
    if (statusEl) statusEl.textContent = message;
  };
  const setBackendChip = (label: string, tone: string) => {
    if (!backendChip) return;
    backendChip.textContent = label;
    backendChip.dataset.tone = tone;
  };
  const setSyncChip = (label: string, tone: string) => {
    if (!syncChip) return;
    syncChip.textContent = label;
    syncChip.dataset.tone = tone;
  };
  const setSyncTime = (label: string) => {
    if (!syncTimeChip) return;
    syncTimeChip.textContent = label;
  };

  multiplicityController.onStateChange((active) => {
    document.body.classList.toggle("multiplicity-mode", active);
  });

  const updateBackendFromStatus = (detail: string) => {
    if (detail.startsWith("booting")) {
      setBackendChip("booting", "warn");
      return;
    }
    if (detail.startsWith("starting")) {
      setBackendChip("starting", "warn");
      return;
    }
    if (detail.startsWith("exit")) {
      setBackendChip("exit", "bad");
      return;
    }
    if (detail.startsWith("opfs:done")) {
      setBackendChip("mounted", "good");
      return;
    }
    if (detail.startsWith("opfs:error")) {
      setBackendChip("mount error", "bad");
      return;
    }
    setBackendChip("running", "good");
  };

  document.addEventListener("stare:status", (event) => {
    const detail = (event as CustomEvent).detail as string;
    setStatus(`guest ${detail}`);
    updateBackendFromStatus(detail);
  });

  document.addEventListener("stare:boot", (event) => {
    const detail = (event as CustomEvent).detail as string;
    setStatus(detail);
    setBackendChip("booting", "warn");
  });

  const setReauthVisible = (visible: boolean) => {
    if (!reauthBtn) return;
    reauthBtn.classList.toggle("hidden", !visible);
  };

  const setRailCollapsed = (collapsed: boolean) => {
    if (!rail) return;
    rail.classList.toggle("collapsed", collapsed);
    railToggle?.setAttribute("aria-pressed", String(collapsed));
    localStorage.setItem("stare-rail-collapsed", collapsed ? "1" : "0");
  };

  const setRailAuto = (auto: boolean) => {
    document.body.classList.toggle("rail-auto", auto);
    railAuto?.setAttribute("aria-pressed", String(auto));
    localStorage.setItem("stare-rail-auto", auto ? "1" : "0");
  };

  const setSyncAuto = (auto: boolean) => {
    document.body.classList.toggle("sync-auto", auto);
    syncAutoBtn?.setAttribute("aria-pressed", String(auto));
    localStorage.setItem("stare-sync-auto", auto ? "1" : "0");
  };

  const popoverList = document.querySelector(
    ".stare-status-popover-list",
  ) as HTMLElement | null;

  const renderMountList = async () => {
    if (!popoverList) return;
    const mounts = await listOpfsMounts();
    popoverList.innerHTML = "";
    if (!mounts.length) {
      const empty = document.createElement("div");
      empty.className = "stare-status-empty";
      empty.textContent = "no mounts yet";
      popoverList.appendChild(empty);
      return;
    }
    mounts.forEach((name) => {
      const row = document.createElement("div");
      row.className = "stare-status-item";
      row.textContent = name;
      popoverList.appendChild(row);
    });
  };

  const mountHandles = async (handles: FileSystemHandle[]) => {
    if (!handles.length) return;
    try {
      setStatus("Mounting...");
      setReauthVisible(false);
      const persistable = handles.filter(
        (handle) => "queryPermission" in handle,
      );
      if (persistable.length) {
        await saveHandles(persistable);
      }
      await mountHandlesToOpfs(handles, (status) => {
        setStatus(status.message);
      });
      await renderMountList();
      document.dispatchEvent(new CustomEvent("stare:mounts-changed"));
    } catch (err) {
      console.error(err);
      setStatus("Permission needed.");
      setReauthVisible(true);
    }
  };

  const boot = async () => {
    if (!isFsAccessSupported()) {
      setStatus("FS API unavailable in this browser.");
      return;
    }

    const stored = await loadHandles();
    if (stored.length) {
      await mountHandles(stored);
    } else {
      await renderMountList();
    }
  };

  boot();

  const mountBtn = document.querySelector(
    "#stare-mount-btn",
  ) as HTMLButtonElement | null;
  const mountFilesBtn = document.querySelector(
    "#stare-mount-files",
  ) as HTMLButtonElement | null;
  const syncBtn = document.querySelector(
    "#stare-sync-btn",
  ) as HTMLButtonElement | null;
  const syncAutoBtn = document.querySelector(
    "#stare-sync-auto",
  ) as HTMLButtonElement | null;

  const collapsedPref = localStorage.getItem("stare-rail-collapsed") === "1";
  const autoPref = localStorage.getItem("stare-rail-auto") === "1";
  const syncAutoPref = localStorage.getItem("stare-sync-auto") === "1";
  setRailCollapsed(collapsedPref);
  setRailAuto(autoPref);
  setSyncAuto(syncAutoPref);

  const reauth = async () => {
    if (!("showDirectoryPicker" in window)) return;
    try {
      const dir = await (window as any).showDirectoryPicker();
      await mountHandles([dir]);
    } catch (err) {
      console.warn(err);
    }
  };

  mountBtn?.addEventListener("click", reauth);
  reauthBtn?.addEventListener("click", reauth);
  railToggle?.addEventListener("click", () => {
    const next = !rail?.classList.contains("collapsed");
    setRailCollapsed(next);
  });
  railAuto?.addEventListener("click", () => {
    const next = !document.body.classList.contains("rail-auto");
    setRailAuto(next);
  });
  syncAutoBtn?.addEventListener("click", () => {
    const next = !document.body.classList.contains("sync-auto");
    setSyncAuto(next);
  });

  mountFilesBtn?.addEventListener("click", async () => {
    if (!("showOpenFilePicker" in window)) return;
    try {
      const files = await (window as any).showOpenFilePicker({
        multiple: true,
      });
      await mountHandles(files);
    } catch (err) {
      console.warn(err);
    }
  });

  let syncInFlight = false;
  let idleTimer: number | null = null;
  let idleSyncScheduled = false;
  const runSync = async () => {
    if (syncInFlight) return;
    syncInFlight = true;
    const term = document.querySelector("stare-terminal") as any;
    if (!term || typeof term.exportGuestVfs !== "function") {
      setStatus("Guest not ready.");
      syncInFlight = false;
      return;
    }
    try {
      setStatus("Syncing guest filesystem...");
      setBackendChip("syncing", "warn");
      setSyncChip("syncing", "warn");
      const tar = await term.exportGuestVfs();
      if (!tar) {
        setStatus("Guest sync failed (no export).");
        setBackendChip("sync failed", "bad");
        setSyncChip("sync failed", "bad");
        syncInFlight = false;
        return;
      }
      const { applyGuestTarToOpfs } = await import("./fs/fs-manager");
      const result = await applyGuestTarToOpfs(tar, { incremental: true });
      setStatus(
        `Guest sync: ${result.written} updated, ${result.skipped} skipped.`,
      );
      setBackendChip("synced", "good");
      setSyncChip(`${result.written}/${result.files}`, "good");
      setSyncTime(`synced ${new Date().toLocaleTimeString()}`);
      document.dispatchEvent(new CustomEvent("stare:mounts-changed"));
    } catch (err) {
      console.error(err);
      setStatus("Guest sync failed.");
      setBackendChip("sync failed", "bad");
      setSyncChip("sync failed", "bad");
      setSyncTime(`sync failed ${new Date().toLocaleTimeString()}`);
    } finally {
      syncInFlight = false;
    }
  };

  syncBtn?.addEventListener("click", runSync);

  const scheduleIdleSync = () => {
    if (!document.body.classList.contains("sync-auto")) return;
    if (syncInFlight) return;
    if (idleSyncScheduled) return;
    idleSyncScheduled = true;
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      idleSyncScheduled = false;
      runSync();
    }, 5000);
  };

  const markActivity = () => {
    if (idleTimer) window.clearTimeout(idleTimer);
    idleSyncScheduled = false;
    scheduleIdleSync();
  };

  window.addEventListener("keydown", markActivity);
  window.addEventListener("pointerdown", markActivity);
  window.addEventListener("mousemove", markActivity, { passive: true });
  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.shiftKey && event.code === "KeyM") {
      event.preventDefault();
      multiplicityController.toggle();
    }
  });

  window.setInterval(() => {
    if (!document.body.classList.contains("sync-auto")) return;
    runSync();
  }, 15000);

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    const handles = await handlesFromDragEvent(event);
    await mountHandles(handles);
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
  };

  const overlay = document.querySelector(
    ".stare-drop-overlay",
  ) as HTMLElement | null;
  const rippleHost = document.querySelector(
    ".stare-drop-ripples",
  ) as HTMLElement | null;
  const dropPanes = Array.from(
    document.querySelectorAll(".stare-terminal-pane"),
  ) as HTMLElement[];
  let dragDepth = 0;

  const showOverlay = () => {
    if (!overlay) return;
    overlay.classList.add("active");
    dropPanes.forEach((pane) => pane.classList.add("drop-target"));
  };

  const hideOverlay = () => {
    if (!overlay) return;
    overlay.classList.remove("active");
    dropPanes.forEach((pane) => pane.classList.remove("drop-target"));
  };

  const spawnRipple = (x: number, y: number) => {
    if (!rippleHost) return;
    const ripple = document.createElement("span");
    ripple.className = "stare-drop-ripple";
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    rippleHost.appendChild(ripple);
    setTimeout(() => ripple.remove(), 900);
  };

  document.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    showOverlay();
  });

  document.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  });

  document.addEventListener("drop", (event) => {
    dragDepth = 0;
    hideOverlay();
    spawnRipple(event.clientX, event.clientY);
  });

  document.addEventListener("drop", handleDrop);
  document.addEventListener("dragover", handleDragOver);

  const panes = Array.from(
    document.querySelectorAll("[data-pane]"),
  ) as HTMLElement[];
  const sessionSeed = Date.now().toString(36).slice(-4);
  panes.forEach((pane, index) => {
    const id = `S-${sessionSeed}-${index + 1}`;
    const badge = pane.querySelector(
      ".stare-terminal-session",
    ) as HTMLElement | null;
    if (badge) badge.textContent = id;
    pane.addEventListener("click", () => {
      panes.forEach((el) => el.classList.remove("active"));
      pane.classList.add("active");
    });
  });
  panes[0]?.classList.add("active");
};
