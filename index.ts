// ─── Copy Trade Execution (Jupiter Swap) ─────────────────────────────────────
// Uses Jupiter v6 API for swap routing.
// Supports both Pump.fun bonding curve tokens and graduated Raydium pairs.

import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.ts";

// SOL wrapped mint
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP = "https://quote-api.jup.ag/v6/swap";

// ── Keypair loading ───────────────────────────────────────────────────────────
function loadKeypair(): Keypair {
  const raw = config.privateKey.trim();
  try {
    // JSON array of bytes: [1,2,3,...]
    if (raw.startsWith("[")) {
      const bytes = JSON.parse(raw) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    }
    // base58 string
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch (e) {
    throw new Error(
      "COPY_TRADE_PRIVATE_KEY is invalid. " +
        "Use a base58 string or JSON byte-array (e.g. from Phantom export)."
    );
  }
}

let _keypair: Keypair | null = null;
let _connection: Connection | null = null;

function getKeypair(): Keypair {
  if (!_keypair) _keypair = loadKeypair();
  return _keypair;
}

function getConnection(): Connection {
  if (!_connection)
    _connection = new Connection(config.rpcUrl, "confirmed");
  return _connection;
}

export function getBotPublicKey(): string {
  return getKeypair().publicKey.toBase58();
}

// ── Jupiter helpers ───────────────────────────────────────────────────────────
interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [key: string]: unknown;
}

async function getQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  slippageBps: number
): Promise<JupiterQuote | null> {
  const url = new URL(JUPITER_QUOTE);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", String(amountLamports));
  url.searchParams.set("slippageBps", String(slippageBps));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.text();
    console.error("[jupiter] quote error:", err);
    return null;
  }
  return res.json() as Promise<JupiterQuote>;
}

async function buildSwapTx(
  quote: JupiterQuote,
  userPublicKey: string
): Promise<VersionedTransaction | null> {
  const res = await fetch(JUPITER_SWAP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[jupiter] swap error:", err);
    return null;
  }

  const { swapTransaction } = (await res.json()) as {
    swapTransaction: string;
  };
  const txBytes = Buffer.from(swapTransaction, "base64");
  return VersionedTransaction.deserialize(txBytes);
}

async function signAndSend(tx: VersionedTransaction): Promise<string> {
  const kp = getKeypair();
  const conn = getConnection();

  // Re-fetch latest blockhash for freshness
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;

  tx.sign([kp]);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  return sig;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Buy `tradeAmountSol` SOL worth of `tokenMint`.
export async function executeBuy(tokenMint: string): Promise<string> {
  const kp = getKeypair();
  const lamports = Math.round(config.tradeAmountSol * LAMPORTS_PER_SOL);

  console.log(
    `[copytrade] BUY ${config.tradeAmountSol} SOL → ${tokenMint}`
  );

  const quote = await getQuote(SOL_MINT, tokenMint, lamports, config.slippageBps);
  if (!quote) return "❌ No route found on Jupiter";

  const priceImpact = parseFloat(quote.priceImpactPct);
  if (priceImpact > 5) {
    return `⚠️ Skipped — price impact too high (${priceImpact.toFixed(2)}%)`;
  }

  const tx = await buildSwapTx(quote, kp.publicKey.toBase58());
  if (!tx) return "❌ Failed to build swap transaction";

  const sig = await signAndSend(tx);
  return `✅ Bought — <a href="https://solscan.io/tx/${sig}">TX</a>`;
}

// Sell all of our `tokenMint` balance back to SOL.
export async function executeSell(tokenMint: string): Promise<string> {
  const kp = getKeypair();
  const conn = getConnection();

  console.log(`[copytrade] SELL all ${tokenMint} → SOL`);

  // Find our token account balance
  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
    kp.publicKey,
    { mint: new PublicKey(tokenMint) }
  );

  if (tokenAccounts.value.length === 0) {
    return "ℹ️ No position to sell (no token account)";
  }

  const balance: number =
    tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;

  if (!balance || balance === "0") {
    return "ℹ️ No position to sell (zero balance)";
  }

  const quote = await getQuote(
    tokenMint,
    SOL_MINT,
    Number(balance),
    config.slippageBps
  );
  if (!quote) return "❌ No route found on Jupiter for sell";

  const tx = await buildSwapTx(quote, kp.publicKey.toBase58());
  if (!tx) return "❌ Failed to build sell transaction";

  const sig = await signAndSend(tx);
  return `✅ Sold — <a href="https://solscan.io/tx/${sig}">TX</a>`;
}

// Check SOL balance of the bot wallet
export async function getBotBalance(): Promise<number> {
  const conn = getConnection();
  const lamports = await conn.getBalance(getKeypair().publicKey);
  return lamports / LAMPORTS_PER_SOL;
}
