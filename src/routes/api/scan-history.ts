// =============================================================================
// /api/scan-history — server-validated write path for scan_history
//
// Added as part of the audit finding #4 fix: scan_history previously allowed
// open INSERT from anon/authenticated with no server-side validation. The
// frontend now POSTs scan results here instead of inserting directly with
// the anon key; see src/lib/api/scan-history-handler.ts for the validation
// logic and src/lib/scan-history.ts for the client call site.
//
// Same dual-registration pattern as every other route in this project:
// this TanStack APIRoute handles local dev, while the direct handler wired
// into src/server.ts (handleScanHistoryPost/Get) handles Railway, because
// @lovable.dev/vite-tanstack-config does not register APIRoute exports as
// server-side handlers on the node-server Nitro preset.
// =============================================================================

import { createAPIFileRoute } from "@tanstack/react-start/api";
import { handleScanHistoryPost, handleScanHistoryGet } from "@/lib/api/scan-history-handler";

export const APIRoute = createAPIFileRoute("/api/scan-history")({
  POST: async ({ request }) => handleScanHistoryPost(request),
  GET: async () => handleScanHistoryGet(),
});
