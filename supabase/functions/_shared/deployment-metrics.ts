// Enhanced observability - metrics and error tracking
// Integrates with existing observability.ts

export interface DeploymentMetrics {
  deploymentId: string;
  startTime: string;
  endTime?: string;
  status: "in_progress" | "success" | "failed" | "rolled_back";
  duration?: number;
  changedComponents: string[];
  errorRate?: number;
  p95Latency?: number;
}

const metrics: DeploymentMetrics[] = [];

export function startDeploymentTracking(components: string[]): string {
  const deploymentId = `deploy_${Date.now()}`;
  metrics.push({
    deploymentId,
    startTime: new Date().toISOString(),
    status: "in_progress",
    changedComponents: components,
  });
  return deploymentId;
}

export function endDeploymentTracking(
  deploymentId: string,
  status: "success" | "failed" | "rolled_back",
  errorRate?: number,
  p95Latency?: number,
) {
  const metric = metrics.find((m) => m.deploymentId === deploymentId);
  if (!metric) return;

  metric.endTime = new Date().toISOString();
  metric.status = status;
  metric.duration = Date.now() - new Date(metric.startTime).getTime();
  metric.errorRate = errorRate;
  metric.p95Latency = p95Latency;

  // Send to monitoring (Telegram, Datadog, etc.)
  console.log(JSON.stringify(metric));
}

export function getRecentDeployments(limit = 10): DeploymentMetrics[] {
  return metrics.slice(-limit);
}
