// ─── Telegram Alerts ─────────────────────────────────────────────────────────
import { config } from "./config.ts";
import type { WalletActivity } from "./supabase.ts";

const API = `https://api.telegram.org/bot${config.telegramBotToken}`;

export async function sendMessage(text: string): Promise<void> {
  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[telegram] send failed:", err);
    }
  } catch (e) {
    console.error("[telegram] network error:", e);
  }
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtMcap(mc: number | null): string {
  if (!mc) return "?";
  if (mc >= 1_000_000) return `$${(mc / 1_000_000).toFixed(2)}M`;
  if (mc >= 1_000) return `$${(mc / 1_000).toFixed(0)}K`;
  return `$${mc.toFixed(0)}`;
}

function fmtAge(secs: number | null): string {
  if (!secs) return "?";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h`;
}

// ── Alert: trade detected on a watched wallet ─────────────────────────────
export function buildTradeAlert(
  activity: WalletActivity,
  copyResult: string
): string {
  const isBuy = activity.action_type === "buy";
  const emoji = isBuy ? "🟢" : "🔴";
  const label = isBuy ? "BUY" : "SELL";

  const sol = activity.amount_sol != null
    ? `${activity.amount_sol.toFixed(4)} SOL`
    : "? SOL";
  const usd = activity.amount_usd != null
    ? ` (~$${activity.amount_usd.toFixed(2)})`
    : "";

  return [
    `${emoji} <b>SMART MONEY ${label} DETECTED</b>`,
    ``,
    `👛 Wallet: <code>${short(activity.wallet_address)}</code>`,
    `🪙 Token: <code>${activity.token_address}</code>`,
    `💰 Trade size: <b>${sol}${usd}</b>`,
    `📊 Market cap at entry: ${fmtMcap(activity.entry_market_cap)}`,
    `⏱ Token age: ${fmtAge(activity.token_age_at_entry)}`,
    ``,
    `🤖 Copy trade: <b>${copyResult}</b>`,
    ``,
    `🔗 <a href="https://solscan.io/tx/${activity.transaction_signature}">TX on Solscan</a>  |  <a href="https://pump.fun/coin/${activity.token_address}">Pump.fun</a>`,
  ].join("\n");
}

// ── Startup notification ──────────────────────────────────────────────────
export function buildStartupMessage(
  wallets: string[],
  tradeAmountSol: number,
  copyEnabled: boolean
): string {
  const walletLines = wallets
    .map((w, i) => `  ${i + 1}. <code>${w}</code>`)
    .join("\n");

  return [
    `🚀 <b>Solana Copy-Trade Bot Started</b>`,
    ``,
    `👁 Watching ${wallets.length} wallet(s):`,
    walletLines,
    ``,
    `⚙️ Settings`,
    `  • Trade size: <b>${tradeAmountSol} SOL</b> per copied buy`,
    `  • Copy trading: <b>${copyEnabled ? "✅ ENABLED" : "❌ ALERTS ONLY"}</b>`,
    `  • Min trade filter: $${process.env.MIN_TRADE_USD ?? "100"} USD`,
    ``,
    `Updates every ${Math.round(parseInt(process.env.POLL_INTERVAL_MS ?? "10000") / 1000)}s. Send /status to check.`,
  ].join("\n");
}

// ── Error notification ────────────────────────────────────────────────────
export async function sendError(context: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  await sendMessage(
    `⚠️ <b>Bot error</b> [${context}]\n<code>${msg.slice(0, 300)}</code>`
  );
}
