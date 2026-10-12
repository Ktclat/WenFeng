import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Execute the production adapter and validation. This small IndexedDB transport
// stages writes, serializes transactions, and can delay or reject a commit; it
// does not replace any collection, parsing, or duplicate-detection logic.
const base = resolve(".sites-runtime/tests");
await mkdir(base, { recursive: true });
const dir = await mkdtemp(resolve(base, "local-api-"));
async function compile(source, name, replacements = {}) {
  let code = await readFile(source, "utf8");
  for (const [from, to] of Object.entries(replacements)) code = code.replaceAll(`"${from}"`, `"${to}"`);
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  await writeFile(resolve(dir, name), output);
}
await compile("app/lib/parse-share.ts", "parser.mjs");
await compile("app/lib/validation.ts", "validation.mjs", { "./parse-share": "./parser.mjs" });
await compile("app/lib/local-note-operations.ts", "operations.mjs", { "./parse-share": "./parser.mjs", "./validation": "./validation.mjs" });
await compile("app/lib/local-api.ts", "local-api.mjs", { "./parse-share": "./parser.mjs", "./local-note-operations": "./operations.mjs" });
const { localApi } = await import(pathToFileURL(resolve(dir, "local-api.mjs")));
const { localNotesOperation, prepareLocalNotesOperation, LocalApiError } = await import(pathToFileURL(resolve(dir, "operations.mjs")));
const { parseShare, isUnresolvedShareToken, shareTokenKey, textContentKey } = await import(pathToFileURL(resolve(dir, "parser.mjs")));

// Publicly observed formats, not a claim that these opaque tokens are still valid:
// https://www.douyin.com/shipin/7264272412638939190
// https://www.douyin.com/shipin/7263567419669497913
// The third variant was observed in the search index for:
// https://www.douyin.com/video/7317213191006670132
const PUBLIC_TOKENS = [
  "9:/ 10/12 g@b.nd 长按复制此条消息，打开抖音查看精彩内容##onSv5CKloZ8##[抖音口令]",
  "5:/ k@p.dA :5pm 05/31 长按复制此条消息，打开抖音查看精彩内容##tbK5XPeYG99##[抖音口令]",
  "#7- 02/16 a@n.DU 长按复制此条消息，打开抖音查看精彩:/ 内容##VC5fEvSQwI8##[抖音口令]",
];

const clone = value => structuredClone(value);
const nextTask = callback => setImmediate(callback);

class MemoryIndexedDB {
  databases = new Map();
  openCount = 0;
  closedCount = 0;
  failWriteAt = 0;
  failNextCommit = null;
  heldCommit = null;

  open(name) {
    const request = { result: undefined, error: null };
    this.openCount++;
    nextTask(() => {
      let record = this.databases.get(name);
      const fresh = !record;
      if (!record) {
        record = { stores: new Set(), rows: new Map(), queue: [] };
        this.databases.set(name, record);
      }
      const database = {
        closed: false,
        objectStoreNames: { contains: store => record.stores.has(store) },
        createObjectStore(store) { record.stores.add(store); },
        close: () => { if (!database.closed) this.closedCount++; database.closed = true; },
        transaction: (store, mode) => {
          if (database.closed) throw new DOMException("closed", "InvalidStateError");
          if (!record.stores.has(store)) throw new DOMException("store missing", "NotFoundError");
          const transaction = new MemoryTransaction(this, record, mode);
          record.queue.push(transaction);
          if (record.queue.length === 1) nextTask(() => transaction.start());
          return transaction;
        },
      };
      request.result = database;
      if (fresh) request.onupgradeneeded?.({ target: request });
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  pauseNextCommit() {
    let announce;
    const ready = new Promise(resolveReady => { announce = resolveReady; });
    const hold = { announce, resume: null };
    this.heldCommit = hold;
    return { ready, release: () => { assert.equal(typeof hold.resume, "function"); hold.resume(); } };
  }

  committed() {
    return clone([...this.databases.values()].flatMap(record => [...record.rows.values()]));
  }
}

class MemoryTransaction {
  requests = [];
  active = false;
  finished = false;
  error = null;
  writes = 0;

  constructor(factory, record, mode) { this.factory = factory; this.record = record; this.mode = mode; }
  start() {
    this.active = true;
    this.staged = new Map([...this.record.rows].map(([id, note]) => [id, clone(note)]));
    this.pump();
  }
  objectStore() {
    const enqueue = (kind, value) => {
      if (this.finished) throw new DOMException("inactive", "TransactionInactiveError");
      if (kind !== "getAll" && this.mode !== "readwrite") throw new DOMException("readonly", "ReadOnlyError");
      const request = { result: undefined, error: null };
      this.requests.push({ kind, value: clone(value), request });
      return request;
    };
    return { getAll: () => enqueue("getAll"), put: note => enqueue("put", note), delete: id => enqueue("delete", id) };
  }
  pump() {
    if (this.finished) return;
    const work = this.requests.shift();
    if (!work) {
      if (this.mode === "readwrite" && this.factory.heldCommit) {
        const hold = this.factory.heldCommit;
        this.factory.heldCommit = null;
        hold.resume = () => this.commit();
        hold.announce();
      } else this.commit();
      return;
    }
    const { kind, value, request } = work;
    try {
      if (kind !== "getAll" && ++this.writes === this.factory.failWriteAt) {
        this.factory.failWriteAt = 0;
        throw new DOMException("simulated write failure", "QuotaExceededError");
      }
      if (kind === "getAll") request.result = clone([...this.staged.values()]);
      else if (kind === "put") { this.staged.set(value.id, value); request.result = value.id; }
      else this.staged.delete(value);
      request.onsuccess?.({ target: request });
    } catch (error) {
      request.error = error;
      request.onerror?.({ target: request });
      this.error = error;
      this.onerror?.({ target: this });
      if (!this.finished) this.abort(error);
      return;
    }
    if (!this.finished) nextTask(() => this.pump());
  }
  commit() {
    if (this.mode === "readwrite" && this.factory.failNextCommit) {
      const error = this.factory.failNextCommit;
      this.factory.failNextCommit = null;
      this.abort(error);
      return;
    }
    if (this.mode === "readwrite") this.record.rows = this.staged;
    this.finished = true;
    this.oncomplete?.({ target: this });
    this.advance();
  }
  abort(error = new DOMException("aborted", "AbortError")) {
    if (this.finished) throw new DOMException("inactive", "InvalidStateError");
    this.error = error;
    this.finished = true;
    nextTask(() => { this.onabort?.({ target: this }); this.advance(); });
  }
  advance() {
    assert.equal(this.record.queue.shift(), this);
    if (this.record.queue[0]) nextTask(() => this.record.queue[0].start());
  }
}

const NOW = 1_800_000_000_000;
function draft(overrides = {}) {
  return { id: crypto.randomUUID(), title: "一段值得重读的文字", content: "慢慢来，也很快。", author: "", sourceUrl: "", originalShare: "", category: "生活感悟", tags: ["生活"], starred: false, status: "manual", ...overrides };
}
function stored(overrides = {}) { return { ...draft(), createdAt: NOW - 1000, updatedAt: NOW - 500, deletedAt: null, ...overrides }; }
function install(factory) { Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: factory }); }
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error("Static adapter must not fetch"); };

try {
  await test("静态解析不依赖数据库，不读取远程全文", async t => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, get() { throw new Error("Parsing must not open a database"); } });
    await t.test("分享文案保留中文、作者与标签", async () => {
      const result = await localApi("/api/parse", "POST", { text: "6.52 复制打开抖音，看看【阿青的作品】把日子过成喜欢的样子。 #生活 https://v.douyin.com/AbCdEf12/ n@Q.uL 10/13 yUI:/" });
      assert.equal(result.status, "share");
      assert.equal(result.content, "把日子过成喜欢的样子。 #生活");
      assert.equal(result.author, "阿青");
      assert.deepEqual(result.tags, ["生活"]);
    });
    await t.test("纯链接明确说明静态版不会抓取全文", async () => {
      const result = await localApi("/api/parse", "POST", { text: "https://www.douyin.com/note/7000000000000000001?from=share" });
      assert.equal(result.content, "");
      assert.equal(result.status, "link");
      assert.equal(result.sourceUrl, "https://www.douyin.com/note/7000000000000000001");
      assert.match(result.notice, /静态版不会抓取/);
      assert.doesNotMatch(result.notice, /正在尝试|已提取.*全文/);
    });
    await t.test("真实形态的不透明口令保留原文，不冒充文章或标签", async () => {
      for (const text of PUBLIC_TOKENS) {
        const result = await localApi("/api/parse", "POST", { text });
        assert.equal(result.title, "待解析的抖音口令");
        assert.equal(result.content, "");
        assert.equal(result.sourceUrl, "");
        assert.equal(result.author, "");
        assert.equal(result.originalShare, text);
        assert.equal(result.status, "link");
        assert.deepEqual(result.tags, []);
        assert.equal(isUnresolvedShareToken(text), true);
        assert.match(result.notice, /没有解析出文章/);
        assert.match(result.notice, /复制作品链接或手动补充正文/);
      }
    });
    await t.test("无 URL 的明确分享模板只提取文案，作者仅来自完整作者前缀", () => {
      // Compatibility fixtures composed from the existing copy template and the
      // observed token block; these are not asserted to be an official protocol.
      const wrapped = "6.52 复制打开抖音，看看【阿青的作品】把日子过成喜欢的样子。 #生活 ##onSv5CKloZ8##[抖音口令]";
      const result = parseShare(wrapped);
      assert.equal(result.content, "把日子过成喜欢的样子。 #生活");
      assert.equal(result.author, "阿青");
      assert.equal(result.sourceUrl, "");
      assert.equal(result.status, "share");
      assert.deepEqual(result.tags, ["生活"]);
      assert.equal(isUnresolvedShareToken(wrapped), false);
      const described = parseShare(`让生活慢一点。 #爱喝茶的朋友请关注我\n${PUBLIC_TOKENS[0]}`);
      assert.equal(described.content, "让生活慢一点。 #爱喝茶的朋友请关注我");
      assert.equal(described.author, "");
      assert.equal(described.status, "share");
      const english = parseShare(`Email: me@example.com\n${PUBLIC_TOKENS[0]}`);
      assert.equal(english.content, "Email: me@example.com");
      const variant = parseShare(`Email: me@example.com\n${PUBLIC_TOKENS[2]}`);
      assert.equal(variant.content, "Email: me@example.com");
      assert.deepEqual(variant.tags, []);
      const withoutToken = parseShare("6.52 复制打开抖音，看看【阿青的图文】今天也要慢慢长大。 #成长");
      assert.equal(withoutToken.content, "今天也要慢慢长大。 #成长");
      assert.equal(withoutToken.author, "阿青");
      assert.equal(withoutToken.status, "share");
    });
    await t.test("普通短句、数字、随机码、Markdown 和英文笔记不会被当作口令", () => {
      for (const text of [
        "生活明朗，万物可爱。", "7000000000000000001", "onSv5CKloZ8",
        "## Weekly notes\nKeep the original text.", "##onSv5CKloZ8##",
        "English notes about copying and sharing.",
        "用法示例：##onSv5CKloZ8##[抖音口令]",
        "看看【阿青的作品】这只是我写的说明。",
        "snssdk9999://aweme/detail/7000000000000000001",
        "#7- 02/16 a@n.DU", "查看精彩:/ 内容",
      ]) {
        const result = parseShare(text);
        assert.equal(isUnresolvedShareToken(text), false, text);
        assert.equal(result.content, text, text);
        assert.equal(result.sourceUrl, "", text);
        assert.equal(result.author, "", text);
        assert.equal(result.status, "manual", text);
      }
      assert.equal(isUnresolvedShareToken("长按复制此条消息，打开抖音查看精彩内容"), false);
      assert.throws(() => parseShare(`${PUBLIC_TOKENS[0]}\n${PUBLIC_TOKENS[1]}`), /多条抖音口令/);
    });
    await t.test("多条裸口令与混合分享提示一次一条，引用示例仍是原文", () => {
      const bare = "##onSv5CKloZ8##[抖音口令]\n##tbK5XPeYG99##[抖音口令]";
      assert.throws(() => parseShare(bare), /多条抖音口令/);
      assert.throws(() => parseShare(`${PUBLIC_TOKENS[0]}\n##tbK5XPeYG99##[抖音口令]`), /多条抖音口令/);
      assert.equal(isUnresolvedShareToken(bare), false);
      assert.equal(shareTokenKey(bare), null);
      const quoted = "示例一：##onSv5CKloZ8##[抖音口令]\n示例二：##tbK5XPeYG99##[抖音口令]";
      const result = parseShare(quoted);
      assert.equal(result.content, quoted);
      assert.equal(result.status, "manual");
      assert.equal(result.sourceUrl, "");
      assert.equal(shareTokenKey(quoted), null);
    });
    await t.test("原有带链接的分享清理和普通链接旁的正文保持不变", () => {
      const wrapped = parseShare("6.52 复制打开抖音，看看【阿青的作品】把日子过成喜欢的样子。 #生活 https://v.douyin.com/AbCdEf12/ n@Q.uL 10/13 yUI:/");
      assert.equal(wrapped.content, "把日子过成喜欢的样子。 #生活");
      assert.equal(wrapped.author, "阿青");
      assert.equal(wrapped.sourceUrl, "https://v.douyin.com/AbCdEf12/");
      const unwrapped = parseShare("我喜欢这段文字（https://www.douyin.com/note/7000000000000000001）。\n尤其是最后一句。");
      assert.equal(unwrapped.content, "我喜欢这段文字。\n尤其是最后一句。");
      assert.equal(unwrapped.author, "");
      assert.throws(() => parseShare("https://www.douyin.com/video/7000000000000000001?modal_id=7000000000000000002"), /没有识别到抖音作品链接/);
    });
    await t.test("无效域名、多链接、空输入和过长内容保留错误", async () => {
      await assert.rejects(localApi("/api/parse", "POST", { text: "https://v.douyin.com.evil.test/abc" }), /没有识别到抖音/);
      await assert.rejects(localApi("/api/parse", "POST", { text: "https://v.douyin.com/abc/ https://v.douyin.com/def/" }), /多条抖音链接/);
      await assert.rejects(localApi("/api/parse", "POST", { text: " " }), /先粘贴/);
      await assert.rejects(localApi("/api/parse", "POST", { text: "文".repeat(24001) }), /24,000/);
      await assert.rejects(localApi("/api/parse", "GET"), error => error.status === 405);
    });
    assert.equal(fetchCalls, 0);
  });

  await test("纯收藏操作的导入、去重与容量边界", async t => {
    await t.test("无正文口令按大小写敏感的码去重，普通文字仍按标题正文去重", () => {
      const first = draft({ ...parseShare(PUBLIC_TOKENS[0]) });
      const sameCode = draft({ ...first, id: crypto.randomUUID(), title: "换一个标题", originalShare: "##onSv5CKloZ8##【抖音口令】" });
      const another = draft({ ...parseShare(PUBLIC_TOKENS[1]) });
      const caseChanged = draft({ ...first, id: crypto.randomUUID(), originalShare: "##OnSv5CKloZ8##[抖音口令]" });
      assert.equal(textContentKey(first), textContentKey(sameCode));
      assert.notEqual(textContentKey(first), textContentKey(another));
      assert.notEqual(textContentKey(first), textContentKey(caseChanged));
      assert.equal(shareTokenKey(first.originalShare), shareTokenKey(sameCode.originalShare));
      assert.notEqual(shareTokenKey(first.originalShare), shareTokenKey(caseChanged.originalShare));
      assert.equal(shareTokenKey("onSv5CKloZ8"), null);
      assert.equal(shareTokenKey("用法示例：##onSv5CKloZ8##[抖音口令]"), null);
      const imported = localNotesOperation([], "POST", { notes: [first, sameCode, another, caseChanged] }, NOW);
      assert.equal(imported.reply.skipped, 1);
      assert.equal(imported.upserts.length, 3);
      assert.equal(imported.upserts[0].originalShare, PUBLIC_TOKENS[0]);
      assert.equal(imported.upserts[1].originalShare, PUBLIC_TOKENS[1]);
      assert.equal(textContentKey(draft()), textContentKey(draft({ originalShare: PUBLIC_TOKENS[0] })));
      assert.throws(() => localNotesOperation([], "POST", { note: draft({ content: "", originalShare: "onSv5CKloZ8" }) }, NOW), /正文或抖音/);
    });
    await t.test("跨 video、note、slides 和 modal_id 的同一作品只保存一条", () => {
      const archived = stored({ sourceUrl: "https://www.douyin.com/video/7000000000000000001", deletedAt: NOW - 1 });
      const entries = [
        draft({ sourceUrl: "https://www.douyin.com/note/7000000000000000001" }),
        draft({ sourceUrl: "https://www.douyin.com/?modal_id=7000000000000000001" }),
        draft({ title: "第二条", sourceUrl: "https://www.douyin.com/slides/7000000000000000002", createdAt: NOW - 2000, updatedAt: NOW - 1000, starred: true }),
        draft({ title: "第二条的另一地址", sourceUrl: "https://www.douyin.com/video/7000000000000000002" }),
      ];
      const result = localNotesOperation([archived], "POST", { notes: entries }, NOW);
      assert.equal(result.reply.skipped, 3);
      assert.equal(result.upserts.length, 1);
      assert.equal(result.upserts[0].sourceUrl, "https://www.douyin.com/note/7000000000000000002");
      assert.equal(result.upserts[0].createdAt, NOW - 2000);
      assert.equal(result.upserts[0].updatedAt, NOW - 1000);
      assert.equal(result.upserts[0].starred, true);
      assert.equal(archived.deletedAt, NOW - 1);
    });
    await t.test("无来源条目按标题和正文去重，标签规范化且不改输入", () => {
      const existing = stored();
      const input = { notes: [draft({ content: "  慢慢来，也很快。  " }), draft({ title: "  新的文字  ", content: "第一行\n<script>只是文字</script>", tags: ["  成长  ", "成长"], deletedAt: NOW - 1 })] };
      const original = clone(input);
      const result = localNotesOperation([existing], "POST", input, NOW);
      assert.equal(result.reply.skipped, 1);
      assert.equal(result.upserts[0].title, "新的文字");
      assert.deepEqual(result.upserts[0].tags, ["成长"]);
      assert.equal(result.upserts[0].deletedAt, null);
      assert.equal(result.upserts[0].content, "第一行\n<script>只是文字</script>");
      assert.deepEqual(input, original);
    });
    await t.test("原始时间可恢复，伪造或无效时间回退到本次导入时间", () => {
      const result = localNotesOperation([], "POST", { notes: [
        draft({ title: "旧记录", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_500_000 }),
        draft({ title: "无效时间", createdAt: NOW + 1, updatedAt: -1 }),
      ] }, NOW);
      assert.equal(result.upserts[0].createdAt, 1_700_000_000_000);
      assert.equal(result.upserts[0].updatedAt, 1_700_000_500_000);
      assert.equal(result.upserts[1].createdAt, NOW);
      assert.equal(result.upserts[1].updatedAt, NOW);
      const created = localNotesOperation([], "POST", { note: draft({ createdAt: NOW - 10000 }) }, NOW);
      assert.equal(created.upserts[0].createdAt, NOW);
    });
    await t.test("整批校验、500 条批次限制和 JSON 字节限制在写入前执行", () => {
      assert.throws(() => localNotesOperation([], "POST", { notes: [draft(), draft({ title: "" })] }, NOW), /标题/);
      assert.throws(() => localNotesOperation([], "POST", { notes: [] }, NOW), /1–500/);
      assert.throws(() => localNotesOperation([], "POST", { notes: Array.from({ length: 501 }, () => draft()) }, NOW), /1–500/);
      assert.throws(() => localNotesOperation([], "POST", { note: draft(), extra: "汉".repeat(1_400_000) }, NOW), /内容太大/);
      const cyclic = {}; cyclic.self = cyclic;
      assert.throws(() => localNotesOperation([], "POST", cyclic, NOW), /格式不正确/);
    });
    await t.test("5,000 条容量包含回收站，重复导入不占容量，永久删除后可以再添加", () => {
      const records = Array.from({ length: 5000 }, (_, index) => stored({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, title: `文字 ${index}`, deletedAt: index === 0 ? NOW - 1 : null }));
      assert.equal(localNotesOperation(records, "POST", { notes: [records[0]] }, NOW).reply.skipped, 1);
      assert.throws(() => localNotesOperation(records, "POST", { note: draft({ title: "新增内容" }) }, NOW), /5,000/);
      const deleted = localNotesOperation(records, "DELETE", { id: records[0].id }, NOW);
      const remaining = records.filter(note => !deleted.deletes.includes(note.id));
      assert.equal(localNotesOperation(remaining, "POST", { note: draft({ title: "新增内容" }) }, NOW).upserts.length, 1);
      assert.equal(records.length, 5000);
    });
    await t.test("提交后的调用方修改不会改变已经准备好的请求", () => {
      const input = { note: draft({ content: "提交时的正文" }) };
      const operation = prepareLocalNotesOperation("POST", input);
      input.note.content = "后来输入的正文";
      input.note.tags.push("后来添加的标签");
      const result = operation([], NOW);
      assert.equal(result.upserts[0].content, "提交时的正文");
      assert.deepEqual(result.upserts[0].tags, ["生活"]);
    });
  });

  await test("真实适配器的 IndexedDB 事务边界与编辑流程", async t => {
    await t.test("纯口令可以分别收藏、备份导入和删除恢复，补正文或链接后可继续整理", async () => {
      install(new MemoryIndexedDB());
      const first = (await localApi("/api/notes", "POST", { note: draft({ ...parseShare(PUBLIC_TOKENS[0]) }) })).notes[0];
      const second = (await localApi("/api/notes", "POST", { note: draft({ ...parseShare(PUBLIC_TOKENS[1]) }) })).notes[0];
      assert.equal(first.title, second.title);
      assert.notEqual(first.id, second.id);
      await assert.rejects(localApi("/api/notes", "POST", { note: draft({ ...parseShare("##onSv5CKloZ8##[抖音口令]"), title: "另起的标题" }) }), error => error.status === 409 && error.existing.id === first.id);
      await assert.rejects(localApi("/api/notes", "PATCH", { note: { ...second, originalShare: "##onSv5CKloZ8##[抖音口令]" } }), error => error.status === 409 && error.existing.id === first.id);
      const backup = JSON.parse(JSON.stringify((await localApi("/api/notes")).notes));
      install(new MemoryIndexedDB());
      const imported = await localApi("/api/notes", "POST", { notes: backup });
      assert.equal(imported.notes.length, 2);
      const recovered = imported.notes.find(note => note.id === first.id);
      assert.equal(recovered.originalShare, PUBLIC_TOKENS[0]);
      assert.equal(recovered.createdAt, first.createdAt);
      assert.equal(recovered.updatedAt, first.updatedAt);
      await localApi("/api/notes", "PATCH", { action: "trash", id: first.id });
      const restored = (await localApi("/api/notes", "PATCH", { action: "restore", id: first.id })).note;
      assert.equal(restored.originalShare, PUBLIC_TOKENS[0]);
      assert.equal(restored.content, "");
      assert.equal(restored.sourceUrl, "");
      assert.equal(restored.deletedAt, null);
      const edited = (await localApi("/api/notes", "PATCH", { note: { ...restored, content: "后来补上的正文。" } })).note;
      assert.equal(edited.content, "后来补上的正文。");
      assert.equal(edited.status, "manual");
      const pastedAgain = draft({ ...parseShare("##onSv5CKloZ8##[抖音口令]"), title: "重新粘贴的口令" });
      await assert.rejects(localApi("/api/notes", "POST", { note: pastedAgain }), error => error.status === 409 && error.existing.id === first.id);
      await assert.rejects(localApi("/api/notes", "POST", { note: draft({ title: edited.title, content: edited.content }) }), error => error.status === 409 && error.existing.id === first.id);
      assert.equal((await localApi("/api/notes", "POST", { notes: [pastedAgain] })).skipped, 1);
      const linked = (await localApi("/api/notes", "PATCH", { note: { ...edited, sourceUrl: "https://www.douyin.com/note/7000000000000000001" } })).note;
      assert.equal(linked.sourceUrl, "https://www.douyin.com/note/7000000000000000001");
      assert.equal(linked.originalShare, PUBLIC_TOKENS[0]);
      await assert.rejects(localApi("/api/notes", "POST", { note: pastedAgain }), error => error.status === 409 && error.existing.id === first.id);
      await assert.rejects(localApi("/api/notes", "PATCH", { note: { ...second, content: "另一条补充文案", sourceUrl: "https://www.douyin.com/note/7000000000000000002", originalShare: first.originalShare } }), error => error.status === 409 && error.existing.id === first.id);
      assert.equal((await localApi("/api/notes")).notes.length, 2);
    });
    await t.test("重新建立数据库连接后仍读到收藏，返回对象不会改动已存内容", async () => {
      const factory = new MemoryIndexedDB(); install(factory);
      const input = { note: draft({ sourceUrl: "https://www.douyin.com/video/7000000000000000001?from=share", tags: ["文字", "文字"] }) };
      const saved = await localApi("/api/notes", "POST", input);
      assert.equal(saved.notes[0].sourceUrl, "https://www.douyin.com/video/7000000000000000001");
      saved.notes[0].content = "不应影响数据库";
      saved.notes[0].tags.push("临时标签");
      const reopened = await localApi("/api/notes");
      assert.equal(reopened.notes[0].content, input.note.content);
      assert.deepEqual(reopened.notes[0].tags, ["文字"]);
      assert.equal(factory.openCount, 2);
      assert.equal(factory.closedCount, 2);
    });
    await t.test("请求已成功但事务尚未提交时，不返回保存成功", async () => {
      const factory = new MemoryIndexedDB(); install(factory);
      const hold = factory.pauseNextCommit();
      let settled = false;
      const request = localApi("/api/notes", "POST", { note: draft() }).then(result => { settled = true; return result; });
      await hold.ready;
      assert.equal(settled, false);
      assert.deepEqual(factory.committed(), []);
      hold.release();
      const result = await request;
      assert.equal(factory.committed()[0].id, result.notes[0].id);
      assert.equal(factory.closedCount, 1);
    });
    await t.test("第二条写入失败使整批回滚，错误保留输入并说明空间不足", async () => {
      const factory = new MemoryIndexedDB(); install(factory);
      const first = (await localApi("/api/notes", "POST", { note: draft({ title: "原有收藏" }) })).notes[0];
      factory.failWriteAt = 2;
      const input = { notes: [draft({ title: "批次一" }), draft({ title: "批次二" })] };
      const original = clone(input);
      await assert.rejects(localApi("/api/notes", "POST", input), error => error instanceof LocalApiError && error.status === 507 && /没有保存/.test(error.message));
      assert.deepEqual(input, original);
      assert.deepEqual((await localApi("/api/notes")).notes, [first]);
      assert.equal(factory.closedCount, factory.openCount);
    });
    await t.test("所有请求成功后若提交失败，旧记录仍然完整", async () => {
      const factory = new MemoryIndexedDB(); install(factory);
      const first = (await localApi("/api/notes", "POST", { note: draft() })).notes[0];
      factory.failNextCommit = new DOMException("commit failed", "QuotaExceededError");
      await assert.rejects(localApi("/api/notes", "PATCH", { note: { ...first, content: "不应替换原文" } }), /没有保存/);
      assert.deepEqual((await localApi("/api/notes")).notes, [first]);
    });
    await t.test("并发写入共享事务去重，失败的一次收到 existing 记录", async () => {
      const factory = new MemoryIndexedDB(); install(factory);
      const results = await Promise.allSettled([
        localApi("/api/notes", "POST", { note: draft({ sourceUrl: "https://www.douyin.com/video/7000000000000000001" }) }),
        localApi("/api/notes", "POST", { note: draft({ sourceUrl: "https://www.douyin.com/note/7000000000000000001" }) }),
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const rejected = results.find(result => result.status === "rejected").reason;
      assert.equal(rejected.status, 409);
      const notes = (await localApi("/api/notes")).notes;
      assert.equal(notes.length, 1);
      assert.equal(rejected.existing.id, notes[0].id);
      await Promise.all([
        localApi("/api/notes", "POST", { note: draft({ title: "独立收藏一" }) }),
        localApi("/api/notes", "POST", { note: draft({ title: "独立收藏二" }) }),
      ]);
      assert.equal((await localApi("/api/notes")).notes.length, 3);
    });
    await t.test("编辑冲突保留双方正文，星标只改星标，删除必须先经过回收站", async () => {
      const factory = new MemoryIndexedDB(); install(factory);
      const first = (await localApi("/api/notes", "POST", { note: draft({ title: "第一条", sourceUrl: "https://www.douyin.com/video/7000000000000000001" }) })).notes[0];
      let second = (await localApi("/api/notes", "POST", { note: draft({ title: "第二条", content: "", status: "page", sourceUrl: "https://v.douyin.com/AbCdEf12/" }) })).notes[0];
      assert.equal(second.status, "link");
      const changed = { ...second, content: "第一行\n<script>这里只是文字</script>\n第二行", tags: ["新标签"] };
      second = (await localApi("/api/notes", "PATCH", { note: changed })).note;
      assert.equal(second.status, "manual");
      assert.equal(second.content, changed.content);
      assert.equal(second.createdAt, changed.createdAt);
      const conflictDraft = { ...second, sourceUrl: "https://www.douyin.com/note/7000000000000000001" };
      const snapshot = clone(conflictDraft);
      await assert.rejects(localApi("/api/notes", "PATCH", { note: conflictDraft }), error => error.status === 409 && error.existing.id === first.id);
      assert.deepEqual(conflictDraft, snapshot);
      assert.equal((await localApi("/api/notes")).notes.find(note => note.id === second.id).sourceUrl, second.sourceUrl);
      const starred = (await localApi("/api/notes", "PATCH", { action: "star", id: second.id, starred: true })).note;
      assert.equal(starred.starred, true);
      assert.equal(starred.content, second.content);
      await assert.rejects(localApi("/api/notes", "PATCH", { action: "star", id: second.id, starred: "yes" }), /星标状态/);
      await assert.rejects(localApi("/api/notes", "DELETE", { id: second.id }), /只能永久删除回收站/);
      const removed = (await localApi("/api/notes", "PATCH", { action: "trash", id: second.id })).note;
      assert.ok(removed.deletedAt);
      await assert.rejects(localApi("/api/notes", "POST", { note: second }), error => error.status === 409 && error.existing.deletedAt === removed.deletedAt);
      assert.equal((await localApi("/api/notes", "POST", { notes: [second] })).skipped, 1);
      const restored = (await localApi("/api/notes", "PATCH", { action: "restore", id: second.id })).note;
      assert.equal(restored.deletedAt, null);
      assert.equal(restored.createdAt, second.createdAt);
      assert.equal(restored.content, second.content);
      assert.deepEqual(restored.tags, second.tags);
      assert.equal(restored.starred, true);
      await localApi("/api/notes", "PATCH", { action: "trash", id: second.id });
      assert.deepEqual(await localApi("/api/notes", "DELETE", { id: second.id, action: "delete" }), { deleted: true });
      assert.deepEqual((await localApi("/api/notes")).notes, [first]);
      await assert.rejects(localApi("/api/notes", "PATCH", { note: second }), error => error.status === 404);
    });
    await t.test("无效导入没有部分写入，也不会让重试重复新增", async () => {
      const factory = new MemoryIndexedDB(); install(factory);
      const imported = draft({ title: "从备份恢复", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_500_000, starred: true });
      await assert.rejects(localApi("/api/notes", "POST", { notes: [imported, draft({ content: "", sourceUrl: "" })] }), /正文或抖音/);
      assert.deepEqual((await localApi("/api/notes")).notes, []);
      const saved = await localApi("/api/notes", "POST", { notes: [imported] });
      assert.equal(saved.notes[0].createdAt, imported.createdAt);
      assert.equal(saved.notes[0].updatedAt, imported.updatedAt);
      assert.equal(saved.notes[0].starred, true);
      const retried = await localApi("/api/notes", "POST", { notes: [imported] });
      assert.equal(retried.skipped, 1);
      assert.deepEqual(retried.notes, []);
      assert.equal((await localApi("/api/notes")).notes.length, 1);
    });
    await t.test("数据库不可用时不假装保存成功，也不会退回远程请求", async () => {
      install(undefined);
      await assert.rejects(localApi("/api/notes", "POST", { note: draft() }), /IndexedDB/);
      await assert.rejects(localApi("/api/notes"), /IndexedDB/);
      install({ open() { throw new DOMException("blocked", "SecurityError"); } });
      await assert.rejects(localApi("/api/notes"), /隐私设置/);
      await assert.rejects(localApi("/other"), error => error.status === 404);
      await assert.rejects(localApi("/api/notes", "PUT", { note: draft() }), error => error.status === 405);
      assert.equal(fetchCalls, 0);
    });
  });
} finally {
  if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
  else delete globalThis.indexedDB;
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
}
