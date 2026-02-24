declare module "/friscy/network_bridge.js" {
  export class FriscyNetworkBridge {
    constructor(url: string, opts?: { certHash?: string | null });
    connect(): Promise<void>;
    socketCreate(): Promise<number>;
    socketConnect(...args: any[]): Promise<number>;
    socketBind(...args: any[]): Promise<number>;
    socketListen(...args: any[]): Promise<number>;
    socketAccept(...args: any[]): Promise<{ result: number; addr: any }>;
    socketSend(...args: any[]): Promise<number>;
    socketRecv(...args: any[]): Promise<Uint8Array | null>;
    socketClose(...args: any[]): Promise<number>;
    socketHasData(...args: any[]): Promise<number>;
    socketHasPendingAccept(...args: any[]): Promise<number>;
    socketShutdown(...args: any[]): Promise<number>;
  }
}

declare module "/friscy/network_rpc_host.js" {
  export class NetworkRPCHost {
    constructor(
      sab: SharedArrayBuffer | null,
      bridge: any,
      opts?: { laneEnabled?: boolean },
    );
    start(): void;
    stop(): void;
  }
}
