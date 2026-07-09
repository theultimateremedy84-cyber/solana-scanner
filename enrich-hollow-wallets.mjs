#!/usr/bin/env node
// =============================================================================
// enrich-hollow-wallets.mjs
//
// Standalone enrichment script for Audits 2, 3, and 5.
// Fills 802 hollow wallets across 108 tokens with real Helius tx history.
//
// Requirements: Node.js 18+ (native fetch), no npm install needed.
//
// Usage:
//   HELIUS_API_KEY=xxx \
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=xxx \
//   node enrich-hollow-wallets.mjs
//
// Optional env vars:
//   HELIUS_HOURLY_BUDGET=2000   (CU limit per hour, default 2000)
//   CONCURRENCY=4               (parallel wallets per batch, default 4)
//   DELAY_MS=500                (ms pause between batches, default 500)
//   DRY_RUN=1                   (print plan but don't write to DB)
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL      || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const HELIUS_KEY   = process.env.HELIUS_API_KEY    || '';
const HOURLY_BUDGET= parseInt(process.env.HELIUS_HOURLY_BUDGET || '2000', 10);
const CONCURRENCY  = parseInt(process.env.CONCURRENCY          || '4',    10);
const DELAY_MS     = parseInt(process.env.DELAY_MS             || '500',  10);
const DRY_RUN      = process.env.DRY_RUN === '1';

const LAMPORTS     = 1_000_000_000;
const MIN_SOL      = 0.0005;

if (!SUPABASE_URL || !SUPABASE_KEY || !HELIUS_KEY) {
  console.error('❌  Missing required env vars: HELIUS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// ── Supabase helpers ────────────────────────────────────────────────────────

const SB_H = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'count=exact',
};

async function sbGet(path) {
  const res  = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB_H });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = []; }
  return Array.isArray(data) ? data : [];
}

async function sbGetAll(path, pageSize = 1000) {
  const all = [];
  let offset = 0;
  const sep = path.includes('?') ? '&' : '?';
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}limit=${pageSize}&offset=${offset}`, { headers: SB_H });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = []; }
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function sbUpsert(table, row) {
  if (DRY_RUN) return 204;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method:  'POST',
    headers: { ...SB_H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify(row),
  });
  return res.status;
}

async function sbPatch(table, filter, patch) {
  if (DRY_RUN) return 204;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method:  'PATCH',
    headers: { ...SB_H, Prefer: 'return=minimal' },
    body:    JSON.stringify(patch),
  });
  return res.status;
}

// ── Helius rate-limit bucket ────────────────────────────────────────────────

let cuUsedThisHour = 0;
let hourWindow     = Date.now();

function consumeCU(amount) {
  const now = Date.now();
  if (now - hourWindow >= 3_600_000) { cuUsedThisHour = 0; hourWindow = now; }
  if (HOURLY_BUDGET > 0 && cuUsedThisHour + amount > HOURLY_BUDGET) return false;
  cuUsedThisHour += amount;
  return true;
}

async function waitForBudget(amount, label) {
  while (!consumeCU(amount)) {
    const resetsIn = Math.ceil((hourWindow + 3_600_000 - Date.now()) / 1000);
    console.log(`⏳  Hourly budget reached — waiting ${resetsIn}s for reset (${label})`);
    await sleep(Math.min(resetsIn * 1000, 60_000));
  }
}

// ── Helius fetch ────────────────────────────────────────────────────────────

async function fetchHeliusTxs(walletAddress, limit = 100) {
  const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions` +
              `?api-key=${HELIUS_KEY}&limit=${limit}`;
  const res = await fetch(url);
  if (res.status === 429) {
    const retry = parseInt(res.headers.get('retry-after') || '5', 10);
    console.log(`  ⏳ Helius 429 — waiting ${retry}s`);
    await sleep(retry * 1000);
    return fetchHeliusTxs(walletAddress, limit); // retry once
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Helius ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

// ── Metric extraction ───────────────────────────────────────────────────────

function extractMetrics(txs, walletAddress, tokenMint) {
  let totalBuyTxs = 0, totalSellTxs = 0;
  let totalTokensBought = 0, totalTokensSold = 0;
  let totalSolInvested = 0, totalSolReceived = 0;
  let firstTs = null, lastTs = null;

  for (const tx of txs) {
    if (!Array.isArray(tx.tokenTransfers) || tx.tokenTransfers.length === 0) continue;

    const tokenTfs = tx.tokenTransfers.filter(t => t.mint === tokenMint);
    if (tokenTfs.length === 0) continue;

    const ts = tx.timestamp;
    if (!firstTs || ts < firstTs) firstTs = ts;
    if (!lastTs  || ts > lastTs)  lastTs  = ts;

    const walletReceives = tokenTfs.filter(t => t.toUserAccount   === walletAddress);
    const walletSends    = tokenTfs.filter(t => t.fromUserAccount === walletAddress);

    const nativeTfs = tx.nativeTransfers ?? [];
    const solOut    = nativeTfs.filter(t => t.fromUserAccount === walletAddress)
                               .reduce((s, t) => s + t.amount / LAMPORTS, 0);
    const solIn     = nativeTfs.filter(t => t.toUserAccount   === walletAddress)
                               .reduce((s, t) => s + t.amount / LAMPORTS, 0);

    if (walletReceives.length > 0 && solOut > MIN_SOL) {
      totalBuyTxs++;
      totalTokensBought += walletReceives.reduce((s, t) => s + (t.tokenAmount ?? 0), 0);
      totalSolInvested  += solOut;
    } else if (walletSends.length > 0 && solIn > MIN_SOL) {
      totalSellTxs++;
      totalTokensSold   += walletSends.reduce((s, t) => s + (t.tokenAmount ?? 0), 0);
      totalSolReceived  += solIn;
    }
  }

  const currentBalance = Math.max(0, totalTokensBought - totalTokensSold);

  let positionStatus = 'UNKNOWN';
  if (totalBuyTxs > 0 || totalTokensBought > 0) {
    if (totalSolInvested > 0) {
      if (totalTokensSold === 0)                           positionStatus = 'OPEN';
      else if (totalTokensSold >= totalTokensBought * 0.95) positionStatus = 'CLOSED';
      else                                                  positionStatus = 'PARTIALLY_CLOSED';
    } else {
      positionStatus = 'OPEN'; // received token without direct SOL spend (transfer/airdrop)
    }
  }

  return {
    totalBuyTxs, totalSellTxs,
    totalTokensBought, totalTokensSold,
    totalSolInvested, totalSolReceived,
    currentBalance, positionStatus,
    firstTs, lastTs,
    hasEvidence: totalBuyTxs > 0 || totalSellTxs > 0 || totalTokensBought > 0,
  };
}

// ── Write results to Supabase ───────────────────────────────────────────────

const POSITION_RANK = { UNKNOWN: 0, OPEN: 1, PARTIALLY_CLOSED: 2, CLOSED: 3 };

async function writeMetrics(walletAddress, tokenAddress, m) {
  const now = new Date().toISOString();

  // 1. wallet_raw_tx_metrics
  await sbUpsert('wallet_raw_tx_metrics', {
    wallet_address:        walletAddress,
    token_address:         tokenAddress,
    total_buy_txs:         m.totalBuyTxs,
    total_sell_txs:        m.totalSellTxs,
    total_tokens_bought:   m.totalTokensBought,
    total_tokens_sold:     m.totalTokensSold,
    total_sol_invested:    m.totalSolInvested,
    total_sol_received:    m.totalSolReceived,
    current_token_balance: m.currentBalance,
    data_source:           'helius_full_history',
    first_tx_at: m.firstTs ? new Date(m.firstTs * 1000).toISOString() : null,
    last_tx_at:  m.lastTs  ? new Date(m.lastTs  * 1000).toISOString() : null,
    last_scanned_at: now,
  });

  // 2. wallet_performance_history — only upgrade position_status, never downgrade
  if (m.positionStatus !== 'UNKNOWN') {
    const perfPatch = {
      position_status:       m.positionStatus,
      current_token_balance: m.currentBalance,
      last_updated:          now,
    };
    if (m.totalSolInvested > 0)  perfPatch.initial_investment = m.totalSolInvested;
    if (m.totalSolReceived > 0)  perfPatch.current_value      = m.totalSolReceived;
    if (m.totalTokensBought > 0) perfPatch.total_tokens_bought = m.totalTokensBought;
    if (m.totalTokensSold   > 0) perfPatch.total_tokens_sold   = m.totalTokensSold;

    if (m.positionStatus === 'CLOSED' && m.totalSolInvested > 0) {
      perfPatch.roi_multiple    = Math.round((m.totalSolReceived / m.totalSolInvested) * 10000) / 10000;
      perfPatch.realized_profit = Math.round((m.totalSolReceived - m.totalSolInvested) * 10000) / 10000;
    }

    // Only patch rows where current status rank is lower than new rank
    const lowerStatuses = Object.entries(POSITION_RANK)
      .filter(([, r]) => r < POSITION_RANK[m.positionStatus])
      .map(([s]) => s);

    if (lowerStatuses.length > 0) {
      for (const oldStatus of lowerStatuses) {
        await sbPatch(
          'wallet_performance_history',
          `wallet_address=eq.${walletAddress}&token_address=eq.${encodeURIComponent(tokenAddress)}&position_status=eq.${oldStatus}`,
          perfPatch,
        );
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Solana Scanner — Hollow Wallet Enrichment Script ');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Mode        : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`  Concurrency : ${CONCURRENCY} wallets/batch`);
  console.log(`  Batch delay : ${DELAY_MS}ms`);
  console.log(`  Hourly CU   : ${HOURLY_BUDGET}`);
  console.log('');

  // Step 1: Fetch all wallet_performance_history rows (paginated across the full table)
  console.log('📥 Fetching wallet_performance_history...');
  const perfRows = await sbGetAll('wallet_performance_history?select=wallet_address,token_address');
  console.log(`   ${perfRows.length} rows`);

  // Step 2: Fetch all existing helius_full_history raw metrics (paginated)
  console.log('📥 Fetching existing helius enrichments...');
  const rawRows = await sbGetAll('wallet_raw_tx_metrics?select=wallet_address,token_address,data_source&data_source=eq.helius_full_history');
  const enrichedSet = new Set(
    rawRows.filter(r => r.data_source === 'helius_full_history')
           .map(r => `${r.wallet_address}::${r.token_address}`)
  );
  console.log(`   ${enrichedSet.size} already enriched`);

  // Step 3: Build hollow wallet list, grouped by token (highest count first)
  const tokenMap = {};
  for (const r of perfRows) {
    const key = `${r.wallet_address}::${r.token_address}`;
    if (!enrichedSet.has(key)) {
      if (!tokenMap[r.token_address]) tokenMap[r.token_address] = [];
      tokenMap[r.token_address].push(r.wallet_address);
    }
  }
  const tokenList = Object.entries(tokenMap)
    .map(([token, wallets]) => ({ token, wallets: [...new Set(wallets)] }))
    .sort((a, b) => b.wallets.length - a.wallets.length);

  const totalWallets = tokenList.reduce((s, t) => s + t.wallets.length, 0);
  console.log(`\n🎯 Hollow wallets to enrich: ${totalWallets} across ${tokenList.length} tokens`);
  console.log(`   Top 5 tokens:`);
  tokenList.slice(0, 5).forEach((t, i) =>
    console.log(`     ${i + 1}. ${t.token.slice(0, 20)}… — ${t.wallets.length} wallets`)
  );

  if (DRY_RUN) {
    console.log('\n⚠️  DRY_RUN=1 — exiting without writing. Remove DRY_RUN to run for real.');
    return;
  }

  // Step 4: Enrich all wallets
  let processed = 0, enriched = 0, skipped = 0, errors = 0;
  const startTime = Date.now();

  for (let ti = 0; ti < tokenList.length; ti++) {
    const { token, wallets } = tokenList[ti];

    for (let i = 0; i < wallets.length; i += CONCURRENCY) {
      const batch = wallets.slice(i, i + CONCURRENCY);

      await waitForBudget(batch.length, token.slice(0, 12));

      await Promise.all(batch.map(async (wallet) => {
        try {
          const txs = await fetchHeliusTxs(wallet, 100);
          const m   = extractMetrics(txs, wallet, token);
          if (!m.hasEvidence) { skipped++; return; }
          await writeMetrics(wallet, token, m);
          enriched++;
        } catch (err) {
          errors++;
          console.error(`  ✗ ${wallet.slice(0, 12)}… ${err.message?.slice(0, 80)}`);
        } finally {
          processed++;
        }
      }));

      if (i + CONCURRENCY < wallets.length) await sleep(DELAY_MS);
    }

    // Progress log every 10 tokens
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    if ((ti + 1) % 10 === 0 || ti === tokenList.length - 1) {
      console.log(
        `  [${ti + 1}/${tokenList.length}] processed=${processed}/${totalWallets} ` +
        `enriched=${enriched} skipped=${skipped} errors=${errors} | ${elapsed}s`
      );
    }
  }

  // Step 5: Trigger rescore via Supabase RPC (direct wallet upsert classification)
  console.log('\n🔄 Running classification rescore from updated data...');
  // Re-read raw metrics only for wallets touched in this run, compute classification stats
  const touchedWallets = [...allWalletsSeen];
  let updatedRaw = [];
  for (let i = 0; i < touchedWallets.length; i += 50) {
    const batch = touchedWallets.slice(i, i + 50).map(encodeURIComponent).join(',');
    const rows = await sbGet(
      `wallet_raw_tx_metrics?select=wallet_address,data_source,total_buy_txs,total_sell_txs,total_sol_invested&wallet_address=in.(${batch})`,
    );
    updatedRaw.push(...rows);
  }
  const walletRaw  = {};
  for (const r of updatedRaw) {
    const k = r.wallet_address;
    if (!walletRaw[k]) walletRaw[k] = { buys: 0, sells: 0, sol: 0 };
    walletRaw[k].buys += Number(r.total_buy_txs   || 0);
    walletRaw[k].sells += Number(r.total_sell_txs  || 0);
    walletRaw[k].sol   += Number(r.total_sol_invested || 0);
  }

  let rescored = 0;
  for (const [addr, stats] of Object.entries(walletRaw)) {
    let classification = 'retail';
    if (stats.sol >= 50)                                          classification = 'whale';
    else if (stats.buys >= 10 && stats.sells / stats.buys >= 0.8) classification = 'bot';

    const s = await sbPatch('wallets', `wallet_address=eq.${addr}`,
      { wallet_classification: classification, updated_at: new Date().toISOString() }
    );
    if (s === 204) rescored++;
  }
  console.log(`  ✅ Reclassified ${rescored} wallets`);

  // Final summary
  console.log('\n═══════════════════ DONE ═══════════════════');
  console.log(`  Wallets processed : ${processed}`);
  console.log(`  Enriched (wrote)  : ${enriched}`);
  console.log(`  No tx evidence    : ${skipped}`);
  console.log(`  Errors            : ${errors}`);
  console.log(`  Rescored wallets  : ${rescored}`);
  console.log(`  Duration          : ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log('═══════════════════════════════════════════');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
