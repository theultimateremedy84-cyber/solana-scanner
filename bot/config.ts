// ─── Bot Configuration ────────────────────────────────────────────────────────
// All values are driven by Railway environment variables.
// Never hard-code secrets — set them in Railway → Variables.

function require(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  // ── Supabase ────────────────────────────────────────────────────────────────
  supabaseUrl: require("SUPABASE_URL"),
  supabaseKey: require("SUPABASE_SERVICE_ROLE_KEY"),

  // ── Telegram ────────────────────────────────────────────────────────────────
  telegramBotToken: require("TELEGRAM_BOT_TOKEN"),
  telegramChatId: require("TELEGRAM_CHAT_ID"),

  // ── Solana ──────────────────────────────────────────────────────────────────
  // COPY_TRADE_PRIVATE_KEY: base58 string OR JSON array of bytes (e.g. from Phantom export)
  privateKey: require("COPY_TRADE_PRIVATE_KEY"),

  // RPC endpoint — defaults to Helius mainnet if HELIUS_API_KEY is set
  rpcUrl: process.env.SOLANA_RPC_URL ||
    (process.env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : "https://api.mainnet-beta.solana.com"),

  // ── Copy-trade settings (all adjustable via Railway variables) ────────────
  // Amount of SOL to spend per copied BUY trade
  tradeAmountSol: parseFloat(optional("TRADE_AMOUNT_SOL", "0.1")),

  // Only copy trades where the watched wallet spent >= this USD amount
  minTradeUsd: parseFloat(optional("MIN_TRADE_USD", "100")),

  // Slippage tolerance in basis points (100 = 1%)
  slippageBps: parseInt(optional("SLIPPAGE_BPS", "100")),

  // ── Watched wallets ─────────────────────────────────────────────────────────
  // Comma-separated list of wallet addresses to watch.
  // Leave blank to auto-fetch the top 3 by ROI from Supabase on startup.
  watchedWallets: process.env.WATCHED_WALLETS
    ? process.env.WATCHED_WALLETS.split(",").map((w) => w.trim()).filter(Boolean)
    : [],

  // How many top wallets to auto-fetch when WATCHED_WALLETS is not set
  autoFetchCount: parseInt(optional("AUTO_FETCH_WALLET_COUNT", "3")),

  // Minimum tokens_traded for auto-fetched wallets
  minTokensTraded: parseInt(optional("MIN_TOKENS_TRADED", "20")),

  // ── Polling ─────────────────────────────────────────────────────────────────
  pollIntervalMs: parseInt(optional("POLL_INTERVAL_MS", "10000")),

  // ── Feature flags ───────────────────────────────────────────────────────────
  // Set COPY_TRADE_ENABLED=false to receive alerts only (no auto-trading)
  copyTradeEnabled: optional("COPY_TRADE_ENABLED", "true") === "true",
};
