import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { logger } from "../utils/logger.js";
import { PiInstrumentation } from "./instrumentation-pi.js";
import { pushMetrics } from "./remote-write.js";

let sdk: NodeSDK | undefined;
let started = false;

export function observabilityEnabled(): boolean {
  if (process.env.OTEL_SDK_DISABLED === "true") return false;
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());
}

export function grpcEndpoint(raw: string): string {
  const url = new URL(raw);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function startObservability(): void {
  if (started) return;
  started = true;
  if (!observabilityEnabled()) return;

  const endpoint = grpcEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT!.trim());
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME?.trim() || "hodor",
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
      }),
      new PiInstrumentation(),
    ],
  });
  sdk.start();
  logger.info(`OpenTelemetry traces -> ${endpoint}`);
}

export async function finishObservability(): Promise<void> {
  try {
    await pushMetrics();
  } catch (err) {
    logger.warn(
      `metrics push failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (err) {
    logger.warn(
      `trace shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
