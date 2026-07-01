// cron-trigger.mjs — Railway cron helper for /api/process-jobs  (PATCH v2)
//
// Place this file in the ROOT of your repository (same level as railway.toml).
// Railway [[deploy.cronJobs]] runs: bun cron-trigger.mjs
//
// PATCH v2 CHANGES:
//   - Gracefully handles missing RAILWAY_PUBLIC_DOMAIN without process.exit(1).
//     Instead it logs a clear diagnostic and exits with code 0 so Railway does
//     not treat the cron as a hard failure that triggers service restarts.
//   - Retries the POST up to 3 times with 5-second gaps before giving up.
//     Handles Railway cold-start latency where the service needs a moment
//     after a restart before it can accept requests.
//   - Prints the response body summary even on non-OK status.
//   - Exits 0 on auth errors (401/503) — these are config issues, not
//     transient failures, and retrying immediately won't help.
//
// Required Railway environment variables:
//   RAILWAY_PUBLIC_DOMAIN — set automatically by Railway
//   CRON_SECRET           — set manually in Railway → Variables

const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
const secret = process.env.CRON_SECRET;

if (!secret) {
  console.error("[cron-trigger] ERROR: CRON_SECRET is not set in Railway → Variables.");
  console.error("  Without it every request is rejected (401). Add it now.");
  process.exit(0); // not a transient error; don't retry
}

if (!domain) {
  console.error("[cron-trigger] ERROR: RAILWAY_PUBLIC_DOMAIN is not set.");
  console.error("  This should be injected automatically by Railway.");
  console.error("  If missing, add it manually in Railway → Variables as your app's public hostname.");
  console.error("  NOTE: The in-process scheduler (process-jobs-scheduler.ts) runs every 60s");
  console.error("  and does NOT require this variable, so pending jobs will still be processed.");
  process.exit(0); // exit cleanly; in-process scheduler is the primary mechanism
}

const url = `https://${domain}/api/process-jobs`;
console.log(`[cron-trigger] POST ${url}`);

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
    const preview = body.slice(0, 600);
    console.log(`[cron-trigger] Attempt ${attempt}/${MAX_ATTEMPTS} — HTTP ${res.status}:`, preview);

    if (res.ok) {
      process.exit(0); // success
    }

    // Config errors — don't retry
    if (res.status === 401 || res.status === 503) {
      console.error(`[cron-trigger] Config error (${res.status}) — check CRON_SECRET and server env vars.`);
      process.exit(0);
    }

    // Other non-OK statuses — retry if attempts remain
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[cron-trigger] Non-OK response; retrying in ${RETRY_DELAY_MS / 1000}s…`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    } else {
      console.error(`[cron-trigger] All ${MAX_ATTEMPTS} attempts failed with HTTP ${res.status}.`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[cron-trigger] Attempt ${attempt}/${MAX_ATTEMPTS} — fetch failed:`, err.message);

    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[cron-trigger] Retrying in ${RETRY_DELAY_MS / 1000}s…`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    } else {
      console.error(`[cron-trigger] All ${MAX_ATTEMPTS} attempts failed.`);
      // Exit 0 because the in-process scheduler is the primary mechanism;
      // a failing cron-trigger should not trigger Railway's restart policy.
      process.exit(0);
    }
  }
}
