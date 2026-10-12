import type { ApiReply, Note, ParseResult } from "./types";
import { parseShare } from "./parse-share";
import { LocalApiError, prepareLocalNotesOperation, readLocalBody } from "./local-note-operations";
import type { LocalNotesReply } from "./local-note-operations";

const DATABASE_NAME = "wenfeng-local-notes";
const DATABASE_VERSION = 1;
const STORE_NAME = "notes";

function storageError(error: unknown): LocalApiError {
  if (error instanceof LocalApiError) return error;
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "QuotaExceededError") {
    return new LocalApiError("浏览器本地存储空间不足，本次更改没有保存。请先导出备份，再清理回收站后重试。", 507);
  }
  if (name === "SecurityError" || name === "InvalidStateError" || name === "NotSupportedError") {
    return new LocalApiError("浏览器暂时不允许使用本地数据库。请检查隐私设置后重试，当前输入会保留。", 503);
  }
  return new LocalApiError("本地数据库操作没有完成，当前输入会保留，请重试。", 503);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const fail = (error: unknown) => {
      abandoned = true;
      reject(storageError(error));
    };
    try {
      if (!globalThis.indexedDB) {
        fail(new LocalApiError("此浏览器无法使用 IndexedDB，本地收藏尚未打开。请使用支持本地存储的浏览器，当前输入会保留。", 503));
        return;
      }
      const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "id" });
      };
      request.onblocked = () => fail(new LocalApiError("另一个文风页面正在占用本地数据库，请关闭其他文风标签页后重试，当前输入会保留。", 503));
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        const database = request.result;
        if (abandoned) { database.close(); return; }
        database.onversionchange = () => database.close();
        resolve(database);
      };
    } catch (error) {
      fail(error);
    }
  });
}

function transact(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: ReturnType<typeof prepareLocalNotesOperation>,
): Promise<LocalNotesReply> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, mode);
    } catch (error) {
      reject(storageError(error));
      return;
    }
    let reply: LocalNotesReply | undefined;
    let failure: unknown;
    transaction.oncomplete = () => {
      // A successful request can still be followed by an aborted transaction.
      // Publish the result only after the entire transaction has committed.
      if (reply) resolve(reply);
      else reject(storageError(failure));
    };
    transaction.onabort = () => reject(storageError(failure || transaction.error));
    transaction.onerror = () => { failure ||= transaction.error; };
    const abort = (error: unknown) => {
      failure = error;
      try { transaction.abort(); } catch { reject(storageError(error)); }
    };
    try {
      const store = transaction.objectStore(STORE_NAME);
      const read = store.getAll();
      read.onerror = () => { failure ||= read.error; };
      read.onsuccess = () => {
        try {
          // No await here: read, conflict checks, and writes share this active
          // transaction, including when another tab writes at the same time.
          const changes = operation(read.result as Note[]);
          reply = changes.reply;
          for (const id of changes.deletes) {
            const request = store.delete(id);
            request.onerror = () => { failure ||= request.error; };
          }
          for (const note of changes.upserts) {
            const request = store.put(note);
            request.onerror = () => { failure ||= request.error; };
          }
        } catch (error) {
          abort(error);
        }
      };
    } catch (error) {
      abort(error);
    }
  });
}

/** Static deployment adapter. All collection data stays in this browser's IndexedDB. */
export async function localApi<T = ApiReply>(path: string, method = "GET", body?: unknown): Promise<T> {
  method = method.toUpperCase();
  if (path === "/api/parse") {
    if (method !== "POST") throw new LocalApiError("请提交需要整理的分享内容。", 405);
    const input = readLocalBody(body, 120_000);
    if (typeof input.text !== "string") throw new LocalApiError("请粘贴分享内容。");
    const result: ParseResult = parseShare(input.text);
    if (!result.content && result.sourceUrl) {
      result.notice = "已识别到作品链接。静态版不会抓取远程页面或全文；可以先收藏链接，也可以打开原文后手动补充文字。";
    }
    return result as T;
  }
  if (path !== "/api/notes") throw new LocalApiError("没有找到这个本地功能。", 404);

  // Capture input before the first await, so edits made while storage opens do
  // not change the operation that the user already submitted.
  const operation = prepareLocalNotesOperation(method, body);
  const database = await openDatabase();
  try {
    return await transact(database, method === "GET" ? "readonly" : "readwrite", operation) as T;
  } finally {
    database.close();
  }
}
