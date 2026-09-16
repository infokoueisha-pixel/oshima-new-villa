import { ALLOWED_ORIGINS } from "../config.js";

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin");

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
  "Content-Type, Idempotency-Key, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };

  if (
    origin &&
    ALLOWED_ORIGINS.has(origin)
  ) {
    headers["Access-Control-Allow-Origin"] =
      origin;
  }

  return headers;
}

function withCors(response, request) {
  const headers = new Headers(
    response.headers
  );

  const corsHeaders =
    getCorsHeaders(request);

  for (
    const [key, value] of
      Object.entries(corsHeaders)
  ) {
    headers.set(key, value);
  }

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    }
  );
}

function jsonError(error, status = 400, extra = {}) {
  return Response.json(
    {
      ok: false,
      error,
      ...extra,
    },
    { status }
  );
}

export { getCorsHeaders, withCors, jsonError };
