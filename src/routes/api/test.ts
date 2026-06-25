import { createAPIFileRoute } from "@tanstack/react-start/api";

export const APIRoute = createAPIFileRoute("/api/test")({
  GET: async () => {
    return new Response(JSON.stringify({ ok: true, route: "/api/test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
  POST: async () => {
    return new Response(JSON.stringify({ ok: true, route: "/api/test", method: "POST" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
