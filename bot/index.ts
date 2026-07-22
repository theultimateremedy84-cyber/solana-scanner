// ─── Solana Copy-Trade & Alert Bot ───────────────────────────────────────────
// Entry point. Run with: bun bot/index.ts
//
// What this does:
//   1. On startup: resolves the list of wallets to watch (env var or Supabase).
//   2. Polls wallet_token_activity every POLL_INTERVAL_MS seconds.
//   3. For each new trade by a watched wallet that meets the size filter:
//       a. Sends a Telegram alert.
//       b. If COPY_TRADE_ENABLED=true, executes a matching trade via Jupiter.

import { config } from "./config.ts";
import {
  fetchTopWallets,
  fetchNewActivity,
  type WalletActivity,
} from "./supabase.ts";
import {
  sendMessage,
  buildTradeAlert,
  buildStartupMessage,
  sendError,
} from "./telegram.ts";
import {
  executeBuy,
  executeSell,
  getBotBalance,
  getBotPublicKey,
} from "./copytrade.ts";

// ── State ─────────────────────────────────────────────────────────────────────
let watchedWallets: string[] = [];
// Cursor: only process activity newer than this timestamp
let lastSeenAt = new Date(Date.now() - 60_000); // start 1 min in the past
// Deduplicate: track processed signature IDs to handle poll overlap
const processedSigs = new Set<string>();
// Prune processedSigs to avoid unbounded growth
function pruneProcessed(): void {
  if (processedSigs.size > 2000) {
    const arr = [...processedSigs];
    arr.slice(0, 1000).forEach((s) => processedSigs.delete(s));
  }
}

// ── Wallet resolution ─────────────────────────────────────────────────────────
async function resolveWallets(): Promise<string[]> {
  if (config.watchedWallets.length > 0) {
    console.log(
      `[bot] Using ${config.watchedWallets.length} wallet(s) from WATCHED_WALLETS env var`
    );
    return config.watchedWallets;
  }

  console.log(
    `[bot] WATCHED_WALLETS not set — auto-fetching top ${config.autoFetchCount} wallets from Supabase...`
  );
  const wallets = await fetchTopWallets(
    config.autoFetchCount,
    config.minTokensTraded
  );

  if (wallets.length === 0) {
    throw new Error(
      "No wallets found in Supabase with the current filter settings. " +
        "Set WATCHED_WALLETS manually or lower MIN_TOKENS_TRADED."
    );
  }

  console.log(`[bot] Auto-fetched wallets:`, wallets);
  return wallets;
}

// ── Process a single activity row ────────────────────────────────────────────
async function handleActivity(activity: WalletActivity): Promise<void> {
  if (processedSigs.has(activity.transaction_signature)) return;
  processedSigs.add(activity.transaction_signature);

  console.log(
    `[bot] ${activity.action_type.toUpperCase()} ${activity.wallet_address.slice(0, 8)}... ` +
      `token=${activity.token_address.slice(0, 8)}... ` +
      `sol=${activity.amount_sol} usd=${activity.amount_usd}`
  );

  let copyResult = "Alerts-only mode";

  if (config.copyTradeEnabled) {
    try {
      if (activity.action_type === "buy") {
        copyResult = await executeBuy(activity.token_address);
      } else {
        copyResult = await executeSell(activity.token_address);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bot] copy trade failed:", msg);
      copyResult = `❌ Error: ${msg.slice(0, 100)}`;
    }
  }

  await sendMessage(buildTradeAlert(activity, copyResult));
}

// ── Main poll loop ────────────────────────────────────────────────────────────
async function poll(): Promise<void> {
  try {
    const since = lastSeenAt;
    const activities = await fetchNewActivity(
      watchedWallets,
      since,
      config.minTradeUsd
    );

    for (const activity of activities) {
      await handleActivity(activity);
      // Advance cursor
      const ts = new Date(activity.timestamp);
      if (ts > lastSeenAt) lastSeenAt = ts;
    }

    pruneProcessed();
  } catch (err) {
    console.error("[bot] poll error:", err);
    // Don't spam Telegram on every poll error — only log locally
  }
}

// ── Telegram command handler (lightweight long-polling) ───────────────────────
let lastUpdateId = 0;

async function handleCommands(): Promise<void> {
  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`;
    const res = await fetch(url);
    if (!res.ok) return;

    const { result } = (await res.json()) as {
      result: Array<{
        update_id: number;
        message?: { chat: { id: number }; text?: string };
      }>;
    };

    for (const update of result) {
      lastUpdateId = update.update_id;
      const text = update.message?.text ?? "";

      if (text === "/status" || text.startsWith("/status@")) {
        let balanceStr = "?";
        try {
          const bal = await getBotBalance();
          balanceStr = `${bal.toFixed(4)} SOL`;
        } catch {}

        const walletLines = watchedWallets
          .map((w, i) => `  ${i + 1}. <code>${w}</code>`)
          .join("\n");

        await sendMessage(
          [
            `📊 <b>Bot Status</b>`,
            ``,
            `👛 Bot wallet: <code>${getBotPublicKey()}</code>`,
            `💰 Bot balance: <b>${balanceStr}</b>`,
            ``,
            `👁 Watching ${watchedWallets.length} wallet(s):`,
            walletLines,
            ``,
            `⚙️ Trade size: <b>${config.tradeAmountSol} SOL</b>`,
            `⚙️ Copy trading: <b>${config.copyTradeEnabled ? "✅ ENABLED" : "❌ ALERTS ONLY"}</b>`,
            `⏱ Last checked: ${lastSeenAt.toISOString()}`,
          ].join("\n")
        );
      }

      if (text === "/wallets" || text.startsWith("/wallets@")) {
        const walletLines = watchedWallets
          .map(
            (w, i) =>
              `${i + 1}. <code>${w}</code>\n   <a href="https://solscan.io/account/${w}">Solscan</a>`
          )
          .join("\n\n");
        await sendMessage(`👁 <b>Watched Wallets</b>\n\n${walletLines}`);
      }
    }
  } catch {
    // Silently ignore command poll errors
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("[bot] Starting Solana copy-trade bot...");

  // Validate copy-trade keypair early if enabled
  if (config.copyTradeEnabled) {
    try {
      const pk = getBotPublicKey();
      const bal = await getBotBalance();
      console.log(`[bot] Trading wallet: ${pk} | Balance: ${bal.toFixed(4)} SOL`);
      if (bal < config.tradeAmountSol) {
        console.warn(
          `[bot] ⚠️  Wallet balance (${bal.toFixed(4)} SOL) is less than trade amount (${config.tradeAmountSol} SOL). ` +
            `Top up your wallet or lower TRADE_AMOUNT_SOL.`
        );
      }
    } catch (err) {
      throw new Error(`Failed to load trading keypair: ${err}`);
    }
  }

  // Resolve wallets to watch
  watchedWallets = await resolveWallets();

  // Send startup notification
  await sendMessage(
    buildStartupMessage(watchedWallets, config.tradeAmountSol, config.copyTradeEnabled)
  );

  console.log(
    `[bot] Polling every ${config.pollIntervalMs / 1000}s for ${watchedWallets.length} wallet(s).`
  );

  // Main loop
  while (true) {
    await Promise.all([poll(), handleCommands()]);
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

main().catch(async (err) => {
  console.error("[bot] Fatal error:", err);
  await sendError("startup", err).catch(() => {});
  process.exit(1);
});
