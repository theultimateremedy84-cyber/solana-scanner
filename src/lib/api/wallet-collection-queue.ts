// =============================================================================
// Wallet Collection Queue — no-op stub
//
// The queue-based architecture has been replaced by direct inline collection
// inside the enqueueWalletCollection server function. This stub keeps the
// import in start.ts working without any behaviour change.
//
// start.ts calls WalletCollectionQueue.getInstance().start() — that is now a
// harmless no-op.
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

  /** No-op — collection now runs directly inside the server function. */
  start(): void {
    console.log(
      `${LOG} start() called — queue is now a no-op stub. ` +
      "Collection runs inline in enqueueWalletCollection server function.",
    );
  }

  /** No-op. */
  stop(): void {}

  get pendingCount(): number {
    return 0;
  }

  snapshot(): ReadonlyArray<never> {
    return [];
  }
}
