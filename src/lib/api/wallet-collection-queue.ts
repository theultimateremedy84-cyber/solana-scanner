// =============================================================================
// Wallet Collection Queue — no-op stub
//
// The queue is no longer used. Collection runs directly inside the
// enqueueWalletCollection server function. This stub keeps start.ts happy.
// =============================================================================

const LOG = "[WalletCollectionQueue]";

export class WalletCollectionQueue {
  private static _instance: WalletCollectionQueue | null = null;

  private constructor() {}

  static getInstance(): WalletCollectionQueue {
    if (!WalletCollectionQueue._instance) {
      WalletCollectionQueue._instance = new WalletCollectionQueue();
    }
    return WalletCollectionQueue._instance;
  }

  start(): void {
    console.log(`${LOG} start() — no-op. Collection runs inline in enqueueWalletCollection.`);
  }

  stop(): void {}

  get pendingCount(): number { return 0; }

  snapshot(): ReadonlyArray<never> { return []; }
}
