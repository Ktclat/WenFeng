import type { Draft, Note } from "./types";
import { douyinUrl, sourceKey } from "./parse-share";
import { noteInput } from "./validation";

export class LocalApiError extends Error {
  readonly existing?: Note;

  constructor(message: string, readonly status = 400, existing?: Note) {
    super(message);
    this.name = "LocalApiError";
    if (existing) this.existing = copyNote(existing);
  }
}

export type LocalNotesReply =
  | { notes: Note[]; skipped?: number }
  | { note: Note }
  | { deleted: true };

export type LocalNotesChanges = {
  reply: LocalNotesReply;
  upserts: Note[];
  deletes: string[];
};

type Operation = (existing: readonly Note[], now?: number) => LocalNotesChanges;
type ImportedDraft = { draft: Draft; createdAt: unknown; updatedAt: unknown };

function copyNote(note: Note): Note {
  return { ...note, tags: [...note.tags] };
}

/** Take the same JSON snapshot as an HTTP request, without changing the caller's draft. */
export function readLocalBody(body: unknown, maxBytes: number): Record<string, unknown> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new LocalApiError("内容格式不正确，请重新尝试。");
  }
  if (!serialized) throw new LocalApiError("没有收到内容。");
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new LocalApiError("提交的内容太大，请分批处理。");
  }
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalApiError("内容格式不正确，请重新尝试。");
  }
  return value as Record<string, unknown>;
}

function normalizeDraft(value: unknown): Draft {
  const parsed = noteInput.safeParse(value);
  if (!parsed.success) {
    throw new LocalApiError(parsed.error.issues[0]?.message || "收藏格式不正确。");
  }
  const draft = parsed.data;
  return {
    ...draft,
    sourceUrl: draft.sourceUrl ? douyinUrl(draft.sourceUrl)! : "",
    tags: [...new Set(draft.tags)],
    status: draft.content.trim() ? (draft.status === "link" ? "manual" : draft.status) : "link",
  };
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= fallback
    ? value
    : fallback;
}

function textKey(note: Pick<Note, "title" | "content">): string {
  return JSON.stringify([note.title, note.content.trim()]);
}

function duplicateIndex(existing: readonly Note[]) {
  const ids = new Map<string, Note>();
  const sources = new Map<string, Note>();
  const texts = new Map<string, Note>();
  function add(note: Note) {
    if (!ids.has(note.id)) ids.set(note.id, note);
    if (note.sourceUrl && !sources.has(sourceKey(note.sourceUrl))) sources.set(sourceKey(note.sourceUrl), note);
    if (!texts.has(textKey(note))) texts.set(textKey(note), note);
  }
  existing.forEach(add);
  return {
    add,
    find: (note: Draft) => ids.get(note.id)
      || (note.sourceUrl ? sources.get(sourceKey(note.sourceUrl)) : texts.get(textKey(note))),
  };
}

function requestId(body: Record<string, unknown>): string {
  if (typeof body.id !== "string") throw new LocalApiError("没有找到这条收藏。");
  return body.id;
}

/**
 * Validate and snapshot before opening IndexedDB. The returned synchronous operation
 * runs against the records read inside one transaction; it never mutates them.
 */
export function prepareLocalNotesOperation(method: string, input?: unknown): Operation {
  method = method.toUpperCase();
  if (method === "GET") {
    return existing => ({
      reply: { notes: existing.map(copyNote).sort((a, b) => b.updatedAt - a.updatedAt) },
      upserts: [],
      deletes: [],
    });
  }
  if (method === "POST") {
    const body = readLocalBody(input, 4_000_000);
    const isImport = Array.isArray(body.notes);
    const items: unknown[] = isImport ? body.notes as unknown[] : [body.note];
    if (!items.length || items.length > 500) throw new LocalApiError("每次可导入 1–500 条收藏。");
    // Validate the complete batch before any database writes are scheduled.
    const prepared: ImportedDraft[] = items.map(value => {
      const draft = normalizeDraft(value);
      const raw = value as Record<string, unknown>;
      return { draft, createdAt: raw.createdAt, updatedAt: raw.updatedAt };
    });
    return (existing, now = Date.now()) => {
      const duplicates = duplicateIndex(existing);
      const added: Note[] = [];
      let skipped = 0;
      for (const item of prepared) {
        const duplicate = duplicates.find(item.draft);
        if (duplicate) {
          if (isImport) { skipped++; continue; }
          throw new LocalApiError(
            duplicate.deletedAt ? "这条内容在回收站里，可以恢复收藏。" : "这条内容已经收藏过了。",
            409,
            duplicate,
          );
        }
        const note: Note = {
          ...item.draft,
          tags: [...item.draft.tags],
          createdAt: isImport ? timestamp(item.createdAt, now) : now,
          updatedAt: isImport ? timestamp(item.updatedAt, now) : now,
          deletedAt: null,
        };
        added.push(note);
        duplicates.add(note);
      }
      if (existing.length + added.length > 5_000) {
        throw new LocalApiError("收藏与回收站共达到 5,000 条。请先导出备份，再永久删除回收站中不再需要的内容。");
      }
      return { reply: { notes: added.map(copyNote), skipped }, upserts: added, deletes: [] };
    };
  }
  if (method === "PATCH") {
    const body = readLocalBody(input, 400_000);
    if (body.action === "star" || body.action === "trash" || body.action === "restore") {
      const id = requestId(body);
      const action = body.action;
      const starred = body.starred;
      if (action === "star" && typeof starred !== "boolean") throw new LocalApiError("星标状态不正确。");
      return (existing, now = Date.now()) => {
        const current = existing.find(note => note.id === id);
        if (!current) throw new LocalApiError("没有找到这条收藏。", 404);
        const note: Note = {
          ...copyNote(current),
          updatedAt: now,
          ...(action === "star" ? { starred: starred as boolean } : { deletedAt: action === "trash" ? now : null }),
        };
        return { reply: { note: copyNote(note) }, upserts: [note], deletes: [] };
      };
    }
    const draft = normalizeDraft(body.note);
    return (existing, now = Date.now()) => {
      const current = existing.find(note => note.id === draft.id);
      if (!current) throw new LocalApiError("没有找到这条收藏。", 404);
      const conflict = duplicateIndex(existing.filter(note => note.id !== draft.id)).find(draft);
      if (conflict) {
        throw new LocalApiError("另有一条相同来源或内容的收藏，请修改来源或查看已有收藏。", 409, conflict);
      }
      const note: Note = { ...current, ...draft, tags: [...draft.tags], updatedAt: now };
      return { reply: { note: copyNote(note) }, upserts: [note], deletes: [] };
    };
  }
  if (method === "DELETE") {
    const id = requestId(readLocalBody(input, 10_000));
    return existing => {
      const current = existing.find(note => note.id === id);
      if (!current || current.deletedAt == null) {
        throw new LocalApiError("只能永久删除回收站中的收藏。", 404);
      }
      return { reply: { deleted: true }, upserts: [], deletes: [id] };
    };
  }
  throw new LocalApiError("不支持这个收藏操作。", 405);
}

/** Pure entry point used to verify import, editing, and capacity rules. */
export function localNotesOperation(
  existing: readonly Note[], method = "GET", body?: unknown, now = Date.now(),
): LocalNotesChanges {
  return prepareLocalNotesOperation(method, body)(existing, now);
}
