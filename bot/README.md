# Solana Copy-Trade & Alert Bot

A lightweight bot that watches your top smart-money wallets in Supabase,
sends Telegram alerts on every trade, and optionally copy-trades via Jupiter.

---

## Railway Deployment (Step-by-Step)

### 1. Add a new service inside your Railway project

1. Open your Railway project dashboard.
2. Click **"+ New Service"** → **"GitHub Repo"** (same repo).
3. Set the **Root Directory** to `bot`.
4. Railway will detect `railway.toml` and use Bun automatically.

### 2. Set the following Railway Variables for this service

| Variable | Description | Example |
|---|---|---|
| `SUPABASE_URL` | Your Supabase project URL | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | `eyJhbG...` |
| `TELEGRAM_BOT_TOKEN` | From @BotFather | `123456:ABC-DEF...` |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | `-100123456789` |
| `COPY_TRADE_PRIVATE_KEY` | Your trading wallet private key (base58 or JSON array) | `4abc...` or `[1,2,3,...]` |
| `HELIUS_API_KEY` | Your Helius API key (for Solana RPC) | `xxxxxxxx-xxxx-...` |

### 3. Optional / Adjustable Variables

| Variable | Default | Description |
|---|---|---|
| `TRADE_AMOUNT_SOL` | `0.1` | SOL to spend per copied BUY trade |
| `COPY_TRADE_ENABLED` | `true` | Set to `false` for alerts-only mode |
| `WATCHED_WALLETS` | _(auto)_ | Comma-separated wallet addresses to watch. Leave blank to auto-fetch top 3 from Supabase |
| `AUTO_FETCH_WALLET_COUNT` | `3` | How many top wallets to auto-fetch |
| `MIN_TOKENS_TRADED` | `20` | Min projects traded for auto-fetched wallets |
| `MIN_TRADE_USD` | `100` | Only copy trades ≥ this USD size |
| `SLIPPAGE_BPS` | `100` | Slippage in basis points (100 = 1%) |
| `POLL_INTERVAL_MS` | `10000` | How often to poll Supabase (ms) |
| `SOLANA_RPC_URL` | _(Helius)_ | Override RPC URL (optional) |

---

## How It Works

```
Supabase (wallet_token_activity)
       │ polls every 10s
       ▼
   [ Bot Process ]
       │
       ├─ BUY detected → Jupiter swap: SOL → Token (0.1 SOL)
       │                → Telegram alert ✅
       │
       └─ SELL detected → Jupiter swap: Token → SOL (full balance)
                        → Telegram alert 🔴
```

### Watched Wallets
- **Auto mode** (default): fetches top 3 wallets by average ROI with >20 tokens traded from your Supabase.
- **Manual mode**: set `WATCHED_WALLETS=addr1,addr2,addr3` in Railway variables to pin specific wallets. Update at any time — the bot re-reads on restart.

### Telegram Commands
Send these to your bot in the chat:
- `/status` — wallet balance, current watched wallets, settings
- `/wallets` — list watched wallets with Solscan links

---

## Local Development

```bash
cd bot
bun install

# Set env vars (or create .env)
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
export COPY_TRADE_PRIVATE_KEY=...
export HELIUS_API_KEY=...
export COPY_TRADE_ENABLED=false   # alerts only while testing

bun dev
```

---

## Security Notes

- **Never commit your private key.** Use Railway Variables only.
- The bot wallet should hold **only the SOL needed for trading** — not your main wallet.
- Start with `COPY_TRADE_ENABLED=false` to verify alerts before enabling live trades.
- Start with a small `TRADE_AMOUNT_SOL` (0.05–0.1) and increase after validation.
