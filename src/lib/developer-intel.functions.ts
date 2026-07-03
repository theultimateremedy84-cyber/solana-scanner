/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
// P2-D follow-up: use the canonical service-role singleton — no local raw
// fetch to Supabase REST with anon-key fallback chain.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const addressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

// ---------------------------------------------------------------------------
// Phase 10 — Developer Profile by wallet address
// ---------------------------------------------------------------------------

interface DbScanRow {
  token_address: string;
  token_name: string | null;
  token_symbol: string | null;
  risk_score: number;
  risk_level: string;
  honey_pot_status: string | null;
  lp_status: string | null;
  market_cap: number | null;
  liquidity: number | null;
  image_url: string | null;
  scanned_at: string;
  developer_classification: string | null;
}

/**
 * Fetch the full Developer History profile for a wallet address directly.
 * Queries scan_history (Supabase) for all tokens the wallet has deployed,
 * computes Phase 10 classification and risk stats, and returns the result.
 *
 * Route: /developer/profile/:wallet
 */
export const getDeveloperProfileByWallet = createServerFn({ method: "GET" })
  .inputValidator(z.object({ walletAddress: addressSchema }))
  .handler(async ({ data }) => {
    let dbRows: DbScanRow[] = [];

    try {
      const { data: rows, error } = await supabaseAdmin
        .from("scan_history")
        .select(
          "token_address,token_name,token_symbol,risk_score,risk_level," +
          "honey_pot_status,lp_status,market_cap,liquidity,image_url," +
          "scanned_at,developer_classification",
        )
        .eq("developer_wallet", data.walletAddress)
        .order("scanned_at", { ascending: false })
        .limit(200);
      if (!error && Array.isArray(rows)) dbRows = rows as DbScanRow[];
    } catch {
      // Best-effort — continue with empty dbRows
    }

    // De-duplicate: keep the most-recent scan per token_address
    const seen = new Set<string>();
    const unique: DbScanRow[] = [];
    for (const row of dbRows) {
      if (!seen.has(row.token_address)) {
        seen.add(row.token_address);
        unique.push(row);
      }
    }

    // Aggregate risk counts
    let extremeCount = 0;
    let highCount = 0;
    let suspiciousCount = 0;
    let cleanCount = 0;
    let confirmedHoneypotCount = 0;

    for (const row of unique) {
      const level = (row.risk_level ?? "").toUpperCase();
      const honey = (row.honey_pot_status ?? "").toUpperCase();
      if (honey === "CONFIRMED HONEYPOT") confirmedHoneypotCount++;
      if (level === "EXTREME") extremeCount++;
      else if (level === "HIGH") highCount++;
      else if (level === "MEDIUM") suspiciousCount++;
      else cleanCount++;
    }

    // Phase 10 classification (mirrors developerHistory.ts)
    let classification: string;
    if (confirmedHoneypotCount >= 1 || extremeCount >= 3) {
      classification = "Confirmed Scammer";
    } else if (extremeCount >= 1 || highCount >= 2) {
      classification = "Serial Offender";
    } else if (highCount >= 1 || suspiciousCount >= 2) {
      classification = "Suspicious";
    } else {
      classification = "Clean";
    }

    const tokens = unique
      .map((row) => ({
        tokenAddress: row.token_address,
        tokenName: row.token_name,
        tokenSymbol: row.token_symbol,
        riskScore: row.risk_score,
        riskLevel: row.risk_level,
        honeyPotStatus: row.honey_pot_status,
        lpStatus: row.lp_status,
        marketCap: row.market_cap,
        liquidity: row.liquidity,
        imageUrl: row.image_url,
        scannedAt: row.scanned_at,
      }))
      .sort(
        (a, b) =>
          new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime(),
      );

    return {
      walletAddress: data.walletAddress,
      classification,
      totalLaunches: unique.length,
      extremeCount,
      highCount,
      suspiciousCount,
      cleanCount,
      confirmedHoneypotCount,
      dataFromDb: unique.length > 0,
      tokens,
    };
  });

// ---------------------------------------------------------------------------
// Phase 10 — Global Developer Watchlist
// ---------------------------------------------------------------------------

interface WatchlistRow {
  developer_wallet: string | null;
  developer_classification: string | null;
  token_address: string;
  token_name: string | null;
  token_symbol: string | null;
  risk_score: number;
  risk_level: string;
  scanned_at: string;
}

export interface WatchlistEntry {
  walletAddress: string;
  classification: "Confirmed Scammer" | "Serial Offender";
  tokenCount: number;
  highestRiskScore: number;
  worstRiskLevel: string;
  firstSeen: string;
  lastSeen: string;
  tokens: { tokenAddress: string; tokenName: string | null; tokenSymbol: string | null; riskScore: number; riskLevel: string; scannedAt: string }[];
}

/**
 * Return all developer wallets flagged as "Confirmed Scammer" or "Serial Offender"
 * across the entire scan_history. Results are grouped by wallet with per-wallet stats.
 */
export const getDeveloperWatchlist = createServerFn({ method: "GET" })
  .handler(async () => {
    let rows: WatchlistRow[] = [];

    try {
      const { data, error } = await supabaseAdmin
        .from("scan_history")
        .select(
          "developer_wallet,developer_classification,token_address," +
          "token_name,token_symbol,risk_score,risk_level,scanned_at",
        )
        .in("developer_classification", ["Confirmed Scammer", "Serial Offender"])
        .order("scanned_at", { ascending: false })
        .limit(1000);
      if (!error && Array.isArray(data)) rows = data as WatchlistRow[];
    } catch {
      // best-effort
    }

    // Group rows by developer_wallet
    const walletMap = new Map<string, WatchlistRow[]>();
    for (const row of rows) {
      if (!row.developer_wallet) continue;
      const existing = walletMap.get(row.developer_wallet) ?? [];
      existing.push(row);
      walletMap.set(row.developer_wallet, existing);
    }

    // Build WatchlistEntry per wallet
    const entries: WatchlistEntry[] = [];
    for (const [wallet, walletRows] of walletMap.entries()) {
      // De-duplicate tokens (keep highest risk score per token)
      const tokenMap = new Map<string, WatchlistRow>();
      for (const row of walletRows) {
        const existing = tokenMap.get(row.token_address);
        if (!existing || row.risk_score > existing.risk_score) {
          tokenMap.set(row.token_address, row);
        }
      }
      const uniqueTokens = Array.from(tokenMap.values());

      const dates = walletRows.map((r) => new Date(r.scanned_at).getTime()).filter(Boolean);
      const highestRiskScore = Math.max(...uniqueTokens.map((t) => t.risk_score));
      const worstToken = uniqueTokens.sort((a, b) => b.risk_score - a.risk_score)[0];

      // Use the most recent classification for this wallet
      const classification = (walletRows[0]?.developer_classification ??
        "Serial Offender") as WatchlistEntry["classification"];

      entries.push({
        walletAddress: wallet,
        classification,
        tokenCount: uniqueTokens.size ?? uniqueTokens.length,
        highestRiskScore,
        worstRiskLevel: worstToken?.risk_level ?? "EXTREME",
        firstSeen: new Date(Math.min(...dates)).toISOString(),
        lastSeen: new Date(Math.max(...dates)).toISOString(),
        tokens: uniqueTokens
          .sort((a, b) => b.risk_score - a.risk_score)
          .map((t) => ({
            tokenAddress: t.token_address,
            tokenName: t.token_name,
            tokenSymbol: t.token_symbol,
            riskScore: t.risk_score,
            riskLevel: t.risk_level,
            scannedAt: t.scanned_at,
          })),
      });
    }

    // Sort: Confirmed Scammers first, then by token count desc
    entries.sort((a, b) => {
      if (a.classification !== b.classification) {
        return a.classification === "Confirmed Scammer" ? -1 : 1;
      }
      return b.tokenCount - a.tokenCount;
    });

    return {
      entries,
      totalFlagged: entries.length,
      confirmedScammerCount: entries.filter(
        (e) => e.classification === "Confirmed Scammer",
      ).length,
      serialOffenderCount: entries.filter(
        (e) => e.classification === "Serial Offender",
      ).length,
      dataFromDb: rows.length > 0,
    };
  });

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

type CreatorToken = { mint: string; marketCap: number; createdAt: string | null };

export const getDeveloperProjects = createServerFn({ method: "GET" })
  .inputValidator(z.object({ tokenAddress: addressSchema }))
  .handler(async ({ data }) => {
    const report = await fetchJson<any>(
      `https://api.rugcheck.xyz/v1/tokens/${data.tokenAddress}/report`,
      { headers: { accept: "application/json" } },
    );
    const developerAddress = typeof report?.creator === "string" ? report.creator : "";
    let projects: CreatorToken[] = Array.isArray(report?.creatorTokens)
      ? report.creatorTokens
          .filter((token: any) => typeof token?.mint === "string")
          .map((token: any) => ({
            mint: token.mint,
            marketCap: Number(token?.marketCap ?? 0) || 0,
            createdAt: typeof token?.createdAt === "string" ? token.createdAt : null,
          }))
      : [];

    const key = process.env.HELIUS_API_KEY ?? "";
    if (projects.length === 0 && developerAddress && key) {
      const assetsResponse = await fetchJson<any>(
        `https://mainnet.helius-rpc.com/?api-key=${key}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "creator-projects",
            method: "searchAssets",
            params: {
              creatorAddress: developerAddress,
              tokenType: "fungible",
              page: 1,
              limit: 100,
            },
          }),
        },
      );
      const assets = Array.isArray(assetsResponse?.result?.items)
        ? assetsResponse.result.items
        : [];
      projects = assets
        .filter((asset: any) => typeof asset?.id === "string")
        .map((asset: any) => ({
          mint: asset.id,
          marketCap: 0,
          createdAt: null,
        }));
    }

    const enriched = await Promise.all(
      projects.map(async (project) => {
        const market = await fetchJson<any>(
          `https://api.dexscreener.com/latest/dex/tokens/${project.mint}`,
        );
        const pairs = Array.isArray(market?.pairs) ? market.pairs : [];
        const pair = pairs
          .filter((item: any) => item?.chainId === "solana")
          .sort(
            (a: any, b: any) => Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0),
          )[0];
        return {
          ...project,
          name: pair?.baseToken?.name ?? "Unknown token",
          symbol: pair?.baseToken?.symbol ?? "—",
          imageUrl: pair?.info?.imageUrl as string | undefined,
          priceUsd: Number(pair?.priceUsd ?? 0) || 0,
          liquidity: Number(pair?.liquidity?.usd ?? 0) || 0,
          volume24h: Number(pair?.volume?.h24 ?? 0) || 0,
          pairAddress: pair?.pairAddress as string | undefined,
        };
      }),
    );

    return {
      sourceToken: data.tokenAddress,
      developerAddress,
      totalProjects: enriched.length,
      projects: enriched,
    };
  });

export const getDeveloperProjectDetail = createServerFn({ method: "GET" })
  .inputValidator(z.object({ developerAddress: addressSchema, mint: addressSchema }))
  .handler(async ({ data }) => {
    const [report, market] = await Promise.all([
      fetchJson<any>(`https://api.rugcheck.xyz/v1/tokens/${data.mint}/report`, {
        headers: { accept: "application/json" },
      }),
      fetchJson<any>(`https://api.dexscreener.com/latest/dex/tokens/${data.mint}`),
    ]);
    const pairs = Array.isArray(market?.pairs) ? market.pairs : [];
    const pair = pairs
      .filter((item: any) => item?.chainId === "solana")
      .sort((a: any, b: any) => Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0))[0];
    const key = process.env.HELIUS_API_KEY ?? "";
    const activity = key
      ? await fetchJson<any[]>(
          `https://api.helius.xyz/v0/addresses/${data.developerAddress}/transactions?api-key=${key}&limit=100`,
        )
      : [];
    const relatedTransactions = (Array.isArray(activity) ? activity : [])
      .filter(
        (transaction: any) =>
          Array.isArray(transaction?.tokenTransfers) &&
          transaction.tokenTransfers.some((transfer: any) => transfer?.mint === data.mint),
      )
      .slice(0, 25)
      .map((transaction: any) => ({
        signature: String(transaction?.signature ?? ""),
        type: String(transaction?.type ?? "UNKNOWN"),
        description: String(transaction?.description ?? "On-chain token activity"),
        timestamp: Number(transaction?.timestamp ?? 0) || null,
        feePayer: String(transaction?.feePayer ?? ""),
      }));

    const creator = typeof report?.creator === "string" ? report.creator : "";
    const roles = [
      creator === data.developerAddress ? "Token creator" : null,
      report?.mintAuthority === data.developerAddress ? "Mint authority" : null,
      report?.freezeAuthority === data.developerAddress ? "Freeze authority" : null,
    ].filter((role): role is string => Boolean(role));

    return {
      mint: data.mint,
      developerAddress: data.developerAddress,
      name: pair?.baseToken?.name ?? report?.tokenMeta?.name ?? "Unknown token",
      symbol: pair?.baseToken?.symbol ?? report?.tokenMeta?.symbol ?? "—",
      imageUrl: pair?.info?.imageUrl as string | undefined,
      marketCap: Number(pair?.marketCap ?? pair?.fdv ?? 0) || 0,
      liquidity: Number(pair?.liquidity?.usd ?? 0) || 0,
      volume24h: Number(pair?.volume?.h24 ?? 0) || 0,
      createdAt: pair?.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
      riskScore: Number(report?.score_normalised ?? report?.score ?? 0) || 0,
      roles: roles.length ? roles : ["Linked creator wallet"],
      mintAuthority: report?.mintAuthority || null,
      freezeAuthority: report?.freezeAuthority || null,
      relatedTransactions,
      activityAvailable: Boolean(key),
    };
  });
