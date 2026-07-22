const API_PREFIX = "/api/";

function isEnabled(value: string): boolean {
  return value === "true";
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");

  return new Response(JSON.stringify(data), { ...init, headers });
}

function handleApiRequest(request: Request, env: Env): Response {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    return json({
      ok: true,
      environment: env.ENVIRONMENT,
      features: {
        publicJobs: isEnabled(env.FEATURE_PUBLIC_JOBS),
        publicSwarm: isEnabled(env.FEATURE_PUBLIC_SWARM),
      },
    });
  }

  return json(
    { error: { code: "NOT_FOUND", message: "API route not found" } },
    { status: 404 },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(API_PREFIX)) {
      const response = handleApiRequest(request, env);
      console.log(JSON.stringify({
        event: "api.request",
        method: request.method,
        path: url.pathname,
        status: response.status,
      }));
      return response;
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
