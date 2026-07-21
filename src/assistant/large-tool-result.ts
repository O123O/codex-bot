import { Buffer } from "node:buffer";

const MAX_INLINE_WORDS = 1_000;
const MAX_INLINE_BYTES = 16 * 1_024;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export interface LargeToolResultFile {
  storage: "file";
  path: string;
  format: "json";
  warning: string;
  wordCount: number;
  inlineByteCount: number;
  [key: string]: unknown;
}

export async function boundLargeToolResult<T>(
  value: T,
  options: {
    writeResultFile(value: unknown): Promise<string>;
    wordSources?: Iterable<string>;
    metadata?: Record<string, unknown>;
  },
): Promise<T | LargeToolResultFile> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("tool result is not JSON serializable");
  const wordCount = countWords(options.wordSources ?? stringValues(value));
  const inlineByteCount = Buffer.byteLength(serialized, "utf8");
  if (wordCount <= MAX_INLINE_WORDS && inlineByteCount <= MAX_INLINE_BYTES) return value;
  const path = await options.writeResultFile(value);
  return {
    ...(options.metadata ?? {}),
    storage: "file",
    path,
    format: "json",
    warning: "Large result exceeded the inline safety limits and was saved to an owner-only temporary JSON file. Read or query the file at path instead of repeating the tool call.",
    wordCount,
    inlineByteCount,
  };
}

function countWords(values: Iterable<string>): number {
  let count = 0;
  for (const value of values) {
    for (const segment of wordSegmenter.segment(value)) if (segment.isWordLike) count += 1;
  }
  return count;
}

function* stringValues(value: unknown): Iterable<string> {
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* stringValues(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) yield* stringValues(item);
  }
}
