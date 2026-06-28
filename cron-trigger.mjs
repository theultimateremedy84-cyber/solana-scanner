// cron-trigger.mjs — Railway cron helper for /api/process-jobs
//
// Place this file in the ROOT of your repository (same level as railway.toml).
// Railway's [[deploy.cronJobs]] command runs: bun cron-trigger.mjs
//
// Required Railway environment variables:
//   RAILWAY_PUBLIC_DOMAIN — set automatically by Railway (your app's public hostname)
//   CRON_SECRET           — set manually in Railway → Variables

const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
const secret = process.env.CRON_SECRET;

if (!domain) {
  console.error("[cron-trigger] ERROR: RAILWAY_PUBLIC_DOMAIN is not set.");
  console.error("  This variable is set automatically by Railway. If missing,");
  console.error("  set it manually in Railway → Variables as your app domain.");
  process.exit(1);
}

if (!secret) {
  console.error("[cron-trigger] ERROR: CRON_SECRET is not set.");
  console.error("  Set CRON_SECRET in Railway → Variables.");
  process.exit(1);
}

const url = `https://${domain}/api/process-jobs`;

console.log(`[cron-trigger] POST ${url}`);

try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-cron-secret": secret,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(55_000),
  });

  const body = await res.text();
  console.log(`[cron-trigger] Response ${res.status}:`, body.slice(0, 500));

  if (!res.ok) {
    console.error(`[cron-trigger] Non-OK status ${res.status} — check Railway logs`);
    process.exit(1);
  }
} catch (err) {
  console.error("[cron-trigger] fetch failed:", err.message);
  process.exit(1);
}
