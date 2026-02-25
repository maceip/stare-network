type NetworkModules = {
  FriscyNetworkBridge: new (
    proxyUrl: string,
    opts: { certHash: string | null },
  ) => {
    connect: () => Promise<void>;
  };
  NetworkRPCHost: new (
    sab: SharedArrayBuffer,
    bridge: any,
    opts: { laneEnabled: boolean },
  ) => { start: () => void };
};

const loadNetworkModules = async (
  basePath: string,
): Promise<NetworkModules> => {
  const dynamicImport = new Function(
    "u",
    "return import(u)",
  ) as (u: string) => Promise<any>;
  const [bridgeMod, hostMod] = await Promise.all([
    dynamicImport(`${basePath}/network_bridge.js`),
    dynamicImport(`${basePath}/network_rpc_host.js`),
  ]);
  return {
    FriscyNetworkBridge: bridgeMod.FriscyNetworkBridge,
    NetworkRPCHost: hostMod.NetworkRPCHost,
  };
};

const CMD_IDLE = 0;
const CMD_STDIN_REQUEST = 2;
const CMD_STDIN_READY = 3;
const CMD_EXIT = 4;
const RING_HEADER = 8;
const RING_SIZE = 65528;

export type FriscyHooks = {
  onStatus: (message: string) => void;
  onBoot: (message: string) => void;
  onStdout: (chunk: string) => void;
};

export type FriscyRuntime = {
  queueInput: (text: string) => void;
  syncOpfs: () => void;
  exportVfs: () => Promise<ArrayBuffer | null>;
  dispose: () => void;
};

const readOptimizationConfig = () => {
  return {
    enableJit: true,
    jitTierEnabled: true,
    timesliceResumeEnabled: true,
    jitPrewarmEnabled: true,
    jitAwaitCompiler: false,
    jitMarkovEnabled: true,
    jitTripletEnabled: true,
    jitTraceEnabled: true,
    jitHotThreshold: 16,
    jitOptimizeThreshold: 64,
    jitSchedulerBudget: 32,
    jitSchedulerConcurrency: 2,
    jitSchedulerQueueMax: 128,
    jitPredictTopK: 4,
    jitPredictConfidence: 60,
    jitEdgeHotThreshold: 8,
    jitTraceTripletHotThreshold: 6,
  };
};

const sanitizeTerminalOutput = (
  text: string,
  stdoutCarryRef: { value: string },
  queueBytes: (bytes: number[]) => void,
) => {
  const DSR_QUERY = "\x1b[6n";
  let combined = stdoutCarryRef.value + text;
  stdoutCarryRef.value = "";

  let idx = combined.indexOf(DSR_QUERY);
  while (idx !== -1) {
    queueBytes([0x1b, 0x5b, 0x31, 0x3b, 0x31, 0x52]);
    combined = combined.slice(0, idx) + combined.slice(idx + DSR_QUERY.length);
    idx = combined.indexOf(DSR_QUERY);
  }

  const parts = ["\x1b", "\x1b[", "\x1b[6"];
  for (const p of parts) {
    if (combined.endsWith(p)) {
      stdoutCarryRef.value = p;
      combined = combined.slice(0, -p.length);
      break;
    }
  }
  return combined;
};

export type FriscyBootOptions = {
  example?: string;
  basePath?: string;
};

export const bootFriscy = async (
  hooks: FriscyHooks,
  options: FriscyBootOptions = {},
): Promise<FriscyRuntime> => {
  const stdinQueue: number[] = [];
  let worker: Worker | null = null;
  let controlView: Int32Array | null = null;
  let controlBytes: Uint8Array | null = null;
  let stdoutView: Int32Array | null = null;
  let stdoutBytes: Uint8Array | null = null;
  let pollId: number | null = null;
  const stdoutCarryRef = { value: "" };
  let exportId = 0;
  const exportWaiters = new Map<
    number,
    { resolve: (data: ArrayBuffer | null) => void; reject: (err: Error) => void }
  >();

  const queueBytes = (bytes: number[]) => {
    for (const b of bytes) stdinQueue.push(b);
  };

  const queueInput = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    queueBytes(Array.from(bytes));
  };

  const checkStdinRequest = () => {
    if (!controlView || !controlBytes) return;
    if (Atomics.load(controlView, 0) !== CMD_STDIN_REQUEST) return;
    if (stdinQueue.length === 0) return;

    const maxLen = Math.max(1, Atomics.load(controlView, 2) || 1);
    const n = Math.min(maxLen, stdinQueue.length, 3968);
    for (let i = 0; i < n; i++) controlBytes[64 + i] = stdinQueue.shift() ?? 0;
    Atomics.store(controlView, 2, n);
    Atomics.store(controlView, 0, CMD_STDIN_READY);
    Atomics.notify(controlView, 0);
  };

  const drainStdout = () => {
    if (!stdoutView || !stdoutBytes) return;
    let writeHead = Atomics.load(stdoutView, 0);
    let readTail = Atomics.load(stdoutView, 1);
    if (writeHead === readTail) return;

    let out = "";
    while (readTail !== writeHead) {
      const b = stdoutBytes[RING_HEADER + readTail];
      out += String.fromCharCode(b);
      readTail = (readTail + 1) % RING_SIZE;
    }
    Atomics.store(stdoutView, 1, readTail);
    if (!out) return;
    const clean = sanitizeTerminalOutput(out, stdoutCarryRef, queueBytes);
    if (clean) hooks.onStdout(clean);
    checkStdinRequest();
  };

  const checkExit = () => {
    if (!controlView) return false;
    if (Atomics.load(controlView, 0) !== CMD_EXIT) return false;
    const code = Atomics.load(controlView, 5);
    hooks.onStatus(`exit:${code}`);
    Atomics.store(controlView, 0, CMD_IDLE);
    return true;
  };

  const fetchArrayBuffer = async (url: string, label: string) => {
    hooks.onBoot(`boot: downloading ${label}...`);
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) throw new Error(`${label} fetch failed: HTTP ${resp.status}`);
    return await resp.arrayBuffer();
  };

  const basePath = options.basePath ?? "/friscy";
  const example = options.example ?? "alpine";
  const manifest = await fetch(`${basePath}/manifest.json`, {
    cache: "no-store",
  }).then((r) => r.json());
  const cfg = manifest.examples?.[example];
  if (!cfg) throw new Error(`unknown example: ${example}`);
  const opt = readOptimizationConfig();

  hooks.onStatus(`booting:${example}`);
  hooks.onBoot(`boot: preparing ${cfg.image ?? example}`);

  const [rootfs, checkpoint] = await Promise.all([
    fetchArrayBuffer(cfg.rootfs, "alpine rootfs"),
    cfg.checkpoint
      ? fetchArrayBuffer(cfg.checkpoint, "alpine checkpoint")
      : Promise.resolve(null),
  ]);

  const allowNetwork = cfg.allowNetwork === true;
  const netSab = allowNetwork ? new SharedArrayBuffer(65536) : null;
  const params = new URLSearchParams(location.search);
  const overrideProxy =
    (window as any).__STARE_PROXY_URL__ || params.get("proxy");
  const fallbackProxy = "https://78.141.219.102:4433/connect";
  const proxyUrl =
    overrideProxy ||
    (location.hostname === "127.0.0.1" || location.hostname === "localhost"
      ? fallbackProxy
      : `https://${location.hostname}:4433/connect`);
  const hostFetchProxy =
    (window as any).__STARE_HOSTFETCH_PROXY__ || params.get("hostFetchProxy");

  const controlSab = new SharedArrayBuffer(4096);
  const stdoutSab = new SharedArrayBuffer(65536);
  controlView = new Int32Array(controlSab);
  controlBytes = new Uint8Array(controlSab);
  stdoutView = new Int32Array(stdoutSab);
  stdoutBytes = new Uint8Array(stdoutSab);

  worker = new Worker(`${basePath}/worker.js`, { type: "module" });

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    worker!.onmessage = (e) => {
      if (e.data?.type === "ready") {
        if (!settled) {
          settled = true;
          resolve();
        }
        return;
      }
      if (e.data?.type === "error") {
        if (!settled) {
          settled = true;
          reject(new Error(e.data.message || "worker error"));
        }
        return;
      }
      if (e.data?.type === "net_ready") {
        hooks.onBoot(`boot: network lane ready (${proxyUrl})`);
        return;
      }
      if (e.data?.type === "net_error") {
        hooks.onStdout(`\r\n[net] lane error: ${e.data.message || "unknown"}\r\n`);
        hooks.onBoot("boot: network lane failed");
      }
      if (e.data?.type === "vfs_export") {
        const id = Number(e.data.requestId ?? 0);
        const waiter = exportWaiters.get(id);
        if (waiter) {
          exportWaiters.delete(id);
          waiter.resolve(e.data.tarData || null);
        }
        return;
      }
      if (e.data?.type === "opfs_sync") {
        const status = e.data.status || "done";
        const files = e.data.files ?? 0;
        hooks.onStatus(`opfs:${status}:${files}`);
      }
    };
    worker!.onerror = (e) => reject(new Error(e.message || "worker failed"));
  });

  worker.postMessage({
    type: "init",
    controlSab,
    stdoutSab,
    netSab,
    hostFetchProxy: allowNetwork ? hostFetchProxy ?? null : null,
    allowNetwork,
    allowInsecure: (window as any).__STARE_ALLOW_INSECURE__ === true,
    ...opt,
  });
  await ready;

  if (allowNetwork) {
    let bridgeForHost: any = null;
    const { FriscyNetworkBridge, NetworkRPCHost } =
      await loadNetworkModules(basePath);
    try {
      bridgeForHost = new FriscyNetworkBridge(proxyUrl, { certHash: null });
      await Promise.race([
        bridgeForHost.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("proxy connect timeout")), 10000),
        ),
      ]);
      hooks.onBoot(`boot: network bridge connected (${proxyUrl})`);
    } catch (e: any) {
      hooks.onStdout(
        `\r\n[net] bridge unavailable: ${(e && e.message) || e}\r\n`,
      );
      hooks.onBoot("boot: network bridge unavailable (socket calls return ENOTCONN)");
      bridgeForHost = {
        socketCreate: async () => 0,
        socketConnect: async () => -107,
        socketBind: async () => -107,
        socketListen: async () => -107,
        socketAccept: async () => ({ result: -11, addr: null }),
        socketSend: async () => -107,
        socketRecv: async () => null,
        socketClose: async () => 0,
        socketHasData: async () => 0,
        socketHasPendingAccept: async () => 0,
        socketShutdown: async () => 0,
      };
    }

    const netRpcHost = new NetworkRPCHost(netSab!, bridgeForHost, {
      laneEnabled: false,
    });
    netRpcHost.start();
  }

  hooks.onBoot(`boot: launching guest ${cfg.image}`);
  const entry = Array.isArray(cfg.entrypoint)
    ? cfg.entrypoint
    : String(cfg.entrypoint || "").split(" ");
  const envArgs = [...(manifest.env || []), ...(cfg.env || [])].flatMap(
    (e: string) => ["--env", e],
  );
  const args = [...envArgs, "--rootfs", "/rootfs.tar", ...entry];
  const msg: any = {
    type: "run",
    args,
    rootfsData: rootfs,
  };
  const transfers: ArrayBuffer[] = [rootfs];
  if (checkpoint) {
    msg.checkpointData = checkpoint;
    transfers.push(checkpoint as ArrayBuffer);
  }
  worker.postMessage(msg, transfers);

  if (pollId) window.clearInterval(pollId);
  pollId = window.setInterval(() => {
    drainStdout();
    checkStdinRequest();
    checkExit();
  }, 16);

  hooks.onStatus(`starting:${example}`);
  hooks.onBoot(`boot: launching ${cfg.image} (waiting for stdin)`);

  return {
    queueInput,
    syncOpfs: () => {
      if (!worker) return;
      worker.postMessage({ type: "sync_opfs_mounts" });
    },
    exportVfs: () => {
      if (!worker) return Promise.resolve(null);
      const id = ++exportId;
      worker.postMessage({ type: "export_vfs", requestId: id });
      return new Promise((resolve, reject) => {
        exportWaiters.set(id, { resolve, reject });
        window.setTimeout(() => {
          if (exportWaiters.has(id)) {
            exportWaiters.delete(id);
            reject(new Error("VFS export timeout"));
          }
        }, 20000);
      });
    },
    dispose: () => {
      if (pollId) window.clearInterval(pollId);
      worker?.terminate();
    },
  };
};
