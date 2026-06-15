import { Trade } from "./types";

export function mapToEngineTrade(rawTx: any): Trade {
  return {
    signature: rawTx.signature,
    timestamp: rawTx.blockTime * 1000,
    wallet: rawTx.signer,
    side: rawTx.type, // Ensure this maps to "buy" | "sell"
    amount: rawTx.amount,
    // Optional metadata for advanced detection:
    computeUnits: rawTx.meta?.computeUnitsConsumed,
    instructionFingerprint: rawTx.instructionFingerprint 
  };
}
