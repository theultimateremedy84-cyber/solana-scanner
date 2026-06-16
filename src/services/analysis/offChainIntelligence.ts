// Off-chain intelligence service.
// Manages external data integrations: social sentiment, website authenticity,
// and consolidated intent scoring.
//
// All functions are designed to degrade gracefully — a network failure or
// missing URL returns a neutral / unavailable result rather than throwing.

import type {
  OffChainIntelligenceResult,
  HypeSignal,
  WebsiteFlag,
} from "./types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function safeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch {
    return null;
  }
}

async function safeText(url: string, init?: RequestInit): Promise<string | null> {
  const res = await safeFetch(url, init);
  if (!res || !res.ok) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

// Spam / low-effort keywords found in meme-coin social channels.
const SPAM_PATTERNS: RegExp[] = [
  /\bwen\s+moon\b/i,
  /\bwen\s+lambo\b/i,
  /\b100[xX]\b/,
  /\b1000[xX]\b/,
  /\bgm\s+gm\b/i,
  /\bLFG\b/,
  /\bto\s+the\s+moon\b/i,
  /\bfud\b/i,
  /\bnfa\b/i,
  /\bape\s+in\b/i,
  /\bshill\b/i,
];

// Patterns that indicate genuine project discussion.
const QUALITY_PATTERNS: RegExp[] = [
  /\butility\b/i,
  /\bwhitepaper\b/i,
  /\broadmap\b/i,
  /\bpartnership\b/i,
  /\baudit\b/i,
  /\bteam\b/i,
  /\bstaking\b/i,
  /\bgovernance\b/i,
  /\btokenomics\b/i,
  /\bdevelopment\b/i,
  /\buse\s+case\b/i,
  /\bprotocol\b/i,
];

// Known website-builder / template artifacts.
const TEMPLATE_SIGNATURES: { pattern: RegExp; label: string }[] = [
  { pattern: /wix\.com|wixstatic\.com/i, label: "Wix website builder" },
  { pattern: /squarespace\.com/i, label: "Squarespace template" },
  { pattern: /webflow\.com/i, label: "Webflow template" },
  { pattern: /wordpress\.org|wp-content/i, label: "WordPress (generic install)" },
  { pattern: /weebly\.com/i, label: "Weebly website builder" },
  { pattern: /github\.io/i, label: "GitHub Pages static template" },
  { pattern: /netlify\.app/i, label: "Netlify generic deploy" },
  { pattern: /framer\.website|framer\.com/i, label: "Framer template" },
];

// Placeholder / lorem ipsum strings.
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /lorem\s+ipsum/i,
  /dolor\s+sit\s+amet/i,
  /\[your\s+(project|token|team|name)\]/i,
  /coming\s+soon/i,
  /page\s+under\s+construction/i,
  /insert\s+text\s+here/i,
  /\[insert\]/i,
];

// ---------------------------------------------------------------------------
// 1. Social Sentiment & Hype Scoring
// ---------------------------------------------------------------------------

/**
 * Checks a Twitter/X profile by fetching its public oEmbed endpoint.
 * Returns basic presence signal — we do not require a Twitter API key.
 */
async function probeTwitterHandle(handle: string): Promise<{
  exists: boolean;
  profileUrl: string;
}> {
  const profileUrl = `https://twitter.com/${handle}`;
  const oEmbedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(profileUrl)}&omit_script=true`;
  const res = await safeFetch(oEmbedUrl);
  return { exists: res?.ok === true, profileUrl };
}

/**
 * Extracts social handles / URLs from DexScreener-style socials array
 * or from free-text metadata URIs.
 */
function extractSocialUrls(socials: { type: string; url: string }[]): {
  twitter: string | null;
  telegram: string | null;
  other: string[];
} {
  let twitter: string | null = null;
  let telegram: string | null = null;
  const other: string[] = [];

  for (const s of socials) {
    const url = s.url?.trim() ?? "";
    if (!url) continue;
    const type = (s.type ?? "").toLowerCase();
    if (type === "twitter" || /twitter\.com|x\.com/i.test(url)) {
      twitter = url;
    } else if (type === "telegram" || /t\.me\//i.test(url)) {
      telegram = url;
    } else {
      other.push(url);
    }
  }
  return { twitter, telegram, other };
}

/**
 * Grade raw text for hype vs quality signals.
 * Returns { spamCount, qualityCount, spamExamples }.
 */
function gradeText(text: string): {
  spamCount: number;
  qualityCount: number;
  spamExamples: string[];
} {
  let spamCount = 0;
  let qualityCount = 0;
  const spamExamples: string[] = [];

  for (const pat of SPAM_PATTERNS) {
    const match = text.match(pat);
    if (match) {
      spamCount++;
      if (spamExamples.length < 3) spamExamples.push(match[0]);
    }
  }
  for (const pat of QUALITY_PATTERNS) {
    if (pat.test(text)) qualityCount++;
  }

  return { spamCount, qualityCount, spamExamples };
}

/**
 * Fetches public Telegram group preview HTML and grades it for signals.
 */
async function probeTelegram(url: string): Promise<{
  reachable: boolean;
  memberCount: number | null;
  grade: ReturnType<typeof gradeText>;
}> {
  // Convert t.me/<group> to the preview endpoint.
  const previewUrl = url.replace(/^https?:\/\/t\.me\//i, "https://t.me/s/");
  const html = await safeText(previewUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; scanner-bot/1.0)" },
  });
  if (!html) return { reachable: false, memberCount: null, grade: { spamCount: 0, qualityCount: 0, spamExamples: [] } };

  // Extract member count if present (Telegram preview shows "N members").
  const memberMatch = html.match(/([\d,]+)\s+members?/i);
  const memberCount = memberMatch
    ? parseInt(memberMatch[1].replace(/,/g, ""), 10)
    : null;

  // Grab visible message text for grading.
  const strippedText = html.replace(/<[^>]+>/g, " ");
  const grade = gradeText(strippedText);

  return { reachable: true, memberCount, grade };
}

/**
 * Compute a 0–100 hype score and classify it.
 * Lower scores = more organic; higher = more spam.
 * Returns 50 (neutral) when data is unavailable.
 */
export async function fetchHypeScore(
  socials: { type: string; url: string }[],
  websiteText?: string,
): Promise<{
  hypeScore: number;
  hypeVerdict: OffChainIntelligenceResult["hypeVerdict"];
  hypeSignals: HypeSignal[];
}> {
  if (!socials.length && !websiteText) {
    return {
      hypeScore: 50,
      hypeVerdict: "unavailable",
      hypeSignals: [],
    };
  }

  const { twitter, telegram } = extractSocialUrls(socials);
  const signals: HypeSignal[] = [];
  let totalSpam = 0;
  let totalQuality = 0;
  let sourcesChecked = 0;

  // --- Twitter presence check ---
  if (twitter) {
    const handle = twitter.replace(/.*(?:twitter\.com|x\.com)\/?(@?)/i, "").replace(/^@/, "").split(/[/?#]/)[0];
    if (handle) {
      const probe = await probeTwitterHandle(handle);
      signals.push({
        source: `Twitter/@${handle}`,
        type: probe.exists ? "neutral" : "spam_mention",
        count: 1,
        examples: probe.exists ? [`Profile found: ${probe.profileUrl}`] : ["Profile not found or suspended"],
      });
      if (!probe.exists) totalSpam += 2;
      sourcesChecked++;
    }
  }

  // --- Telegram community check ---
  if (telegram) {
    const tg = await probeTelegram(telegram);
    if (tg.reachable) {
      const { spamCount, qualityCount, spamExamples } = tg.grade;
      totalSpam += spamCount;
      totalQuality += qualityCount;
      sourcesChecked++;

      const memberLabel =
        tg.memberCount != null ? `${tg.memberCount.toLocaleString()} members` : "unknown members";

      signals.push({
        source: "Telegram",
        type: spamCount > qualityCount * 2 ? "spam_mention" : qualityCount > 0 ? "quality_mention" : "neutral",
        count: tg.memberCount ?? 0,
        examples: [
          memberLabel,
          ...spamExamples.slice(0, 2),
        ],
      });

      // Very small or empty groups are a yellow flag.
      if (tg.memberCount !== null && tg.memberCount < 50) {
        totalSpam += 3;
        signals.push({
          source: "Telegram",
          type: "spam_mention",
          count: tg.memberCount,
          examples: [`Only ${tg.memberCount} members — minimal community presence`],
        });
      }
    } else {
      signals.push({
        source: "Telegram",
        type: "spam_mention",
        count: 0,
        examples: ["Telegram group unreachable or private"],
      });
      totalSpam += 1;
      sourcesChecked++;
    }
  }

  // --- Website text grading (if passed in) ---
  if (websiteText) {
    const { spamCount, qualityCount, spamExamples } = gradeText(websiteText);
    totalSpam += spamCount;
    totalQuality += qualityCount;
    if (spamCount > 0 || qualityCount > 0) {
      signals.push({
        source: "Website copy",
        type: spamCount > qualityCount ? "spam_mention" : "quality_mention",
        count: spamCount + qualityCount,
        examples: spamExamples,
      });
      sourcesChecked++;
    }
  }

  if (sourcesChecked === 0) {
    return { hypeScore: 50, hypeVerdict: "unavailable", hypeSignals: signals };
  }

  // Score: base 50, +5 per quality signal, +8 per spam signal, capped 0-100.
  const rawScore = 50 - totalQuality * 5 + totalSpam * 8;
  const hypeScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  const hypeVerdict: OffChainIntelligenceResult["hypeVerdict"] =
    hypeScore >= 70
      ? "spam_heavy"
      : hypeScore >= 45
        ? "mixed"
        : "organic";

  return { hypeScore, hypeVerdict, hypeSignals: signals };
}

// ---------------------------------------------------------------------------
// 2. Website & Whitepaper Authenticity Audit
// ---------------------------------------------------------------------------

/**
 * Fetches a URL and inspects the HTML for high-confidence red flags.
 * Does not require a headless browser for the initial pass; analysis is
 * performed on the raw HTML/text. Swap `safeText` for a Puppeteer call
 * if a fully-rendered DOM is needed (e.g., SPA sites).
 */
export async function auditWebsite(url: string): Promise<{
  grade: OffChainIntelligenceResult["websiteAuthenticityGrade"];
  flags: WebsiteFlag[];
  rawText: string;
}> {
  const flags: WebsiteFlag[] = [];

  if (!url) {
    return { grade: "unavailable", flags, rawText: "" };
  }

  // --- Fetch the page ---
  const res = await safeFetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; scanner-bot/1.0)" },
  });

  if (!res) {
    flags.push({
      id: "fetch_failed",
      label: "Website unreachable",
      severity: "high",
      detail: `Could not connect to ${url}. The site may be down or non-existent.`,
    });
    return { grade: "F", flags, rawText: "" };
  }

  if (res.status === 404) {
    flags.push({
      id: "404",
      label: "Broken link (404)",
      severity: "high",
      detail: `${url} returned HTTP 404 Not Found.`,
    });
    return { grade: "F", flags, rawText: "" };
  }

  if (!res.ok) {
    flags.push({
      id: `http_${res.status}`,
      label: `HTTP error ${res.status}`,
      severity: "warn",
      detail: `Website returned an unexpected status code: ${res.status}.`,
    });
    return { grade: "D", flags, rawText: "" };
  }

  const html = await res.text().catch(() => "");
  const rawText = html.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ");

  // --- Template / website builder check ---
  for (const sig of TEMPLATE_SIGNATURES) {
    if (sig.pattern.test(html)) {
      flags.push({
        id: `template_${sig.label.replace(/\s/g, "_").toLowerCase()}`,
        label: `Template builder detected: ${sig.label}`,
        severity: "warn",
        detail: `The site appears to be built with ${sig.label}. Low-effort builder sites are common in scam projects.`,
      });
    }
  }

  // --- Placeholder / Lorem ipsum text ---
  for (const pat of PLACEHOLDER_PATTERNS) {
    const match = rawText.match(pat);
    if (match) {
      flags.push({
        id: `placeholder_${match[0].slice(0, 20).replace(/\s/g, "_")}`,
        label: "Placeholder text found",
        severity: "critical",
        detail: `"${match[0]}" found on the page — indicates an unfinished or cloned project.`,
      });
    }
  }

  // --- Missing essential sections ---
  const hasAbout =
    /\babout\s*(us)?\b|\bteam\b|\bwho\s+we\s+are\b/i.test(rawText);
  const hasRoadmap =
    /\broadmap\b|\bmilestone\b|\bq[1-4]\s+20\d{2}\b/i.test(rawText);
  const hasTitle = /<title[^>]*>[^<]{3,}<\/title>/i.test(html);

  if (!hasTitle) {
    flags.push({
      id: "no_title",
      label: "Missing page title",
      severity: "warn",
      detail: "The page has no <title> tag — suggests an incomplete or auto-generated build.",
    });
  }
  if (!hasAbout) {
    flags.push({
      id: "no_about",
      label: "No team / about section",
      severity: "warn",
      detail: "No 'About' or 'Team' section found. Legitimate projects typically introduce their team.",
    });
  }
  if (!hasRoadmap) {
    flags.push({
      id: "no_roadmap",
      label: "No roadmap found",
      severity: "info",
      detail: "No roadmap or milestone section detected on the site.",
    });
  }

  // --- Very thin content ---
  const wordCount = rawText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 80) {
    flags.push({
      id: "thin_content",
      label: "Extremely thin website content",
      severity: "high",
      detail: `Only ~${wordCount} words detected. Extremely sparse sites often indicate a clone or placeholder launch page.`,
    });
  } else if (wordCount < 200) {
    flags.push({
      id: "sparse_content",
      label: "Sparse website content",
      severity: "warn",
      detail: `Only ~${wordCount} words detected. A real project typically has substantially more content.`,
    });
  }

  // --- Grade from flag severity ---
  const criticalCount = flags.filter((f) => f.severity === "critical").length;
  const highCount = flags.filter((f) => f.severity === "high").length;
  const warnCount = flags.filter((f) => f.severity === "warn").length;

  let grade: OffChainIntelligenceResult["websiteAuthenticityGrade"];
  if (criticalCount >= 1 || highCount >= 2) {
    grade = "F";
  } else if (highCount >= 1 || warnCount >= 3) {
    grade = "D";
  } else if (warnCount >= 2) {
    grade = "C";
  } else if (warnCount === 1) {
    grade = "B";
  } else {
    grade = "A";
  }

  return { grade, flags, rawText };
}

// ---------------------------------------------------------------------------
// 3. Intent Scoring & Unified Developer Score
// ---------------------------------------------------------------------------

/**
 * Converts a website grade letter to a numeric risk contribution (0–100).
 */
function gradeToRisk(
  grade: OffChainIntelligenceResult["websiteAuthenticityGrade"],
): number {
  switch (grade) {
    case "A":
      return 0;
    case "B":
      return 15;
    case "C":
      return 35;
    case "D":
      return 60;
    case "F":
      return 85;
    default:
      return 30; // unavailable → slight penalty
  }
}

/**
 * Combines hype score, website authenticity, and existing on-chain developer
 * trust score into a single intent score (0–100, higher = more suspicious)
 * and a unified developer risk score for the scoring engine.
 *
 * Rule: "Safe on-chain code does not override dangerous off-chain behavior."
 * The off-chain penalty is additive and cannot be cancelled by clean on-chain
 * metrics alone.
 */
export function buildIntentScore(
  hypeScore: number,
  websiteGrade: OffChainIntelligenceResult["websiteAuthenticityGrade"],
  onChainDevTrustScore: number, // 0–100, higher = more trustworthy (existing field)
): {
  intentScore: number;
  intentVerdict: OffChainIntelligenceResult["intentVerdict"];
  unifiedDevScore: number;
} {
  const websiteRisk = gradeToRisk(websiteGrade);

  // Intent score: blend hype risk + website risk.
  // Website is more diagnostic than social noise, so weight it higher.
  const rawIntent = hypeScore * 0.4 + websiteRisk * 0.6;
  const intentScore = Math.max(0, Math.min(100, Math.round(rawIntent)));

  const intentVerdict: OffChainIntelligenceResult["intentVerdict"] =
    intentScore >= 70
      ? "likely_scam"
      : intentScore >= 45
        ? "suspicious"
        : intentScore >= 20
          ? "genuine"
          : "genuine";

  // Unified dev score: existing on-chain dev risk + off-chain intent penalty.
  // On-chain dev risk = 100 - onChainDevTrustScore.
  const onChainDevRisk = 100 - onChainDevTrustScore;
  // Off-chain penalty: proportional to intent score, capped at 40 pts.
  const offChainPenalty = Math.min(40, intentScore * 0.4);
  // The penalty is added directly — clean on-chain cannot nullify off-chain risk.
  const unifiedDevScore = Math.max(
    0,
    Math.min(100, Math.round(onChainDevRisk * 0.7 + offChainPenalty)),
  );

  return { intentScore, intentVerdict, unifiedDevScore };
}

// ---------------------------------------------------------------------------
// Orchestrator: run all three passes and return consolidated result
// ---------------------------------------------------------------------------

export async function runOffChainIntelligence(
  socials: { type: string; url: string }[],
  websites: { label: string; url: string }[],
  onChainDevTrustScore: number,
): Promise<OffChainIntelligenceResult> {
  // Pick the first listed website for the audit.
  const primaryWebsiteUrl =
    websites.find((w) => /https?:\/\//i.test(w.url))?.url ?? null;

  // Run website audit first (we pass its text to the hype scorer too).
  const { grade, flags: websiteFlags, rawText } = primaryWebsiteUrl
    ? await auditWebsite(primaryWebsiteUrl)
    : { grade: "unavailable" as const, flags: [], rawText: "" };

  // Run hype scoring, enriched with website copy.
  const { hypeScore, hypeVerdict, hypeSignals } = await fetchHypeScore(
    socials,
    rawText || undefined,
  );

  // Build intent + unified dev score.
  const { intentScore, intentVerdict, unifiedDevScore } = buildIntentScore(
    hypeScore,
    grade,
    onChainDevTrustScore,
  );

  return {
    available: true,
    hypeScore,
    hypeVerdict,
    hypeSignals,
    websiteAuthenticityGrade: grade,
    websiteFlags,
    intentScore,
    intentVerdict,
    unifiedDevScore,
  };
}
