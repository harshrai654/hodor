import { compress } from "snappyjs";
import { registry } from "./metrics.js";

export interface TimeSeries {
  labels: Array<{ name: string; value: string }>;
  value: number;
  timestampMs: number;
}

const REMOTE_WRITE_HEADERS = {
  "Content-Type": "application/x-protobuf",
  "Content-Encoding": "snappy",
  "X-Prometheus-Remote-Write-Version": "0.1.0",
};

export async function pushMetrics(opts?: {
  url?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<void> {
  const url = opts?.url ?? process.env.HODOR_METRICS_REMOTE_WRITE_URL?.trim();
  if (!url) return;

  const metrics = await registry.getMetricsAsJSON();
  const series = metricsToTimeSeries(metrics, opts?.now ?? Date.now());
  if (series.length === 0) return;

  const body = compress(encodeWriteRequest(series));
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: REMOTE_WRITE_HEADERS,
    body,
  });
  if (!response.ok) {
    throw new Error(
      `metrics remote write failed: ${response.status} ${response.statusText}`,
    );
  }
}

export function metricsToTimeSeries(
  metrics: Awaited<ReturnType<typeof registry.getMetricsAsJSON>>,
  timestampMs: number,
): TimeSeries[] {
  const series: TimeSeries[] = [];
  for (const metric of metrics) {
    for (const sample of metric.values) {
      const metricName =
        "metricName" in sample && typeof sample.metricName === "string"
          ? sample.metricName
          : sample.labels.le !== undefined
            ? `${metric.name}_bucket`
            : metric.name;
      const labels = Object.entries(sample.labels)
        .filter((entry): entry is [string, string | number] => {
          const value = entry[1];
          return value !== undefined && value !== "";
        })
        .map(([name, value]) => ({ name, value: String(value) }));
      labels.push({ name: "__name__", value: metricName });
      labels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      series.push({ labels, value: sample.value, timestampMs });
    }
  }
  return series;
}

export function encodeWriteRequest(series: TimeSeries[]): Uint8Array {
  return concat(series.map((item) => encodeLenDelim(1, encodeTimeSeries(item))));
}

function encodeTimeSeries(series: TimeSeries): Uint8Array {
  const parts = series.labels.map((label) =>
    encodeLenDelim(
      1,
      concat([encodeString(1, label.name), encodeString(2, label.value)]),
    ),
  );
  parts.push(
    encodeLenDelim(
      2,
      concat([encodeDouble(1, series.value), encodeVarintField(2, series.timestampMs)]),
    ),
  );
  return concat(parts);
}

function encodeString(field: number, value: string): Uint8Array {
  return encodeLenDelim(field, new TextEncoder().encode(value));
}

function encodeDouble(field: number, value: number): Uint8Array {
  const key = encodeVarint((field << 3) | 1);
  const out = new Uint8Array(key.length + 8);
  out.set(key, 0);
  new DataView(out.buffer).setFloat64(key.length, value, true);
  return out;
}

function encodeVarintField(field: number, value: number): Uint8Array {
  const key = encodeVarint(field << 3);
  const body = encodeVarint(value);
  const out = new Uint8Array(key.length + body.length);
  out.set(key, 0);
  out.set(body, key.length);
  return out;
}

function encodeLenDelim(field: number, data: Uint8Array): Uint8Array {
  const key = encodeVarint((field << 3) | 2);
  const len = encodeVarint(data.length);
  return concat([key, len, data]);
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
