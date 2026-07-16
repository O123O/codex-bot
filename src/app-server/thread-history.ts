import { Buffer } from "node:buffer";
import { AppError } from "../core/errors.ts";
import { isExactThreadItemsUnsupported, isExactThreadTurnsNotMaterialized } from "./thread-errors.ts";

export type ThreadItemsView = "full" | "summary" | "notLoaded";

export interface ThreadHistoryItem {
  type: string;
  id: string;
  clientId?: string | null;
  text?: string;
  phase?: string | null;
  [key: string]: unknown;
}

export interface ThreadHistoryTurn {
  id: string;
  status: string;
  itemsView: ThreadItemsView;
  items: ThreadHistoryItem[];
  startedAt?: number | null;
  completedAt?: number | null;
  [key: string]: unknown;
}

export interface ThreadHistoryPage<T> {
  data: T[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

type HistoryRequest = (method: string, params: unknown) => Promise<unknown>;

export interface ExactTurnItems {
  items: ThreadHistoryItem[];
  firstUserMessage?: ThreadHistoryItem;
  complete: boolean;
  summaryTurn?: ThreadHistoryTurn;
}

export class ThreadHistoryReader {
  private readonly legacyThreads = new Map<string, Promise<ThreadHistoryTurn[]>>();

  constructor(private readonly request: HistoryRequest) {}

  async latestTurn(threadId: string): Promise<ThreadHistoryTurn | undefined> {
    const page = await this.turnsPage(threadId, {
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    return page.data[0];
  }

  async turnsPage(
    threadId: string,
    params: { cursor?: string; limit: number; sortDirection: "asc" | "desc"; itemsView: ThreadItemsView },
  ): Promise<ThreadHistoryPage<ThreadHistoryTurn>> {
    try {
      const page = turnPage(await this.request("thread/turns/list", { threadId, ...params }));
      validateSinglePage(page, params.cursor, "turn");
      return page;
    } catch (error) {
      if (isClaudePagingUnsupported(error)) return this.legacyTurnsPage(threadId, params);
      if (!isExactThreadTurnsNotMaterialized(error, threadId)) throw error;
      return { data: [], nextCursor: null, backwardsCursor: null };
    }
  }

  async allTurns(
    threadId: string,
    options: { sortDirection?: "asc" | "desc"; itemsView?: ThreadItemsView } = {},
  ): Promise<ThreadHistoryTurn[]> {
    const turns: ThreadHistoryTurn[] = [];
    await this.walkTurns(threadId, {
      sortDirection: options.sortDirection ?? "asc",
      itemsView: options.itemsView ?? "notLoaded",
      onTurn: (turn) => { turns.push(turn); return false; },
    });
    return turns;
  }

  async findTurn(threadId: string, turnId: string): Promise<ThreadHistoryTurn | undefined> {
    let found: ThreadHistoryTurn | undefined;
    await this.walkTurns(threadId, {
      sortDirection: "desc",
      itemsView: "notLoaded",
      onTurn: (turn) => {
        if (turn.id !== turnId) return false;
        found = turn;
        return true;
      },
    });
    return found;
  }

  async descendingSuffix(
    threadId: string,
    anchorTurnId?: string,
  ): Promise<{ turns: ThreadHistoryTurn[]; anchorFound: boolean; exhausted: boolean }> {
    const buffered: ThreadHistoryTurn[] = [];
    let anchorFound = anchorTurnId === undefined;
    const scan = await this.walkTurns(threadId, {
      sortDirection: "desc",
      itemsView: "notLoaded",
      onTurn: (turn) => {
        if (turn.id === anchorTurnId) {
          anchorFound = true;
          return true;
        }
        buffered.push(turn);
        return false;
      },
    });
    return {
      turns: anchorFound ? buffered : [],
      anchorFound,
      exhausted: scan.exhausted,
    };
  }

  async classifyTurnAgainstAnchor(
    threadId: string,
    targetTurnId: string,
    anchorTurnId: string,
  ): Promise<"newer" | "anchor" | "older" | "missing"> {
    if (targetTurnId === anchorTurnId) return "anchor";
    let anchorSeen = false;
    let result: "newer" | "older" | undefined;
    await this.walkTurns(threadId, {
      sortDirection: "desc",
      itemsView: "notLoaded",
      onTurn: (turn) => {
        if (turn.id === anchorTurnId) {
          anchorSeen = true;
          return false;
        }
        if (turn.id !== targetTurnId) return false;
        result = anchorSeen ? "older" : "newer";
        return true;
      },
    });
    if (!anchorSeen && result !== "newer") throw uncertain("thread history anchor is absent");
    return result ?? "missing";
  }

  async exactTurnItems(
    threadId: string,
    turnId: string,
    options: { allowLegacySummary?: boolean } = {},
  ): Promise<ExactTurnItems> {
    try {
      return exactItems(await this.pagedItems(threadId, turnId), true);
    } catch (error) {
      if (!isExactThreadItemsUnsupported(error)) throw error;
      if (!options.allowLegacySummary) {
        throw uncertain("exact thread items are unavailable for this legacy session");
      }
      const summaryTurn = await this.exactSummaryTurn(threadId, turnId);
      if (!summaryTurn) throw uncertain("the exact legacy turn is absent from authoritative history");
      return { ...exactItems(summaryTurn.items, false), summaryTurn };
    }
  }

  async itemsPage(
    threadId: string,
    params: { turnId?: string; cursor?: string; limit: number; sortDirection: "asc" | "desc" },
  ): Promise<ThreadHistoryPage<ThreadHistoryItem>> {
    try {
      const page = itemPage(await this.request("thread/items/list", { threadId, ...params }));
      validateSinglePage(page, params.cursor, "item");
      return page;
    } catch (error) {
      if (!isClaudePagingUnsupported(error)) throw error;
      return this.legacyItemsPage(threadId, params);
    }
  }

  private async exactSummaryTurn(threadId: string, turnId: string): Promise<ThreadHistoryTurn | undefined> {
    let found: ThreadHistoryTurn | undefined;
    await this.walkTurns(threadId, {
      sortDirection: "desc",
      itemsView: "summary",
      pageLimit: 1,
      onTurn: (turn) => {
        if (turn.id !== turnId) return false;
        found = turn;
        return true;
      },
    });
    return found;
  }

  private async pagedItems(threadId: string, turnId?: string): Promise<ThreadHistoryItem[]> {
    const items: ThreadHistoryItem[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursor !== undefined && !rememberCursor(seenCursors, cursor)) throw uncertain("thread item pagination repeated a cursor");
      const page = await this.itemsPage(threadId, {
        ...(turnId === undefined ? {} : { turnId }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: 16,
        sortDirection: "asc",
      });
      validatePageProgress(page, cursor);
      for (const item of page.data) {
        if (!rememberId(seenIds, item.id)) throw uncertain("thread item pagination repeated an item");
        items.push(item);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return items;
  }

  private async legacyThread(threadId: string): Promise<ThreadHistoryTurn[]> {
    let cached = this.legacyThreads.get(threadId);
    if (!cached) {
      cached = (async () => {
        // Claude exposes only its reconstructed transcript. Keep this full read scoped to one
        // operation-local reader; it is discarded when the caller's recovery operation ends.
        const response = await this.request("thread/read", { threadId, includeTurns: true });
        if (!record(response) || !record(response.thread) || !Array.isArray(response.thread.turns)) {
          throw uncertain("legacy thread history returned an invalid response");
        }
        const turns = response.thread.turns.map(historyTurn);
        if (turns.some((turn) => turn.itemsView !== "full")) {
          throw uncertain("legacy thread history is not a full item view");
        }
        return turns;
      })();
      this.legacyThreads.set(threadId, cached);
    }
    return cached;
  }

  private async legacyTurnsPage(
    threadId: string,
    params: { cursor?: string; limit: number; sortDirection: "asc" | "desc"; itemsView: ThreadItemsView },
  ): Promise<ThreadHistoryPage<ThreadHistoryTurn>> {
    const scope = { kind: "turns" as const, threadId, direction: params.sortDirection };
    const offset = legacyCursorOffset(params.cursor, scope);
    const turns = [...await this.legacyThread(threadId)];
    if (params.sortDirection === "desc") turns.reverse();
    const data = turns.slice(offset, offset + params.limit).map((turn) => projectLegacyTurn(turn, params.itemsView));
    return legacyPage(data, offset, turns.length, params.limit, scope);
  }

  private async legacyItemsPage(
    threadId: string,
    params: { turnId?: string; cursor?: string; limit: number; sortDirection: "asc" | "desc" },
  ): Promise<ThreadHistoryPage<ThreadHistoryItem>> {
    const scope = {
      kind: "items" as const, threadId, direction: params.sortDirection,
      ...(params.turnId === undefined ? {} : { turnId: params.turnId }),
    };
    const offset = legacyCursorOffset(params.cursor, scope);
    const turns = await this.legacyThread(threadId);
    const items = params.turnId === undefined
      ? turns.flatMap((turn) => turn.items)
      : turns.find((turn) => turn.id === params.turnId)?.items ?? [];
    const ordered = params.sortDirection === "desc" ? [...items].reverse() : [...items];
    return legacyPage(ordered.slice(offset, offset + params.limit), offset, ordered.length, params.limit, scope);
  }

  private async walkTurns(
    threadId: string,
    options: {
      sortDirection: "asc" | "desc";
      itemsView: ThreadItemsView;
      pageLimit?: number;
      onTurn(turn: ThreadHistoryTurn): boolean;
    },
  ): Promise<{ exhausted: boolean }> {
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursor !== undefined && !rememberCursor(seenCursors, cursor)) throw uncertain("thread turn pagination repeated a cursor");
      const page = await this.turnsPage(threadId, {
        ...(cursor === undefined ? {} : { cursor }),
        limit: options.pageLimit ?? 128,
        sortDirection: options.sortDirection,
        itemsView: options.itemsView,
      });
      validatePageProgress(page, cursor);
      for (const turn of page.data) {
        if (!rememberId(seenIds, turn.id)) throw uncertain("thread turn pagination repeated a turn");
        if (options.onTurn(turn)) return { exhausted: page.nextCursor === null };
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return { exhausted: true };
  }

}

function exactItems(items: ThreadHistoryItem[], complete: boolean): ExactTurnItems {
  const firstUserMessage = items.find((item) => item.type === "userMessage");
  return { items, ...(firstUserMessage ? { firstUserMessage } : {}), complete };
}

function turnPage(value: unknown): ThreadHistoryPage<ThreadHistoryTurn> {
  const page = basePage(value);
  return { ...page, data: page.data.map((turn) => historyTurn(turn)) };
}

function itemPage(value: unknown): ThreadHistoryPage<ThreadHistoryItem> {
  const page = basePage(value);
  return { ...page, data: page.data.map((item) => historyItem(item)) };
}

function basePage(value: unknown): ThreadHistoryPage<unknown> {
  if (!record(value) || !Array.isArray(value.data)) throw uncertain("thread history returned an invalid page");
  const nextCursor = nullableCursor(value.nextCursor);
  const backwardsCursor = nullableCursor(value.backwardsCursor);
  return { data: value.data, nextCursor, backwardsCursor };
}

function historyTurn(value: unknown): ThreadHistoryTurn {
  if (!record(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.status !== "string") {
    throw uncertain("thread history returned an invalid turn");
  }
  const itemsView = value.itemsView;
  if (itemsView !== "full" && itemsView !== "summary" && itemsView !== "notLoaded") {
    throw uncertain("thread history returned an invalid item projection");
  }
  if (!Array.isArray(value.items)) throw uncertain("thread history returned invalid turn items");
  return { ...value, id: value.id, status: value.status, itemsView, items: value.items.map(historyItem) } as ThreadHistoryTurn;
}

function historyItem(value: unknown): ThreadHistoryItem {
  if (!record(value) || typeof value.type !== "string" || typeof value.id !== "string" || value.id.length === 0) {
    throw uncertain("thread history returned an invalid item");
  }
  return value as ThreadHistoryItem;
}

function nullableCursor(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw uncertain("thread history returned an invalid cursor");
  return value;
}

function validatePageProgress(page: ThreadHistoryPage<unknown>, requestCursor: string | undefined): void {
  if (page.data.length === 0 && page.nextCursor !== null) throw uncertain("empty thread history page had a continuation cursor");
  if (requestCursor !== undefined && page.nextCursor === requestCursor) throw uncertain("thread history cursor did not advance");
}

function validateSinglePage(
  page: ThreadHistoryPage<{ id: string }>,
  requestCursor: string | undefined,
  kind: "turn" | "item",
): void {
  validatePageProgress(page, requestCursor);
  const ids = new Set<string>();
  for (const value of page.data) {
    if (!rememberId(ids, value.id)) throw uncertain(`thread ${kind} page repeated a ${kind}`);
  }
}

function rememberCursor(seen: Set<string>, value: string): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  return true;
}

function rememberId(seen: Set<string>, value: string): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  return true;
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uncertain(message: string): AppError {
  return new AppError("OPERATION_UNCERTAIN", message);
}

type LegacyCursorScope = {
  kind: "turns" | "items";
  threadId: string;
  direction: "asc" | "desc";
  turnId?: string;
};

function isClaudePagingUnsupported(error: unknown): boolean {
  return error instanceof AppError && error.code === "UNSUPPORTED_CAPABILITY";
}

function projectLegacyTurn(turn: ThreadHistoryTurn, view: ThreadItemsView): ThreadHistoryTurn {
  if (view === "full") return turn;
  if (view === "notLoaded") return { ...turn, itemsView: "notLoaded", items: [] };
  const firstUser = turn.items.find((item) => item.type === "userMessage");
  const lastAgent = [...turn.items].reverse().find((item) => item.type === "agentMessage");
  return {
    ...turn,
    itemsView: "summary",
    items: [firstUser, lastAgent].filter((item): item is ThreadHistoryItem => item !== undefined),
  };
}

function legacyPage<T>(
  data: T[],
  offset: number,
  total: number,
  limit: number,
  scope: LegacyCursorScope,
): ThreadHistoryPage<T> {
  return {
    data,
    nextCursor: offset + data.length < total
      ? encodeLegacyCursor({ ...scope, offset: offset + data.length })
      : null,
    backwardsCursor: offset === 0 || data.length === 0
      ? null
      : encodeLegacyCursor({ ...scope, direction: scope.direction === "asc" ? "desc" : "asc", offset: Math.max(0, total - offset - Math.min(limit, data.length)) }),
  };
}

function encodeLegacyCursor(value: LegacyCursorScope & { offset: number }): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
}

function legacyCursorOffset(value: string | undefined, expected: LegacyCursorScope): number {
  if (value === undefined) return 0;
  if (!value || value.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw uncertain("legacy thread history cursor is invalid");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw uncertain("legacy thread history cursor is invalid"); }
  if (!record(decoded) || decoded.v !== 1 || decoded.kind !== expected.kind
    || decoded.threadId !== expected.threadId || decoded.direction !== expected.direction
    || (decoded.turnId ?? undefined) !== expected.turnId
    || !Number.isSafeInteger(decoded.offset) || Number(decoded.offset) < 0) {
    throw uncertain("legacy thread history cursor does not match the request");
  }
  return Number(decoded.offset);
}
