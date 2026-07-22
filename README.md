# ─── Railway service config for the Copy-Trade Bot ───────────────────────────
# In Railway, create a NEW SERVICE inside your existing project,
# set its root directory to "bot/", and Railway will use this file.

[build]
builder = "NIXPACKS"
buildCommand = "bun install"

[deploy]
startCommand = "bun index.ts"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 5

# Health check is not needed for a background bot (no HTTP server)
# Railway will keep it running as a worker process.
