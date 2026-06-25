import { createAPIFileRoute } from "@tanstack/react-start/api";

export const APIRoute = createAPIFileRoute("/api/test")({
  POST: async () => {
    return new Response(JSON.stringify({ ok: true, route: "/api/test", method: "POST" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
  GET: async () => {
    return new Response(JSON.stringify({ ok: true, route: "/api/test", method: "GET" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
