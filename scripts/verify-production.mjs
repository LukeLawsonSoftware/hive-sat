const productionUrl = process.env.HIVESAT_PRODUCTION_URL;

if (!productionUrl) {
  throw new Error("HIVESAT_PRODUCTION_URL is required for the production smoke test");
}

const response = await fetch(new URL("/api/v1/health", productionUrl));
if (!response.ok) {
  throw new Error(`Production health check failed with HTTP ${response.status}`);
}

const health = await response.json();
if (
  health?.ok !== true
  || health?.environment !== "production"
  || health?.features?.publicJobs !== false
  || health?.features?.publicSwarm !== false
) {
  throw new Error(`Unexpected production health response: ${JSON.stringify(health)}`);
}

console.log(JSON.stringify({ event: "production.smoke_test", ok: true }));
