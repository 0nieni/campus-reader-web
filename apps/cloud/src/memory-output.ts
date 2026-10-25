import type { MemoryProposal } from './assistant-memory';

/** Metadata never escapes into rendered answers, exports, or future history. */
export function memoryOutput(response: string): { answer: string; proposals: MemoryProposal[] } {
  const markers = [...response.matchAll(/<!--\s*campus-memory\b/gi)];
  const start = markers[0]?.index;
  if (start === undefined) return { answer: response, proposals: [] };
  const answer = response.slice(0, start).trim();
  const envelope = response.slice(start);
  const match = /^<!--campus-memory\s+([\s\S]*?)\s*-->\s*$/.exec(envelope);
  if (!match || envelope.length > 2200 || markers.length !== 1) return { answer, proposals: [] };
  try {
    const value = JSON.parse(match[1]!);
    return { answer, proposals: value && Array.isArray(value.items) && value.items.length <= 2 ? value.items : [] };
  } catch { return { answer, proposals: [] }; }
}
