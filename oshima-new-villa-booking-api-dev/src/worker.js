import { ALLOWED_ORIGINS } from "./config.js";
import { getCorsHeaders, jsonError } from "./lib/http.js";
import { handleStripeRoutes } from "./routes/stripe.js";
import { handleWebhookRoutes } from "./routes/webhook.js";
import { handlePublicRoutes } from "./routes/public.js";
import { handleBookingRoutes } from "./routes/booking.js";
import { handleAdminRoutes } from "./routes/admin.js";
import { handleScheduled } from "./scheduled.js";

const ROUTE_HANDLERS = [
  handleStripeRoutes,
  handleWebhookRoutes,
  handlePublicRoutes,
  handleBookingRoutes,
  handleAdminRoutes,
];

export default {
  async fetch(request, env) {
    /* Browser CORS preflight */
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");

      if (!origin || !ALLOWED_ORIGINS.has(origin)) {
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request),
      });
    }

    const url = new URL(request.url);

    /* API動作確認 */
    if (url.pathname === "/") {
      return Response.json({
        ok: true,
        service: "oshima-new-villa-booking-api-dev",
      });
    }

    for (const handler of ROUTE_HANDLERS) {
      const response = await handler(request, env, url);
      if (response) return response;
    }

    return jsonError("not_found", 404);
  },

  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  },
};
