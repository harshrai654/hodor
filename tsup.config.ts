import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  // Keep native/gRPC telemetry packages external so the Bun/Node runtime
  // loads them from node_modules instead of a bundle.
  external: [
    /^@opentelemetry\//,
    /^@grpc\//,
    "prom-client",
    "snappyjs",
  ],
});
