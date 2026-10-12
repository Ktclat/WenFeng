import { and, desc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../../../db";
import { notes } from "../../../db/schema";
import { getChatGPTUser } from "../../chatgpt-auth";
import { checkOrigin, noteInput, readBody } from "../../lib/validation";
import { douyinUrl, shareTokenKey, sourceKey, textContentKey } from "../../lib/parse-share";

export const dynamic = "force-dynamic";
type Row = typeof notes.$inferSelect;
function present(row: Row) {
  const { userId: _userId, tags, ...other } = row;
  let decoded: string[] = [];
  try { decoded = JSON.parse(tags); } catch { /* Treat malformed stored tags as empty. */ }
  return {...other, tags:decoded};
}
function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= Date.now() ? value : fallback;
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({error:"请登录后查看收藏。"}, {status:401});
  try {
    const rows = await getDb().select().from(notes).where(eq(notes.userId,user.userId)).orderBy(desc(notes.updatedAt));
    return Response.json({notes:rows.map(present)}, {headers:{"cache-control":"private, no-store"}});
  } catch { return Response.json({error:"收藏暂时加载失败，请稍后重试。"}, {status:503}); }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({error:"请登录后保存收藏。"}, {status:401});
  if (!checkOrigin(request)) return Response.json({error:"请在文风页面内操作。"}, {status:403});
  try {
    const body = await readBody(request, 4000000);
    const isImport = Array.isArray(body.notes);
    const items: unknown[] = isImport ? body.notes : [body.note];
    if (!items.length || items.length > 500) return Response.json({error:"每次可导入 1–500 条收藏。"}, {status:400});
    const parsed = items.map(item => noteInput.safeParse(item));
    const invalid = parsed.find(result => !result.success);
    if (invalid && !invalid.success) return Response.json({error:invalid.error.issues[0]?.message || "收藏格式不正确。"}, {status:400});
    const db = getDb();
    const existing = await db.select().from(notes).where(eq(notes.userId,user.userId));
    const added: Row[] = [];
    let skipped = 0;
    for (let index=0; index<parsed.length; index++) {
      const result = parsed[index];
      if (!result.success) continue;
      const note = result.data;
      const canonical = note.sourceUrl ? douyinUrl(note.sourceUrl)! : "";
      const token = shareTokenKey(note.originalShare);
      const text = textContentKey(note);
      const duplicate = [...existing,...added].find(n => n.id === note.id || (token && shareTokenKey(n.originalShare) === token) || (canonical && n.sourceUrl && sourceKey(n.sourceUrl) === sourceKey(canonical)) || (!canonical && textContentKey(n) === text));
      if (duplicate) {
        if (isImport) { skipped++; continue; }
        return Response.json({error:duplicate.deletedAt ? "这条内容在回收站里，可以恢复收藏。" : "这条内容已经收藏过了。",note:present(duplicate)}, {status:409});
      }
      const now = Date.now();
      const raw = items[index] as Record<string,unknown>;
      added.push({...note, userId:user.userId, sourceUrl:canonical, tags:JSON.stringify([...new Set(note.tags)]),status:note.content.trim() ? (note.status === "link" ? "manual" : note.status) : "link", createdAt:isImport ? timestamp(raw.createdAt,now) : now,updatedAt:isImport ? timestamp(raw.updatedAt,now) : now,deletedAt:null});
    }
    if (existing.length + added.length > 5000) return Response.json({error:"收藏与回收站共达到 5,000 条。请先导出备份，再永久删除回收站中不再需要的内容。"}, {status:400});
    if (added.length) {
      const statements = added.map(row => db.insert(notes).values(row));
      await db.batch(statements as [typeof statements[number], ...Array<typeof statements[number]>]);
    }
    return Response.json({notes:added.map(present), skipped}, {status:201,headers:{"cache-control":"no-store"}});
  } catch (error) {
    const message = error instanceof Error && /JSON|内容太大|格式不正确|没有收到/.test(error.message) ? error.message : "保存没有完成，请保留当前内容后重试。";
    return Response.json({error:message}, {status:400});
  }
}

export async function PATCH(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({error:"请登录后修改收藏。"}, {status:401});
  if (!checkOrigin(request)) return Response.json({error:"请在文风页面内操作。"}, {status:403});
  try {
    const body = await readBody(request, 400000);
    const db = getDb();
    if (body.action === "trash" || body.action === "restore" || body.action === "star") {
      if (typeof body.id !== "string") return Response.json({error:"没有找到这条收藏。"}, {status:400});
      if (body.action === "star" && typeof body.starred !== "boolean") return Response.json({error:"星标状态不正确。"}, {status:400});
      const changes = body.action === "star" ? {starred:body.starred,updatedAt:Date.now()} : {deletedAt:body.action === "trash" ? Date.now() : null,updatedAt:Date.now()};
      const result = await db.update(notes).set(changes).where(and(eq(notes.id,body.id),eq(notes.userId,user.userId))).returning();
      if (!result[0]) return Response.json({error:"没有找到这条收藏。"}, {status:404});
      return Response.json({note:present(result[0])});
    }
    const parsed = noteInput.safeParse(body.note);
    if (!parsed.success) return Response.json({error:parsed.error.issues[0]?.message || "请检查填写的内容。"}, {status:400});
    const {id,...note} = parsed.data;
    const canonical = note.sourceUrl ? douyinUrl(note.sourceUrl)! : "";
    const token = shareTokenKey(note.originalShare);
    const text = textContentKey(note);
    const existing = await db.select().from(notes).where(eq(notes.userId,user.userId));
    const conflict = existing.find(n=>n.id!==id&&((token&&shareTokenKey(n.originalShare)===token)||(canonical&&n.sourceUrl&&sourceKey(n.sourceUrl)===sourceKey(canonical))||(!canonical&&textContentKey(n)===text)));
    if(conflict)return Response.json({error:"另有一条相同来源或内容的收藏，请修改来源或查看已有收藏。",note:present(conflict)}, {status:409});
    const rows = await db.update(notes).set({...note,sourceUrl:note.sourceUrl ? douyinUrl(note.sourceUrl)! : "",tags:JSON.stringify([...new Set(note.tags)]),status:note.content.trim() ? (note.status === "link" ? "manual" : note.status) : "link",updatedAt:Date.now()}).where(and(eq(notes.id,id),eq(notes.userId,user.userId))).returning();
    if (!rows[0]) return Response.json({error:"没有找到这条收藏。"}, {status:404});
    return Response.json({note:present(rows[0])});
  } catch { return Response.json({error:"修改没有完成，内容已保留，请重试。"}, {status:400}); }
}

export async function DELETE(request:Request) {
  const user=await getChatGPTUser();
  if(!user)return Response.json({error:"请登录后操作。"},{status:401});
  if(!checkOrigin(request))return Response.json({error:"请在文风页面内操作。"},{status:403});
  try {
    const body=await readBody(request,10000);
    if(typeof body.id!=="string")return Response.json({error:"没有找到这条收藏。"},{status:400});
    const result=await getDb().delete(notes).where(and(eq(notes.id,body.id),eq(notes.userId,user.userId),isNotNull(notes.deletedAt))).returning();
    if(!result[0])return Response.json({error:"只能永久删除回收站中的收藏。"},{status:404});
    return Response.json({deleted:true});
  }catch{return Response.json({error:"删除未完成，请稍后重试。"},{status:400});}
}
