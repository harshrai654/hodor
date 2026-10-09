import { type Context, type Span } from "@opentelemetry/api";

interface OpenTool {
  name: string;
  span: Span;
  context: Context;
}

const openTools: OpenTool[] = [];

export function pushOpenTool(tool: OpenTool): void {
  openTools.push(tool);
}

export function popOpenTool(span: Span): void {
  const index = openTools.findIndex((tool) => tool.span === span);
  if (index >= 0) openTools.splice(index, 1);
}

export function latestOpenTool(name?: string): OpenTool | undefined {
  for (let index = openTools.length - 1; index >= 0; index -= 1) {
    const tool = openTools[index];
    if (!name || tool?.name === name) return tool;
  }
  return undefined;
}

export function resetOpenToolsForTests(): void {
  openTools.length = 0;
}
