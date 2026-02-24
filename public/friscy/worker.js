// worker.js - Web Worker entry point for friscy emulator
//
// Runs the Emscripten-compiled RISC-V emulator in a dedicated Worker thread.
// Communicates with the main thread via SharedArrayBuffer + Atomics for:
//   - stdout/stderr output (ring buffer, worker writes, main reads)
//   - stdin input (Atomics.wait blocks worker until main provides data)
//   - network RPC (socket operations via main thread's WebTransport)
//   - control commands (start, stop, resize terminal)
//
// This eliminates JSPI and setTimeout polling -- the worker can block freely
// on Atomics.wait() without freezing the browser UI.

console.log('[worker] Module loading...');

// JIT manager — loaded lazily inside init
let jitManager = {
    jitCompiler: null,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    init(_m) {},
    loadCompiler() { return Promise.resolve(); },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    execute(_p, _s) { return null; },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    recordExecution(_p) {},
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    recordTraceTransition(_f, _t) {},
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    configureTiering(_c) {},
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    configureScheduler(_c) {},
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    configurePredictor(_c) {},
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    configureTrace(_c) {},
    getStats() { return null; },
};
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let installInvalidationHook = (_m) => {};
let lastJitStatsPostMs = 0;
const JIT_STATS_POST_INTERVAL_MS = 250;

// Control SAB layout (4KB):
//   [0]   i32: command   (0=idle, 1=stdout, 2=stdin_request, 3=stdin_ready,
//                          4=exit, 5=network_rpc, 6=resize, 7=network_rpc_done)
//   [4]   i32: status    (0=pending, 1=ready, 2=error)
//   [8]   i32: length    (payload size)
//   [12]  i32: fd        (file descriptor)
//   [16]  i32: result    (return value)
//   [20]  i32: exit_code
//   [24]  i32: cols      (terminal columns)
//   [28]  i32: rows      (terminal rows)
//   [64+] u8[3968]: payload

const CMD_IDLE = 0;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CMD_STDOUT = 1;
const CMD_STDIN_REQUEST = 2;
const CMD_STDIN_READY = 3;
const CMD_EXIT = 4;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CMD_NETWORK_RPC = 5;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CMD_RESIZE = 6;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CMD_NETWORK_RPC_DONE = 7;
const CMD_EXPORT_VFS = 8;
const CMD_EXPORT_CHECKPOINT = 9;

const STOP_REASON_NONE = 0;
const STOP_REASON_STDIN = 1 << 0;
const STOP_REASON_HOST_FETCH = 1 << 1;
const STOP_REASON_TIMESLICE = 1 << 2;

// Network RPC operation codes (stored in payload[0])
const NET_OP_SOCKET_CREATE = 1;
const NET_OP_CONNECT = 2;
const NET_OP_BIND = 3;
const NET_OP_LISTEN = 4;
const NET_OP_ACCEPT = 5;
const NET_OP_SEND = 6;
const NET_OP_RECV = 7;
const NET_OP_CLOSE = 8;
const NET_OP_HAS_DATA = 9;
const NET_OP_HAS_PENDING_ACCEPT = 10;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const NET_OP_SETSOCKOPT = 11;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const NET_OP_GETSOCKOPT = 12;
const NET_OP_SHUTDOWN = 13;

// Ring buffer layout (64KB stdout_sab):
//   [0]   i32: write_head (worker writes here)
//   [4]   i32: read_tail  (main reads here)
//   [8+]  u8[65528]: ring data

const RING_HEADER = 8;
const RING_SIZE = 65528;

// Network SAB layout (64KB net_sab):
//   [0]   i32: lock       (Atomics.wait/notify coordination)
//   [4]   i32: op         (NET_OP_*)
//   [8]   i32: fd         (socket file descriptor)
//   [12]  i32: arg1       (operation-specific)
//   [16]  i32: arg2       (operation-specific)
//   [20]  i32: result     (return value from main thread)
//   [24]  i32: data_len   (payload data length)
//   [64+] u8[65472]: data payload (for send/recv/connect address)

const NET_HEADER = 64;
const NET_DATA_SIZE = 65472;

let controlView = null;
let controlBytes = null;
let stdoutView = null;
let stdoutBytes = null;
let netView = null;
let netBytes = null;
let emModule = null;
let timesliceResumeEnabled = true;
let jitPrewarmEnabled = true;
let vfsExportRequestId = 0;
const TAR_BLOCK_SIZE = 512;

let netWorker = null;
let netRpcId = 1;
const pendingRpcs = new Map();
let netLaneReady = false;
let netLaneInitError = null;

const encoder = new TextEncoder();

/**
 * Write bytes to the stdout ring buffer.
 */
function writeStdoutRing(data) {
    if (!stdoutView || !stdoutBytes) return;

    const writeHead = Atomics.load(stdoutView, 0);
    const readTail = Atomics.load(stdoutView, 1);

    // Available space in ring
    let available;
    if (writeHead >= readTail) {
        available = RING_SIZE - (writeHead - readTail) - 1;
    } else {
        available = readTail - writeHead - 1;
    }

    const len = Math.min(data.length, available);
    if (len === 0) return;

    let pos = writeHead;
    for (let i = 0; i < len; i++) {
        stdoutBytes[RING_HEADER + pos] = data[i];
        pos = (pos + 1) % RING_SIZE;
    }

    Atomics.store(stdoutView, 0, pos);
    Atomics.notify(stdoutView, 0);
}

/**
 * Request stdin data from main thread.
 */
function requestStdin(maxLen) {
    if (!controlView || !controlBytes) return new Uint8Array(0);

    Atomics.store(controlView, 2, maxLen);
    Atomics.store(controlView, 0, CMD_STDIN_REQUEST);
    Atomics.notify(controlView, 0);

    while (true) {
        const cmd = Atomics.load(controlView, 0);
        if (cmd === CMD_STDIN_READY) break;
        Atomics.wait(controlView, 0, cmd, 100);
    }

    const len = Atomics.load(controlView, 2);
    if (len <= 0) return new Uint8Array(0);

    const result = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        result[i] = controlBytes[64 + i];
    }

    Atomics.store(controlView, 0, CMD_IDLE);
    return result;
}

function padOctal(value, length) {
    const str = value.toString(8);
    return str.padStart(length - 1, '0') + '\0';
}

function writeTarHeader(name, size, mtime, type) {
    const header = new Uint8Array(TAR_BLOCK_SIZE);
    const encoder = new TextEncoder();
    const setString = (offset, len, value) => {
        const bytes = encoder.encode(value);
        header.set(bytes.subarray(0, len), offset);
    };

    setString(0, 100, name);
    setString(100, 8, padOctal(type === 'dir' ? 0o755 : 0o644, 8));
    setString(108, 8, padOctal(0, 8));
    setString(116, 8, padOctal(0, 8));
    setString(124, 12, padOctal(size, 12));
    setString(136, 12, padOctal(mtime, 12));
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    header[156] = type === 'dir' ? 53 : 48;
    setString(257, 6, 'ustar');
    setString(263, 2, '00');
    setString(265, 32, 'stare');
    setString(297, 32, 'stare');

    let sum = 0;
    for (let i = 0; i < header.length; i++) sum += header[i];
    const checksum = padOctal(sum, 8);
    setString(148, 8, checksum);

    return header;
}

function alignSize(size) {
    return Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}

function buildTarFromEntries(entries) {
    const chunks = [];
    let total = 0;
    for (const entry of entries) {
        chunks.push(entry.header);
        total += entry.header.length;
        if (entry.data && entry.data.length) {
            chunks.push(entry.data);
            total += entry.data.length;
            const padLen = alignSize(entry.data.length) - entry.data.length;
            if (padLen > 0) {
                chunks.push(new Uint8Array(padLen));
                total += padLen;
            }
        }
    }
    chunks.push(new Uint8Array(TAR_BLOCK_SIZE * 2));
    total += TAR_BLOCK_SIZE * 2;

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out.buffer;
}

function collectHostEntries(rootPath, tarPrefix) {
    const entries = [];
    const walk = (path, rel) => {
        const list = emModule.FS.readdir(path).filter((n) => n !== '.' && n !== '..');
        for (const name of list) {
            const full = `${path}/${name}`;
            const relPath = rel ? `${rel}/${name}` : name;
            const stat = emModule.FS.stat(full);
            const mtime = Math.floor(stat.mtime?.getTime?.() ? stat.mtime.getTime() / 1000 : Date.now() / 1000);
            if (emModule.FS.isDir(stat.mode)) {
                const header = writeTarHeader(`${tarPrefix}/${relPath}/`, 0, mtime, 'dir');
                entries.push({ header, data: null });
                walk(full, relPath);
            } else if (emModule.FS.isFile(stat.mode)) {
                const data = emModule.FS.readFile(full);
                const header = writeTarHeader(`${tarPrefix}/${relPath}`, data.length, mtime, 'file');
                entries.push({ header, data });
            }
        }
    };
    walk(rootPath, '');
    return entries;
}

function exportHostOverlayTar() {
    const hostPath = '/mnt/host';
    try {
        emModule.FS.stat(hostPath);
    } catch (e) {
        return null;
    }
    const entries = collectHostEntries(hostPath, 'mnt/host');
    return buildTarFromEntries(entries);
}

async function copyOpfsDir(dirHandle, targetPath) {
    let fileCount = 0;
    for await (const [name, handle] of dirHandle.entries()) {
        const childPath = `${targetPath}/${name}`;
        if (handle.kind === 'directory') {
            try {
                emModule.FS.mkdirTree(childPath);
            } catch (e) {
                // ignore mkdir errors
            }
            fileCount += await copyOpfsDir(handle, childPath);
        } else {
            const file = await handle.getFile();
            const buf = await file.arrayBuffer();
            emModule.FS.writeFile(childPath, new Uint8Array(buf));
            fileCount += 1;
        }
    }
    return fileCount;
}

async function syncOpfsMounts() {
    if (!emModule || !emModule.FS) return { files: 0 };
    if (!navigator.storage || !navigator.storage.getDirectory) {
        throw new Error('OPFS not available');
    }
    const root = await navigator.storage.getDirectory();
    let mountsHandle = null;
    try {
        mountsHandle = await root.getDirectoryHandle('stare-mounts');
    } catch (e) {
        return { files: 0 };
    }
    const targetRoot = '/mnt/host';
    try {
        emModule.FS.mkdirTree(targetRoot);
    } catch (e) {
        // ignore if exists
    }
    const files = await copyOpfsDir(mountsHandle, targetRoot);
    return { files };
}

/**
 * Send a network RPC to the main thread and block until response.
 */
function networkRPC(op, fd, arg1, arg2, data) {
    if (!netView || !netBytes) return { result: -38, data: null };
    if (!netWorker) {
        // Fallback or JSPI environment - if not WebTransport proxy
        Atomics.store(netView, 1, op);
        Atomics.store(netView, 2, fd);
        Atomics.store(netView, 3, arg1);
        Atomics.store(netView, 4, arg2);

        if (data && data.length > 0) {
            const len = Math.min(data.length, NET_DATA_SIZE);
            Atomics.store(netView, 6, len);
            netBytes.set(data.subarray(0, len), NET_HEADER);
        } else {
            Atomics.store(netView, 6, 0);
        }

        Atomics.store(netView, 0, 1);
        Atomics.notify(netView, 0);

        while (true) {
            const lock = Atomics.load(netView, 0);
            if (lock === 2) break;
            Atomics.wait(netView, 0, lock, 100);
        }

        const result = Atomics.load(netView, 5);
        const respLen = Atomics.load(netView, 6);
        let respData = null;
        if (respLen > 0) {
            respData = new Uint8Array(respLen);
            for (let i = 0; i < respLen; i++) {
                respData[i] = netBytes[NET_HEADER + i];
            }
        }

        Atomics.store(netView, 0, 0);
        return { result, data: respData };
    }

    // Modern isolated network lane via net_lane_worker
    if (!netLaneReady) {
        // Fail fast while lane is still initializing or failed. This avoids
        // indefinite waits that make the guest look hung.
        return { result: -107, data: null }; // ENOTCONN
    }
    const id = netRpcId++;
    netWorker.postMessage({
        type: 'rpc', id, op, fd, arg1, arg2, 
        data: data ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null
    }, data ? [data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)] : []);

    // We still have to block the worker thread so Wasm doesn't continue until the socket responds
    // Emscripten Asyncify could be used, but since we are in a worker, Atomics is easier.
    // However, since netWorker runs asynchronously, it cannot wake us if we block on `Atomics.wait` 
    // unless another thread updates it.
    // So we use Atomics.wait on `netView` to sleep, and let the `onmessage` of `netWorker` wake us up!
    
    Atomics.store(netView, 0, 1);
    Atomics.store(netView, 7, id);
    
    while (true) {
        const lock = Atomics.load(netView, 0);
        if (lock === 2 && Atomics.load(netView, 7) === id) break;
        Atomics.wait(netView, 0, lock, 100);
    }

    const result = Atomics.load(netView, 5);
    const respLen = Atomics.load(netView, 6);
    let respData = null;
    if (respLen > 0) {
        respData = new Uint8Array(respLen);
        for (let i = 0; i < respLen; i++) {
            respData[i] = netBytes[NET_HEADER + i];
        }
    }

    Atomics.store(netView, 0, 0);
    return { result, data: respData };
}

/**
 * Signal program exit to main thread.
 */
function signalExit(exitCode) {
    if (!controlView) return;
    Atomics.store(controlView, 5, exitCode);
    Atomics.store(controlView, 0, CMD_EXIT);
    Atomics.notify(controlView, 0);
}

function maybePostJitStats(force = false) {
    if (!jitManager || typeof jitManager.getStats !== 'function') return;
    const now = Date.now();
    if (!force && now - lastJitStatsPostMs < JIT_STATS_POST_INTERVAL_MS) return;
    lastJitStatsPostMs = now;
    try {
        const stats = jitManager.getStats();
        if (stats) {
            self.postMessage({ type: 'jit_stats', stats, ts: now });
        }
    } catch (_e) {
        // ignore
    }
}

function getStopReason(friscy_stop_reason, friscy_stopped) {
    if (typeof friscy_stop_reason === 'function') {
        const mask = friscy_stop_reason() | 0;
        return Number.isFinite(mask) ? mask : STOP_REASON_NONE;
    }
    // Backwards compatibility with older runtimes.
    return (typeof friscy_stopped === 'function' && friscy_stopped())
        ? STOP_REASON_STDIN
        : STOP_REASON_NONE;
}

/**
 * Run the resume loop.
 */
async function runResumeLoop() {
    console.log('[worker] entering resume loop');
    let resumeCount = 0;
    const loopStartMs = Date.now();
    const telemetry = {
        stopStdin: 0,
        stopHostFetch: 0,
        stopTimeslice: 0,
        timesliceResumeAttempts: 0,
        jitDispatches: 0,
        jitFallbacks: 0,
        jitDirectRuns: 0,
        jitRegionMisses: 0,
        jitSyscalls: 0,
        jitHalts: 0,
    };
    let telemetryFlushed = false;
    const flushTelemetry = (outcome) => {
        if (telemetryFlushed) return;
        telemetryFlushed = true;
        const elapsedMs = Date.now() - loopStartMs;
        let jitSummary = null;
        try {
            if (jitManager && typeof jitManager.getStats === 'function') {
                const s = jitManager.getStats();
                jitSummary = {
                    compiledRegionCount: s?.compiledRegionCount ?? null,
                    compileFailures: s?.compileFailures ?? null,
                    queueDepth: s?.queueDepth ?? null,
                    prewarmAttempts: s?.prewarmAttempts ?? null,
                    prewarmSuccesses: s?.prewarmSuccesses ?? null,
                    prewarmFailures: s?.prewarmFailures ?? null,
                    compilerPrewarmed: s?.compilerPrewarmed ?? null,
                    firstCompileLatencyMs: s?.firstCompileLatencyMs ?? null,
                };
            }
        } catch (_e) {
            // ignore stats fetch errors
        }
        console.log(`[worker] resume telemetry ${JSON.stringify({
            outcome,
            elapsedMs,
            resumeCount,
            timesliceResumeEnabled,
            ...telemetry,
            jitSummary,
        })}`);
    };
    const friscy_stopped = emModule._friscy_stopped;
    const friscy_stop_reason = emModule._friscy_stop_reason;
    const friscy_resume = emModule._friscy_resume;
    const friscy_get_pc = emModule._friscy_get_pc;
    const friscy_set_pc = emModule._friscy_set_pc;
    const friscy_get_state_ptr = emModule._friscy_get_state_ptr;
    const friscy_host_fetch_pending = emModule._friscy_host_fetch_pending;
    const friscy_get_fetch_request = emModule._friscy_get_fetch_request;
    const friscy_get_fetch_request_len = emModule._friscy_get_fetch_request_len;
    const friscy_set_fetch_response = emModule._friscy_set_fetch_response;

    while (true) {
        const rawStopReason = getStopReason(friscy_stop_reason, friscy_stopped);
        if (rawStopReason & STOP_REASON_STDIN) telemetry.stopStdin++;
        if (rawStopReason & STOP_REASON_HOST_FETCH) telemetry.stopHostFetch++;
        if (rawStopReason & STOP_REASON_TIMESLICE) telemetry.stopTimeslice++;
        const stopReason = timesliceResumeEnabled
            ? rawStopReason
            : (rawStopReason & ~STOP_REASON_TIMESLICE);

        if (stopReason === STOP_REASON_NONE) {
            flushTelemetry('finished');
            console.log(`[worker] resume loop: machine finished after ${resumeCount} resumes`);
            return;
        }

        while (self._isSuspended) {
            await new Promise(r => setTimeout(r, 100));
        }

        if (!controlView || !controlBytes) break;

        const currentCmd = Atomics.load(controlView, 0);
        if (currentCmd === CMD_EXPORT_VFS) {
            Atomics.store(controlView, 0, CMD_IDLE);
            try {
                const tarData = exportHostOverlayTar();
                if (tarData) {
                    self.postMessage({ type: 'vfs_export', tarData, requestId: vfsExportRequestId }, [tarData]);
                } else {
                    self.postMessage({ type: 'vfs_export', tarData: null, requestId: vfsExportRequestId });
                }
            } catch (e) {
                console.error('[worker] VFS export failed:', e.message);
                self.postMessage({ type: 'vfs_export', tarData: null, requestId: vfsExportRequestId });
            }
        }

        if (currentCmd === CMD_EXPORT_CHECKPOINT) {
            Atomics.store(controlView, 0, CMD_IDLE);
            try {
                const liveExport = emModule._friscy_save_live_checkpoint || emModule._friscy_export_checkpoint;
                if (!liveExport) {
                    throw new Error('No checkpoint export function available');
                }
                const sizePtr = emModule._malloc(4);
                const dataPtr = liveExport(sizePtr);
                const size = Number(emModule.HEAPU32[Number(sizePtr) >> 2]);
                emModule._free(sizePtr);
                if (!dataPtr || size <= 0) {
                    throw new Error('Live checkpoint export returned empty payload');
                }
                const ptr = dataPtr >>> 0;
                const copy = new Uint8Array(emModule.HEAPU8.buffer, ptr, size).slice();
                emModule._free(ptr);
                self.postMessage({
                    type: 'checkpoint-exported-live',
                    data: copy,
                    metrics: { bytes: copy.length },
                }, [copy.buffer]);
            } catch (e) {
                console.error('[worker] Live export failed (resume loop):', e.message, e.stack);
                self.postMessage({ type: 'checkpoint-export-error', message: e.message, stack: e.stack });
            }
        }

        if (stopReason & STOP_REASON_STDIN) {
            const cmd = Atomics.load(controlView, 0);
            if (cmd === CMD_STDIN_READY) {
                const len = Atomics.load(controlView, 2);
                if (len > 0) {
                    for (let i = 0; i < len; i++) {
                        emModule._stdinBuffer.push(controlBytes[64 + i]);
                    }
                }
                Atomics.store(controlView, 0, CMD_IDLE);
            } else {
                Atomics.store(controlView, 2, 4096);
                Atomics.store(controlView, 0, CMD_STDIN_REQUEST);
                Atomics.notify(controlView, 0);
                // Keep waiting for actual stdin data instead of timing out to EOF.
                // Clearing CMD_STDIN_REQUEST too early makes interactive shells exit.
                while (Atomics.load(controlView, 0) === CMD_STDIN_REQUEST) {
                    Atomics.wait(controlView, 0, CMD_STDIN_REQUEST, 100);
                }
                const newCmd = Atomics.load(controlView, 0);
                if (newCmd === CMD_STDIN_READY) {
                    const len = Atomics.load(controlView, 2);
                    if (len > 0) {
                        for (let i = 0; i < len; i++) {
                            emModule._stdinBuffer.push(controlBytes[64 + i]);
                        }
                    }
                    Atomics.store(controlView, 0, CMD_IDLE);
                }
            }
        }
        maybePostJitStats();

        if ((stopReason & STOP_REASON_HOST_FETCH) && friscy_host_fetch_pending && friscy_host_fetch_pending()) {
            try {
                const reqPtr = friscy_get_fetch_request();
                const reqLen = friscy_get_fetch_request_len();
                const reqBytes = new Uint8Array(emModule.HEAPU8.buffer, reqPtr, reqLen);
                const reqJSON = new TextDecoder().decode(reqBytes.slice());
                const req = JSON.parse(reqJSON);

                if (!self.allowNetwork) {
                    throw new Error("Sandbox policy prohibits external network requests.");
                }

                console.log(`[worker] host-fetch: ${req.options?.method || 'GET'} ${req.url}`);

                const fetchOpts = {};
                if (req.options) {
                    if (req.options.method) fetchOpts.method = req.options.method;
                    if (req.options.headers) fetchOpts.headers = req.options.headers;
                    if (req.options.body) fetchOpts.body = req.options.body;
                }
                const resp = await fetch(req.url, fetchOpts);
                const body = await resp.text();

                const respHeaders = {};
                resp.headers.forEach((v, k) => { respHeaders[k] = v; });
                const respJSON = JSON.stringify({
                    status: resp.status,
                    statusText: resp.statusText,
                    headers: respHeaders,
                    body: body,
                });

                const respBytes = encoder.encode(respJSON);
                const ptr = emModule._malloc(respBytes.length);
                emModule.HEAPU8.set(respBytes, ptr);
                friscy_set_fetch_response(ptr, respBytes.length);
                emModule._free(ptr);
            } catch (e) {
                console.error('[worker] host-fetch error:', e.message);
                const errResp = JSON.stringify({
                    status: 0,
                    statusText: e.message,
                    headers: {},
                    body: '',
                });
                const errBytes = encoder.encode(errResp);
                const ptr = emModule._malloc(errBytes.length);
                emModule.HEAPU8.set(errBytes, ptr);
                friscy_set_fetch_response(ptr, errBytes.length);
                emModule._free(ptr);
            }
        }

        if (jitManager.jitCompiler) {
            let pc = friscy_get_pc() >>> 0;
            const statePtr = friscy_get_state_ptr();
            const MAX_CHAIN = 32;
            let chainCount = 0;

            while (chainCount < MAX_CHAIN) {
                telemetry.jitDispatches++;
                const jitResult = jitManager.execute(pc, statePtr);
                if (!jitResult) {
                    telemetry.jitFallbacks++;
                    jitManager.recordExecution(pc);
                    friscy_set_pc(pc);
                    break;
                }

                if (jitResult.isHalt) {
                    telemetry.jitHalts++;
                    flushTelemetry('jit_halt');
                    return;
                }

                if (jitResult.isSyscall) {
                    telemetry.jitSyscalls++;
                    friscy_set_pc(jitResult.nextPC >>> 0);
                    break;
                }

                if (jitResult.regionMiss) {
                    telemetry.jitRegionMisses++;
                    jitManager.recordTraceTransition(pc, jitResult.nextPC >>> 0);
                    pc = jitResult.nextPC >>> 0;
                    chainCount++;
                    continue;
                }

                telemetry.jitDirectRuns++;
                friscy_set_pc(jitResult.nextPC >>> 0);
                break;
            }

            if (chainCount >= MAX_CHAIN) {
                friscy_set_pc(pc >>> 0);
            }
        }

        resumeCount++;
        if (resumeCount <= 5 || resumeCount % 100 === 0) {
            console.log(`[worker] resume #${resumeCount}`);
        }
        if (rawStopReason & STOP_REASON_TIMESLICE) telemetry.timesliceResumeAttempts++;
        const stillStopped = await friscy_resume();
        maybePostJitStats();
        if (!stillStopped) {
            flushTelemetry('finished_after_resume');
            console.log(`[worker] resume loop: machine finished after ${resumeCount} resumes`);
            return;
        }
    }

    flushTelemetry('control_sab_missing');
}

self.addEventListener('error', (e) => {
    console.error('[worker] Uncaught error:', e.message, e.filename, e.lineno);
    self.postMessage({ type: 'error', message: `${e.message} (${e.filename}:${e.lineno})` });
});
self.addEventListener('unhandledrejection', (e) => {
    console.error('[worker] Unhandled rejection:', e.reason);
    self.postMessage({ type: 'error', message: String(e.reason) });
});

self.onmessage = async function(e) {
    const msg = e.data;

    if (msg.type === 'export_vfs') {
        if (!controlView) {
            self.postMessage({ type: 'vfs_export', tarData: null, requestId: msg.requestId || 0 });
            return;
        }
        vfsExportRequestId = msg.requestId || 0;
        Atomics.store(controlView, 0, CMD_EXPORT_VFS);
        Atomics.notify(controlView, 0);
        return;
    }

    if (msg.type === 'sync_opfs_mounts') {
        if (!emModule || !emModule.FS) {
            self.postMessage({ type: 'opfs_sync', status: 'error', message: 'Module not ready', files: 0 });
            return;
        }
        try {
            const result = await syncOpfsMounts();
            self.postMessage({ type: 'opfs_sync', status: 'done', files: result.files });
        } catch (e) {
            self.postMessage({ type: 'opfs_sync', status: 'error', message: e?.message || String(e), files: 0 });
        }
        return;
    }

    if (msg.type === 'init') {
        try {
        const controlSab = msg.controlSab;
        const stdoutSab = msg.stdoutSab;
        const netSab = msg.netSab;
        const enableJit = msg.enableJit !== false;
        const jitHotThreshold = Number.isFinite(msg.jitHotThreshold) ? msg.jitHotThreshold : null;
        const jitTierEnabled = msg.jitTierEnabled !== false;
        const jitOptimizeThreshold = Number.isFinite(msg.jitOptimizeThreshold) ? msg.jitOptimizeThreshold : null;
        const jitSchedulerBudget = Number.isFinite(msg.jitSchedulerBudget) ? msg.jitSchedulerBudget : null;
        const jitSchedulerConcurrency = Number.isFinite(msg.jitSchedulerConcurrency)
            ? msg.jitSchedulerConcurrency
            : null;
        const jitSchedulerQueueMax = Number.isFinite(msg.jitSchedulerQueueMax)
            ? msg.jitSchedulerQueueMax
            : null;
        const jitPredictTopK = Number.isFinite(msg.jitPredictTopK) ? msg.jitPredictTopK : null;
        const jitPredictConfidence = Number.isFinite(msg.jitPredictConfidence) ? msg.jitPredictConfidence : null;
        const jitMarkovEnabled = msg.jitMarkovEnabled !== false;
        const jitTripletEnabled = msg.jitTripletEnabled !== false;
        const jitAwaitCompiler = msg.jitAwaitCompiler === true;
        jitPrewarmEnabled = msg.jitPrewarmEnabled !== false;
        const jitTraceEnabled = msg.jitTraceEnabled !== false;
        const jitEdgeHotThreshold = Number.isFinite(msg.jitEdgeHotThreshold) ? msg.jitEdgeHotThreshold : null;
        const jitTraceTripletHotThreshold = Number.isFinite(msg.jitTraceTripletHotThreshold)
            ? msg.jitTraceTripletHotThreshold
            : null;
        
        timesliceResumeEnabled = msg.timesliceResumeEnabled !== false;

        self.allowNetwork = msg.allowNetwork === true;

        controlView = new Int32Array(controlSab);
        controlBytes = new Uint8Array(controlSab);
        stdoutView = new Int32Array(stdoutSab);
        stdoutBytes = new Uint8Array(stdoutSab);

        if (netSab) {
            netView = new Int32Array(netSab);
            netBytes = new Uint8Array(netSab);
        }

        const initCols = Atomics.load(controlView, 6);
        const initRows = Atomics.load(controlView, 7);

        if (!self.crossOriginIsolated && msg.allowInsecure !== true) {
            throw new Error('Worker not cross-origin isolated');
        }

        console.log('[worker] Loading Emscripten module...');
        const { default: createFriscy } = await import('./friscy.js');
        const stdinBuffer = [];

        emModule = await createFriscy({
            noInitialRun: true,
            print: function(text) {
                console.log('[friscy]', text);
                writeStdoutRing(encoder.encode(text + '\n'));
            },
            printErr: function(text) {
                console.log('[friscy-err]', text);
            },
            _termWrite: function(text) {
                writeStdoutRing(encoder.encode(text));
            },
            _decoder: new TextDecoder(),
            _stdinBuffer: stdinBuffer,
            _stdinEOF: false,
            _termRows: initRows || 24,
            _termCols: initCols || 80,
            stdin: function() {
                if (stdinBuffer.length > 0) {
                    return stdinBuffer.shift();
                }
                const data = requestStdin(1);
                return data.length > 0 ? data[0] : null;
            },
            onExit: function(code) {
                signalExit(code);
            },
        });

        if (enableJit) {
            try {
                const jitMod = await import('./jit_manager.js');
                jitManager = jitMod.default;
                installInvalidationHook = jitMod.installInvalidationHook;
                if (jitHotThreshold !== null && jitHotThreshold > 0) {
                    jitManager.hotThreshold = jitHotThreshold;
                }
                jitManager.configureTiering({
                    enabled: jitTierEnabled,
                    optimizeThreshold: jitOptimizeThreshold,
                });
                jitManager.configureScheduler({
                    compileBudgetPerSecond: jitSchedulerBudget,
                    maxConcurrentCompiles: jitSchedulerConcurrency,
                    compileQueueMax: jitSchedulerQueueMax,
                    predictorTopK: jitPredictTopK,
                    predictorBaseConfidenceThreshold: jitPredictConfidence,
                });
                jitManager.configurePredictor({
                    markovEnabled: jitMarkovEnabled,
                    tripletEnabled: jitTripletEnabled,
                });
                jitManager.configureTrace({
                    enabled: jitTraceEnabled,
                    edgeHotThreshold: jitEdgeHotThreshold,
                    tripletHotThreshold: jitTraceTripletHotThreshold,
                });
            } catch (e) {
                console.warn('[worker] JIT manager not available:', e.message);
            }

            if (typeof installInvalidationHook === 'function') installInvalidationHook(emModule);

            const wasmMemory = emModule.wasmMemory || (emModule.asm && emModule.asm.memory);
            if (wasmMemory) {
                jitManager.init(wasmMemory);
                const warmCompiler = async () => {
                    await jitManager.loadCompiler('rv2wasm_jit_bg.wasm');
                    if (!jitPrewarmEnabled || !jitManager.jitCompiler || typeof jitManager.prewarmCompiler !== 'function') {
                        return;
                    }
                    await jitManager.prewarmCompiler();
                };
                if (jitAwaitCompiler) {
                    try {
                        await warmCompiler();
                    } catch (e) {
                        console.warn('[worker] JIT compiler wait failed:', e.message);
                    }
                } else {
                    warmCompiler().catch(e => {
                        console.warn('[worker] JIT compiler not available:', e.message);
                    });
                }
            }
        }

        if (netSab) {
            emModule.onSocketCreated = function(fd, domain, type) {
                networkRPC(NET_OP_SOCKET_CREATE, fd, domain, type, null);
            };
            emModule.onSocketConnect = function(fd, addrData) {
                const { result } = networkRPC(NET_OP_CONNECT, fd, 0, 0,
                    new Uint8Array(addrData.buffer, addrData.byteOffset, addrData.byteLength));
                return result;
            };
            emModule.onSocketBind = function(fd, addrData) {
                const { result } = networkRPC(NET_OP_BIND, fd, 0, 0,
                    new Uint8Array(addrData.buffer, addrData.byteOffset, addrData.byteLength));
                return result;
            };
            emModule.onSocketListen = function(fd, backlog) {
                const { result } = networkRPC(NET_OP_LISTEN, fd, backlog, 0, null);
                return result;
            };
            emModule.onSocketAccept = function(fd) {
                const resp = networkRPC(NET_OP_ACCEPT, fd, 0, 0, null);
                if (resp.result < 0) return resp.result;
                return { fd: resp.result, addr: resp.data };
            };
            emModule.onSocketSend = function(fd, data) {
                const { result } = networkRPC(NET_OP_SEND, fd, 0, 0,
                    data instanceof Uint8Array ? data : new Uint8Array(data));
                return result;
            };
            emModule.onSocketClosed = function(fd) {
                const { result } = networkRPC(NET_OP_CLOSE, fd, 0, 0, null);
                return result;
            };
            emModule.onSocketShutdown = function(fd, how) {
                const { result } = networkRPC(NET_OP_SHUTDOWN, fd, how, 0, null);
                return result;
            };
            emModule.hasSocketData = function(fd) {
                const { result } = networkRPC(NET_OP_HAS_DATA, fd, 0, 0, null);
                return result > 0;
            };
            emModule.readSocketData = function(fd, maxLen) {
                const resp = networkRPC(NET_OP_RECV, fd, maxLen, 0, null);
                if (resp.result <= 0 || !resp.data) return null;
                return Array.from(resp.data);
            };
            emModule.hasPendingAccept = function(fd) {
                const { result } = networkRPC(NET_OP_HAS_PENDING_ACCEPT, fd, 0, 0, null);
                return result > 0;
            };
        }

        self.postMessage({ type: 'ready' });
        } catch (e) {
            console.error('[worker] Init failed:', e.message, e.stack);
            self.postMessage({ type: 'error', message: e.message, stack: e.stack });
        }
    }

    if (msg.type === 'net_proxy') {
        console.log('[worker] Initializing WebTransport proxy lane to:', msg.proxyUrl);
        netLaneReady = false;
        netLaneInitError = null;
        netWorker = new Worker('./net_lane_worker.js', { type: 'module' });
        setTimeout(() => {
            if (!netLaneReady && !netLaneInitError) {
                netLaneInitError = 'net lane did not report ready within 12s';
                console.error('[worker] net lane timeout');
                self.postMessage({ type: 'net_error', message: netLaneInitError });
            }
        }, 12000);
        netWorker.onerror = (e) => {
            netLaneReady = false;
            netLaneInitError = e?.message || 'net lane worker crashed';
            console.error('[worker] net lane worker error:', netLaneInitError);
            self.postMessage({ type: 'net_error', message: netLaneInitError });
        };
        
        netWorker.onmessage = (e) => {
            const laneMsg = e.data;
            if (laneMsg.type === 'ready') {
                netLaneReady = true;
                console.log('[worker] net lane ready');
                self.postMessage({ type: 'net_ready' });
                return;
            }
            if (laneMsg.type === 'error') {
                netLaneReady = false;
                netLaneInitError = laneMsg.message || 'net lane init failed';
                console.error('[worker] net lane init error:', netLaneInitError);
                self.postMessage({ type: 'net_error', message: netLaneInitError });
                return;
            }
            if (laneMsg.type === 'rpc_result') {
                if (!netView) return;
                Atomics.store(netView, 5, laneMsg.result);
                
                if (laneMsg.data && laneMsg.data.byteLength > 0) {
                    const u8 = new Uint8Array(laneMsg.data);
                    const len = Math.min(u8.length, NET_DATA_SIZE);
                    Atomics.store(netView, 6, len);
                    netBytes.set(u8.subarray(0, len), NET_HEADER);
                } else {
                    Atomics.store(netView, 6, 0);
                }
                
                Atomics.store(netView, 0, 2);
                Atomics.notify(netView, 0);
            }
        };
        
        netWorker.postMessage({
            type: 'init',
            proxyUrl: msg.proxyUrl,
            certHash: msg.certHash
        });
    }

    if (msg.type === 'run') {
        const args = msg.args || [];
        try {
            if (msg.rootfsData) {
                emModule.FS.writeFile('/rootfs.tar', new Uint8Array(msg.rootfsData));
            }

            if (msg.checkpointData) {
                emModule.FS.writeFile('/checkpoint.ckpt', new Uint8Array(msg.checkpointData));
                args.unshift('--load-checkpoint', '/checkpoint.ckpt');
                console.log('[worker] Checkpoint loaded (' + msg.checkpointData.byteLength + ' bytes)');
            }

            await emModule.callMain(args);
            if (emModule._friscy_stopped && emModule._friscy_stopped()) {
                if (jitPrewarmEnabled && jitManager.jitCompiler && typeof jitManager.prewarmRegionAt === 'function') {
                    try {
                        const pc = (typeof emModule._friscy_get_pc === 'function') ? (emModule._friscy_get_pc() >>> 0) : 0;
                        const ok = await jitManager.prewarmRegionAt(pc);
                        if (ok) console.log(`[worker] JIT region prewarmed at 0x${pc.toString(16)}`);
                        else console.log(`[worker] JIT region prewarm skipped at 0x${pc.toString(16)}`);
                    } catch (e) {
                        console.warn('[worker] JIT region prewarm failed:', e.message);
                    }
                }
                await runResumeLoop();
            }
            maybePostJitStats(true);
            signalExit(0);
        } catch (e) {
            const errMsg = e?.message || String(e);
            const errStack = e?.stack ? `\n${e.stack}` : '';
            console.error('[worker] Run failed:', errMsg, e?.stack || '');
            writeStdoutRing(encoder.encode(`\r\n[worker] Error: ${errMsg}${errStack}\r\n`));
            maybePostJitStats(true);
            signalExit(1);
        }
    }

    if (msg.type === 'resize') {
        if (emModule) {
            emModule._termRows = msg.rows || 24;
            emModule._termCols = msg.cols || 80;
        }
    }

    if (msg.type === 'write_file') {
        if (emModule && emModule.FS) {
            try {
                emModule.FS.writeFile(msg.path, new Uint8Array(msg.data));
                console.log(`[worker] Wrote ${msg.data.byteLength} bytes to ${msg.path}`);
            } catch (e) {
                console.error(`[worker] Failed to write file ${msg.path}:`, e.message);
            }
        }
    }

    if (msg.type === 'load_overlay') {
        if (emModule && emModule.FS && msg.data) {
            try {
                emModule.FS.writeFile('/tmp/overlay.tar', new Uint8Array(msg.data));
                console.log(`[worker] Loaded overlay tar (${msg.data.byteLength} bytes)`);
            } catch (e) {
                console.error('[worker] Failed to load overlay:', e.message);
            }
        }
    }

    if (msg.type === 'export-checkpoint') {
        if (!emModule || !emModule.FS) {
            self.postMessage({ type: 'checkpoint-export-error', message: 'Module not initialized' });
            return;
        }
        try {
            const t0 = Date.now();
            if (msg.rootfsData) {
                emModule.FS.writeFile('/rootfs.tar', new Uint8Array(msg.rootfsData));
            }
            const args = [
                '--rootfs', '/rootfs.tar',
                '--env', 'LD_PRELOAD=/usr/lib/vh_preload.so',
                '--env', 'ANTHROPIC_API_KEY=sk-ant-dummy',
                '--export-checkpoint', '/export.ckpt',
                '/usr/bin/node', '--jitless', '--max-old-space-size=256', '/usr/local/bin/claude-repl.js',
            ];
            console.log('[worker] Export checkpoint started (LD_PRELOAD, ~20–30 min)...');
            self.postMessage({ type: 'checkpoint-export-stage', stage: 'boot-started', atMs: Date.now() - t0 });
            await emModule.callMain(args);
            const stopped = emModule._friscy_stopped ? !!emModule._friscy_stopped() : false;
            self.postMessage({
                type: 'checkpoint-export-stage',
                stage: 'stdin-wait-reached',
                atMs: Date.now() - t0,
                stopped,
            });
            let copy;
            if (emModule._friscy_export_checkpoint) {
                const sizePtr = emModule._malloc(4);
                const dataPtr = emModule._friscy_export_checkpoint(sizePtr);
                const size = Number(emModule.HEAPU32[Number(sizePtr) >> 2]);
                emModule._free(sizePtr);
                if (dataPtr && size > 0) {
                    const ptr = dataPtr >>> 0;
                    copy = new Uint8Array(emModule.HEAPU8.buffer, ptr, size).slice();
                    emModule._free(ptr);
                }
            }
            if (!copy) {
                const data = emModule.FS.readFile('/export.ckpt');
                copy = new Uint8Array(data.length);
                copy.set(data);
            }
            console.log('[worker] Checkpoint exported:', copy.length, 'bytes');
            self.postMessage({
                type: 'checkpoint-exported',
                data: copy,
                metrics: {
                    totalMs: Date.now() - t0,
                    bytes: copy.length,
                    stopped,
                },
            }, [copy.buffer]);
        } catch (e) {
            console.error('[worker] Export failed:', e.message, e.stack);
            self.postMessage({ type: 'checkpoint-export-error', message: e.message, stack: e.stack });
        }
    }

    if (msg.type === 'export-checkpoint-live') {
        if (!emModule) {
            self.postMessage({ type: 'checkpoint-export-error', message: 'Module not initialized' });
            return;
        }
        try {
            const sizePtr = emModule._malloc(4);
            const liveExport = emModule._friscy_save_live_checkpoint || emModule._friscy_export_checkpoint;
            if (!liveExport) {
                emModule._free(sizePtr);
                throw new Error('No checkpoint export function available');
            }
            const dataPtr = liveExport(sizePtr);
            const size = Number(emModule.HEAPU32[Number(sizePtr) >> 2]);
            emModule._free(sizePtr);
            if (!dataPtr || size <= 0) {
                throw new Error('Live checkpoint export returned empty payload');
            }
            const ptr = dataPtr >>> 0;
            const copy = new Uint8Array(emModule.HEAPU8.buffer, ptr, size).slice();
            emModule._free(ptr);
            self.postMessage({
                type: 'checkpoint-exported-live',
                data: copy,
                metrics: { bytes: copy.length },
            }, [copy.buffer]);
        } catch (e) {
            console.error('[worker] Live export failed:', e.message, e.stack);
            self.postMessage({ type: 'checkpoint-export-error', message: e.message, stack: e.stack });
        }
    }

    if (msg.type === 'suspend') {
        self._isSuspended = true;
        self.postMessage({ type: 'suspended' });
    }

    if (msg.type === 'resume') {
        self._isSuspended = false;
        self.postMessage({ type: 'resumed' });
    }
};
