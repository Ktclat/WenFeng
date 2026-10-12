import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Run the actual route, validation, schema, and auth-helper code. Only the
// platform's identity headers and D1 transport are replaced by an in-memory
// SQLite adapter; no HTTP server or external requests are used.
const base = resolve(".sites-runtime/tests");
await mkdir(base,{recursive:true});
const dir = await mkdtemp(resolve(base,"run-"));
async function compile(source,name,replacements={}) {
  let code=await readFile(source,"utf8");
  for(const [from,to] of Object.entries(replacements))code=code.replaceAll(`"${from}"`,`"${to}"`);
  const output=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  await writeFile(resolve(dir,name),output);
}
await writeFile(resolve(dir,"harness.mjs"),`
import {DatabaseSync} from "node:sqlite";
export const sqlite=new DatabaseSync(":memory:");
let currentHeaders=new Headers();
export function setHeaders(values){currentHeaders=new Headers(values);}
export async function headers(){return currentHeaders;}
export function redirect(path){throw new Error("redirect:"+path);}
class Statement {
  constructor(sql,params=[]){this.sql=sql;this.params=params;}
  bind(...params){return new Statement(this.sql,params);}
  async raw(){return sqlite.prepare(this.sql).all(...this.params).map(row=>Object.values(row));}
  async all(){return {results:sqlite.prepare(this.sql).all(...this.params),success:true,meta:{changes:sqlite.prepare("select changes() as count").get().count}};}
  async run(){const result=sqlite.prepare(this.sql).run(...this.params);return {results:[],success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}
}
export const env={DB:{prepare(sql){return new Statement(sql);},async batch(statements){sqlite.exec("BEGIN");try{const results=[];for(const stmt of statements)results.push(await stmt.all());sqlite.exec("COMMIT");return results;}catch(error){sqlite.exec("ROLLBACK");throw error;}}}};
`);
await compile("db/schema.ts","schema.mjs");
await compile("db/index.ts","database.mjs",{"cloudflare:workers":"./harness.mjs","./schema":"./schema.mjs"});
await compile("app/chatgpt-auth.ts","auth.mjs",{"next/headers":"./harness.mjs","next/navigation":"./harness.mjs"});
await compile("app/lib/parse-share.ts","parser.mjs");
await compile("app/lib/validation.ts","validation.mjs",{"./parse-share":"./parser.mjs"});
await compile("app/api/notes/route.ts","notes.mjs",{"../../../db":"./database.mjs","../../../db/schema":"./schema.mjs","../../chatgpt-auth":"./auth.mjs","../../lib/validation":"./validation.mjs","../../lib/parse-share":"./parser.mjs"});
await compile("app/api/parse/route.ts","parse.mjs",{"../../chatgpt-auth":"./auth.mjs","../../lib/validation":"./validation.mjs","../../lib/parse-share":"./parser.mjs"});
const {sqlite,setHeaders}=await import(pathToFileURL(resolve(dir,"harness.mjs")));
sqlite.exec(await readFile("drizzle/0000_orange_invaders.sql","utf8"));
const routes=await import(pathToFileURL(resolve(dir,"notes.mjs")));
const parseRoute=await import(pathToFileURL(resolve(dir,"parse.mjs")));
function identity(name){setHeaders(name?{"oai-authenticated-user-id":`qa-${name}`,"oai-authenticated-user-email":`${name}@example.test`}:{});}
function note(overrides={}){return {id:crypto.randomUUID(),title:"一段值得重读的文字",content:"慢慢来，也很快。",author:"",sourceUrl:"",originalShare:"",category:"生活感悟",tags:["生活"],starred:false,status:"manual",...overrides};}
function req(method,body,origin="https://wenfeng.test"){return new Request("https://wenfeng.test/api/notes",{method,headers:{"content-type":"application/json","origin":origin},body:JSON.stringify(body)});}
async function perform(method,body,origin){const response=await routes[method](method==="GET"?undefined:req(method,body,origin));return {status:response.status,data:await response.json()};}
let saved;

await test("收藏 API 的持久化、身份隔离、去重与可恢复删除",async t=>{
  await t.test("未登录不可读取或创建",async()=>{identity(null);assert.equal((await perform("GET")).status,401);assert.equal((await perform("POST",{note:note()})).status,401);});
  await t.test("拒绝跨站写入",async()=>{identity("alice");assert.equal((await perform("POST",{note:note()},"https://elsewhere.test")).status,403);});
  await t.test("新建并从真实 SQLite 重新读取",async()=>{identity("alice");const result=await perform("POST",{note:note()});assert.equal(result.status,201);saved=result.data.notes[0];const read=await perform("GET");assert.equal(read.data.notes.length,1);assert.equal(read.data.notes[0].content,"慢慢来，也很快。");assert.equal("userId" in read.data.notes[0],false);assert.deepEqual(read.data.notes[0].tags,["生活"]);});
  await t.test("另一个账号看不到也改不了收藏",async()=>{identity("bob");assert.deepEqual((await perform("GET")).data.notes,[]);assert.equal((await perform("PATCH",{action:"star",id:saved.id,starred:true})).status,404);assert.equal((await perform("PATCH",{action:"trash",id:saved.id})).status,404);identity("alice");});
  await t.test("星标只更新星标，正文不变",async()=>{const result=await perform("PATCH",{action:"star",id:saved.id,starred:true});assert.equal(result.status,200);assert.equal(result.data.note.starred,true);assert.equal(result.data.note.content,saved.content);saved=result.data.note;});
  await t.test("编辑可保存中文、换行与原样文本",async()=>{const result=await perform("PATCH",{note:{...saved,content:"第一行\n<script>这里只是文字</script>\n第二行",tags:["新标签"]}});assert.equal(result.status,200);assert.equal(result.data.note.content,"第一行\n<script>这里只是文字</script>\n第二行");saved=result.data.note;});
  await t.test("相同记录 ID 不重复创建",async()=>{const result=await perform("POST",{note:saved});assert.equal(result.status,409);assert.equal(result.data.note.id,saved.id);});
  await t.test("抖音作品不同地址写法可以去重",async()=>{const first=await perform("POST",{note:note({title:"有原文的收藏",sourceUrl:"https://www.douyin.com/video/7000000000000000001?from=share"})});assert.equal(first.status,201);const second=await perform("POST",{note:note({sourceUrl:"https://www.douyin.com/?modal_id=7000000000000000001"})});assert.equal(second.status,409);assert.equal(second.data.note.id,first.data.notes[0].id);});
  await t.test("编辑同样阻止重复来源",async()=>{const result=await perform("PATCH",{note:{...saved,sourceUrl:"https://www.douyin.com/video/7000000000000000001"}});assert.equal(result.status,409);assert.equal((await perform("GET")).data.notes.find(n=>n.id===saved.id).sourceUrl,"");});
  await t.test("拒绝伪造域名和无正文无来源的条目",async()=>{assert.equal((await perform("POST",{note:note({sourceUrl:"https://v.douyin.com.evil.test/foo"})})).status,400);assert.equal((await perform("POST",{note:note({content:"",sourceUrl:""})})).status,400);});
  await t.test("链接收藏保留空正文并标成待整理",async()=>{const result=await perform("POST",{note:note({title:"链接收藏",content:"",sourceUrl:"https://v.douyin.com/AbCdEf12/",status:"share"})});assert.equal(result.status,201);assert.equal(result.data.notes[0].status,"link");assert.equal(result.data.notes[0].content,"");});
  await t.test("纯抖音口令经过真实解析和保存 API，按口令区分并可恢复",async()=>{
    const original="9:/ 10/12 g@b.nd 长按复制此条消息，打开抖音查看精彩内容##onSv5CKloZ8##[抖音口令]";
    const parsed=await parseRoute.POST(req("POST",{text:original}));
    assert.equal(parsed.status,200);
    const result=await parsed.json();
    assert.equal(result.status,"link");assert.equal(result.content,"");assert.equal(result.sourceUrl,"");
    const created=await perform("POST",{note:note(result)});
    assert.equal(created.status,201);
    const tokenNote=created.data.notes[0];
    assert.equal(tokenNote.originalShare,original);
    const duplicate=await perform("POST",{note:note({...result,title:"另一个标题",originalShare:"##onSv5CKloZ8##[抖音口令]"})});
    assert.equal(duplicate.status,409);assert.equal(duplicate.data.note.id,tokenNote.id);
    const different=await perform("POST",{note:note({...result,originalShare:"##tbK5XPeYG99##[抖音口令]"})});
    assert.equal(different.status,201);
    const conflict=await perform("PATCH",{note:{...different.data.notes[0],originalShare:"##onSv5CKloZ8##[抖音口令]"}});
    assert.equal(conflict.status,409);assert.equal(conflict.data.note.id,tokenNote.id);
    await perform("PATCH",{action:"trash",id:tokenNote.id});
    const restored=await perform("PATCH",{action:"restore",id:tokenNote.id});
    assert.equal(restored.data.note.originalShare,original);assert.equal(restored.data.note.deletedAt,null);
    assert.equal((await perform("POST",{notes:[tokenNote]})).data.skipped,1);
    const edited=await perform("PATCH",{note:{...restored.data.note,content:"为口令补上的正文。"}});
    assert.equal(edited.status,200);assert.equal(edited.data.note.status,"manual");
    const pastedAgain=note({...result,title:"重新粘贴的口令",originalShare:"##onSv5CKloZ8##[抖音口令]"});
    const afterText=await perform("POST",{note:pastedAgain});
    assert.equal(afterText.status,409);assert.equal(afterText.data.note.id,tokenNote.id);
    const ordinaryDuplicate=await perform("POST",{note:note({title:edited.data.note.title,content:edited.data.note.content})});
    assert.equal(ordinaryDuplicate.status,409);assert.equal(ordinaryDuplicate.data.note.id,tokenNote.id);
    const linked=await perform("PATCH",{note:{...edited.data.note,sourceUrl:"https://www.douyin.com/note/7000000000000000088"}});
    assert.equal(linked.status,200);
    const afterLink=await perform("POST",{note:pastedAgain});
    assert.equal(afterLink.status,409);assert.equal(afterLink.data.note.id,tokenNote.id);
    assert.equal((await perform("POST",{notes:[pastedAgain]})).data.skipped,1);
  });
  await t.test("活动收藏不能被直接永久删除",async()=>{assert.equal((await perform("DELETE",{id:saved.id})).status,404);});
  await t.test("删除再恢复保留正文、标签与 ID",async()=>{const removed=await perform("PATCH",{action:"trash",id:saved.id});assert.equal(removed.status,200);assert.ok(removed.data.note.deletedAt);assert.equal(removed.data.note.content,saved.content);const restored=await perform("PATCH",{action:"restore",id:saved.id});assert.equal(restored.data.note.deletedAt,null);assert.equal(restored.data.note.id,saved.id);assert.deepEqual(restored.data.note.tags,saved.tags);});
  await t.test("导入跳过重复并保留时间与星标",async()=>{const item=note({title:"从备份回来的文字",content:"这是备份中的正文",createdAt:1700000000000,updatedAt:1700000500000,starred:true});const result=await perform("POST",{notes:[saved,item]});assert.equal(result.status,201);assert.equal(result.data.skipped,1);assert.equal(result.data.notes.length,1);assert.equal(result.data.notes[0].createdAt,1700000000000);assert.equal(result.data.notes[0].starred,true);});
  await t.test("批量导入有无效项时不写入任何条目",async()=>{const before=(await perform("GET")).data.notes.length;const result=await perform("POST",{notes:[note({title:"不应被写入"}),note({title:""})]});assert.equal(result.status,400);assert.equal((await perform("GET")).data.notes.length,before);});
  await t.test("回收站中的收藏可永久删除",async()=>{await perform("PATCH",{action:"trash",id:saved.id});identity("bob");assert.equal((await perform("DELETE",{id:saved.id})).status,404);identity("alice");assert.equal((await perform("DELETE",{id:saved.id})).status,200);assert.equal((await perform("GET")).data.notes.some(n=>n.id===saved.id),false);});
});

await test("抖音解析 API 的远程边界与部分成功路径",async t=>{
  const nativeFetch=globalThis.fetch;
  try{
    identity("alice");
    await t.test("含文案的分享不发起额外远程读取",async()=>{let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("unexpected fetch");};const response=await parseRoute.POST(req("POST",{text:"6.52 复制打开抖音，看看【阿青的作品】把日子过成喜欢的样子。 #生活 https://v.douyin.com/AbCdEf12/ n@Q.uL 10/13 yUI:/"}));const result=await response.json();assert.equal(response.status,200);assert.equal(result.status,"share");assert.equal(result.author,"阿青");assert.equal(result.content,"把日子过成喜欢的样子。 #生活");assert.equal(calls,0);});
    await t.test("限制页面可以只收藏链接",async()=>{globalThis.fetch=async()=>new Response("Denied",{status:403});const response=await parseRoute.POST(req("POST",{text:"https://v.douyin.com/AbCdEf12/"}));const result=await response.json();assert.equal(result.status,"link");assert.equal(result.content,"");assert.match(result.notice,/没有读到/);});
    await t.test("重定向到白名单外时停止读取",async()=>{let calls=0;globalThis.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{location:"https://elsewhere.test/private"}});};const response=await parseRoute.POST(req("POST",{text:"https://v.douyin.com/AbCdEf12/"}));assert.equal((await response.json()).status,"link");assert.equal(calls,1);});
    await t.test("公开页元信息作为节选显示",async()=>{globalThis.fetch=async()=>new Response('<meta property="og:description" content="屋檐下的雨声，让傍晚慢了下来。"><meta property="og:title" content="雨后 - 抖音">',{headers:{"content-type":"text/html"}});const response=await parseRoute.POST(req("POST",{text:"https://www.douyin.com/video/7000000000000000001"}));const result=await response.json();assert.equal(result.status,"page");assert.equal(result.title,"雨后");assert.match(result.notice,/节选/);});
    await t.test("直接作品重定向到另一作品时保留原链接",async()=>{let calls=0;globalThis.fetch=async()=>{calls++;return calls===1?new Response(null,{status:302,headers:{location:"https://www.douyin.com/video/7000000000000000099"}}):new Response('<meta name="description" content="另一篇文章">',{headers:{"content-type":"text/html"}});};const response=await parseRoute.POST(req("POST",{text:"https://www.douyin.com/video/7000000000000000001"}));const result=await response.json();assert.equal(result.status,"link");assert.equal(result.sourceUrl,"https://www.douyin.com/video/7000000000000000001");});
    await t.test("未登录不能进行远程解析",async()=>{identity(null);assert.equal((await parseRoute.POST(req("POST",{text:"https://v.douyin.com/AbCdEf12/"}))).status,401);});
  }finally{globalThis.fetch=nativeFetch;}
});

sqlite.close();
await rm(dir,{recursive:true,force:true});
