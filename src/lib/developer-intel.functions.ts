/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const addressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

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
