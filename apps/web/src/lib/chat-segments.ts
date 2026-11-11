type RenderItem<T extends { kind: string }> =
  | { kind: "single"; segment: Exclude<T, { kind: "tool" }> }
  | { kind: "tool-group"; items: Extract<T, { kind: "tool" }>[] };

/** Thinking and output always separate groups of consecutive tool calls. */
export function groupSegments<T extends { kind: string }>(segments: readonly T[]): RenderItem<T>[] {
  const items: RenderItem<T>[] = [];
  for (const segment of segments) {
    if (segment.kind === "tool") {
      const tool = segment as Extract<T, { kind: "tool" }>;
      const last = items.at(-1);
      if (last?.kind === "tool-group") last.items.push(tool);
      else items.push({ kind: "tool-group", items: [tool] });
    } else {
      items.push({ kind: "single", segment: segment as Exclude<T, { kind: "tool" }> });
    }
  }
  return items;
}
