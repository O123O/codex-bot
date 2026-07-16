import { Buffer } from "node:buffer";
import { ThreadHistoryReader } from "../app-server/thread-history.ts";
import { isExactThreadItemsUnsupported } from "../app-server/thread-errors.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import type { WorkerNativeHistoryPage } from "./worker-history-reader.ts";

export interface ReadyWorkerReadDeps {
  withReadyWorkLease<T>(endpointId: string, run: (lease: EndpointWorkLease) => Promise<T>): Promise<T>;
  request(endpointId: string, method: string, params: unknown, signal?: AbortSignal, lease?: EndpointWorkLease): Promise<unknown>;
}

// A passive Web UI read: withReadyWorkLease fails instead of activating an unavailable endpoint,
// and the existing lease prevents the pool's provider from racing into activating admission.
export async function readReadyWorkerTurns(
  deps: ReadyWorkerReadDeps,
  endpointId: string,
  threadId: string,
  limit: number,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<WorkerNativeHistoryPage> {
  return deps.withReadyWorkLease(endpointId, async (lease) => {
    const history = new ThreadHistoryReader((method, params) => (
      deps.request(endpointId, method, params, signal, lease)
    ));
    const requested = Math.max(1, Math.min(50, Math.trunc(limit) || 20));
    let state = decodeNativeCursor(cursor);
    const hydrated: unknown[] = [];
    let displayItems = 0;
    let nextState: NativeHistoryCursor | undefined;
    let pageRequests = 0;
    while (displayItems < requested) {
      if (pageRequests >= MAX_NATIVE_PAGE_REQUESTS) { nextState = state; break; }
      pageRequests += 1;
      const turnPage = await history.turnsPage(threadId, {
        ...(state.turnCursor === undefined ? {} : { cursor: state.turnCursor }),
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      const turn = turnPage.data[0];
      if (!turn) { nextState = undefined; break; }

      let summary: typeof turn.items = [];
      let pageItems: typeof turn.items = [];
      let nextItemCursor: string | undefined;
      let legacy = false;
      try {
        if (pageRequests >= MAX_NATIVE_PAGE_REQUESTS) { nextState = state; break; }
        pageRequests += 1;
        const itemPage = await history.itemsPage(threadId, {
          turnId: turn.id,
          ...(state.itemCursor === undefined ? {} : { cursor: state.itemCursor }),
          limit: 16,
          sortDirection: "desc",
        });
        pageItems = displayOnly(itemPage.data).map((item) => ({
          ...item,
          itemOrder: MAX_ORDINAL - (state.itemOffset + itemPage.data.indexOf(item)),
        }));
        nextItemCursor = itemPage.nextCursor ?? undefined;
        nextState = nextItemCursor
          ? { ...state, itemCursor: nextItemCursor, itemOffset: state.itemOffset + itemPage.data.length }
          : turnPage.nextCursor
            ? { turnCursor: turnPage.nextCursor, turnOffset: state.turnOffset + 1, itemOffset: 0 }
            : undefined;
      } catch (error) {
        if (!isExactThreadItemsUnsupported(error)) throw error;
        if (pageRequests >= MAX_NATIVE_PAGE_REQUESTS) { nextState = state; break; }
        pageRequests += 1;
        const legacyPage = await history.turnsPage(threadId, {
          ...(state.turnCursor === undefined ? {} : { cursor: state.turnCursor }),
          limit: 1,
          sortDirection: "desc",
          itemsView: "summary",
        });
        const legacyTurn = legacyPage.data[0];
        if (!legacyTurn || legacyTurn.id !== turn.id) throw new Error("legacy worker history turn changed during paging");
        summary = displayOnly(legacyTurn.items);
        legacy = true;
        nextState = turnPage.nextCursor
          ? { turnCursor: turnPage.nextCursor, turnOffset: state.turnOffset + 1, itemOffset: 0 }
          : undefined;
      }

      const selected = mergeDisplayItems(summary, pageItems);
      if (selected.length > 0) {
        hydrated.push({
          ...turn,
          turnOrder: MAX_ORDINAL - state.turnOffset,
          itemsView: legacy ? "summary" : "full",
          items: selected,
        });
        displayItems += selected.length;
      }
      if (displayItems >= requested || (summary.length > 0 && pageItems.length === 0 && nextItemCursor)) break;
      if (!nextState) break;
      state = nextState;
    }
    return {
      turns: hydrated.reverse(),
      ...(nextState ? { nextTurnCursor: encodeNativeCursor(nextState) } : {}),
    };
  });
}

const MAX_ORDINAL = Number.MAX_SAFE_INTEGER;
const MAX_NATIVE_PAGE_REQUESTS = 8;

interface NativeHistoryCursor {
  turnCursor?: string;
  itemCursor?: string;
  turnOffset: number;
  itemOffset: number;
}

function displayOnly<T extends { type: string }>(items: T[]): T[] {
  return items.filter((item) => item.type === "userMessage" || item.type === "agentMessage");
}

function mergeDisplayItems<T extends { id: string; type: string }>(summary: T[], exact: T[]): T[] {
  const items = new Map<string, T & { itemOrder?: number }>();
  for (const [index, item] of summary.entries()) {
    items.set(item.id, {
      ...item,
      itemOrder: item.type === "userMessage" ? index : MAX_ORDINAL - summary.length + index,
    });
  }
  for (const item of exact) items.set(item.id, item);
  return [...items.values()].sort((left, right) => (left.itemOrder ?? 0) - (right.itemOrder ?? 0));
}

function encodeNativeCursor(cursor: NativeHistoryCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

function decodeNativeCursor(value: string | undefined): NativeHistoryCursor {
  if (value === undefined) return { turnOffset: 0, itemOffset: 0 };
  if (!value || value.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid native worker history cursor");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("invalid native worker history cursor"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid native worker history cursor");
  const cursor = decoded as Record<string, unknown>;
  if (cursor.v !== 1 || !safeOffset(cursor.turnOffset) || !safeOffset(cursor.itemOffset)
    || !optionalCursor(cursor.turnCursor) || !optionalCursor(cursor.itemCursor)) {
    throw new Error("invalid native worker history cursor");
  }
  return {
    ...(typeof cursor.turnCursor === "string" ? { turnCursor: cursor.turnCursor } : {}),
    ...(typeof cursor.itemCursor === "string" ? { itemCursor: cursor.itemCursor } : {}),
    turnOffset: cursor.turnOffset as number,
    itemOffset: cursor.itemOffset as number,
  };
}

function safeOffset(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < MAX_ORDINAL;
}

function optionalCursor(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 2_048);
}
