import { createApiHandler } from "../_shared/api-handler.ts";
import { getRecentDeployments } from "../_shared/deployment-metrics.ts";
import { formatPrometheusMetrics } from "../_shared/observability.ts";

const handler = createApiHandler({
  serviceName: "metrics",
  requireAuth: false,
});

handler.get("/health", async () => {
  return { status: "healthy", timestamp: new Date().toISOString() };
});

handler.get("/deployments", async () => {
  return { deployments: getRecentDeployments(20) };
});

handler.get("/prometheus", async () => {
  const metrics = formatPrometheusMetrics();
  return new Response(metrics, {
    headers: { "Content-Type": "text/plain" },
  });
});

Deno.serve(handler.serve());
