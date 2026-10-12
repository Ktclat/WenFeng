"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, Bookmark, Check, ChevronDown, Clipboard, Cloud, Code2, Copy, ExternalLink, FileJson, FileText, Folder, HardDrive, HelpCircle, LayoutGrid, Leaf, Link2, List, Loader2, Menu, Moon, MoreHorizontal, PenLine, Plus, RotateCcw, Search, ShieldCheck, Sparkles, Star, Sun, Tag, Trash2, Upload, X } from "lucide-react";
import { CATEGORIES, STATUS_LABELS } from "./lib/types";
import type { ApiReply, Draft, Note, ParseResult } from "./lib/types";
import { douyinUrl, extractTags, isUnresolvedShareToken, makeTitle, shareTokenKey, sourceKey, textContentKey } from "./lib/parse-share";
import { noteInput } from "./lib/validation";
import { localApi } from "./lib/local-api";

const SAMPLES = [
  {title:"把生活调成自己喜欢的频道",content:"不必把每一天都过成标准答案。\n\n留一点时间给散步，给晚风，给那些没有目的却让你开心的小事。\n\n日子是自己的，慢一点也没关系。",category:"生活感悟",tags:["慢生活","生活碎片"],tone:"sage"},
  {title:"成长，是把目光慢慢收回来",content:"不再急着让所有人理解，也不再借别人的掌声确认自己。\n\n把力气花在真正想做的事上，把心安放在自己的节奏里。",category:"自我成长",tags:["成长","内心秩序"],tone:"sand"},
  {title:"一些小小的、确切的喜欢",content:"喜欢雨后路面的倒影，喜欢旧书里突然掉落的纸片。\n\n喜欢一句话，在很久以后，仍能轻轻接住某个时刻的自己。",category:"浪漫诗意",tags:["文字","浪漫日常"],tone:"rose"},
];
type EditorState = {draft:Draft;isNew:boolean;notice:string;tagText:string;initial:string;sample:boolean};
type ImportPreview = {notes:Note[];total:number;duplicates:number;filename:string};
const DATE_FORMAT = new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"});
function dateText(timestamp:number) { return DATE_FORMAT.format(new Date(timestamp)); }
function toDraft(note:Note):Draft { const {createdAt:_createdAt,updatedAt:_updatedAt,deletedAt:_deletedAt,...draft}=note; return draft; }
function draftFingerprint(draft:Draft,tagText:string) { return JSON.stringify({draft,tagText}); }
function blankDraft(content=""):Draft { return {id:crypto.randomUUID(),title:content ? makeTitle(content) : "",content,author:"",sourceUrl:"",originalShare:"",category:"未分类",tags:extractTags(content),starred:false,status:"manual"}; }
function tokenOnly(note:Pick<Note,"content"|"sourceUrl"|"originalShare">) { return !note.content.trim()&&!note.sourceUrl&&isUnresolvedShareToken(note.originalShare); }
function downloadFile(name:string,body:string,mime:string) {
  const url=URL.createObjectURL(new Blob([body],{type:mime}));
  const a=document.createElement("a"); a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}
async function cloudApi<T=ApiReply>(path:string,method="GET",body?:unknown):Promise<T> {
  let response:Response;
  try { response=await fetch(path,{method,credentials:"same-origin",headers:body ? {"content-type":"application/json"} : {},body:body ? JSON.stringify(body) : undefined}); }
  catch { throw new Error("网络暂时没有连接，请保留内容后重试。"); }
  let result: {error?:string;note?:Note};
  try { result=await response.json() as {error?:string;note?:Note}; } catch { throw new Error("暂时没有收到有效响应，请刷新登录状态后重试。"); }
  if (!response.ok) { const error=new Error(result.error || "操作没有完成，请稍后重试。") as Error & {existing?:Note};error.existing=result.note;throw error; }
  return result as T;
}

function Dialog({title,onClose,children,wide=false,side=false,feedback}:{title:string;onClose:()=>void;children:ReactNode;wide?:boolean;side?:boolean;feedback?:string}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;dialog?.showModal();const old=document.body.style.overflow;document.body.style.overflow="hidden";return()=>{dialog?.close();document.body.style.overflow=old;};},[]);
  return <dialog ref={ref} className={`dialog ${wide?"dialog-wide":""} ${side?"dialog-side":""}`} aria-label={title} onCancel={event=>{event.preventDefault();onClose();}}>
    <div className="dialog-heading"><div className="dialog-eyebrow"><Bookmark size={15}/><span>文风 · {title}</span></div><button className="icon-button" aria-label="关闭窗口" onClick={onClose}><X size={20}/></button></div>
    {feedback&&<div className="dialog-feedback" role="status"><HelpCircle size={15}/><span>{feedback}</span></div>}
    {children}
  </dialog>;
}

export default function Notebook({authenticated,displayName,storageMode="cloud",basePath="/"}:{authenticated:boolean;displayName:string;storageMode?:"cloud"|"local";basePath?:string}) {
  const localMode=storageMode==="local";
  const api=localMode?localApi:cloudApi;
  const [theme,setTheme]=useState<"light"|"dark">("light");
  const [notes,setNotes]=useState<Note[]>([]);
  const [loading,setLoading]=useState(true);
  const [loadError,setLoadError]=useState("");
  const [filter,setFilter]=useState("all");
  const [query,setQuery]=useState("");
  const [sort,setSort]=useState("created");
  const [layout,setLayout]=useState("list");
  const [inputMode,setInputMode]=useState<"share"|"text">("share");
  const [shareInput,setShareInput]=useState("");
  const [parsing,setParsing]=useState(false);
  const [inputError,setInputError]=useState("");
  const [editor,setEditor]=useState<EditorState|null>(null);
  const [editorError,setEditorError]=useState("");
  const [duplicate,setDuplicate]=useState<Note|null>(null);
  const [readerId,setReaderId]=useState<string|null>(null);
  const [helpOpen,setHelpOpen]=useState(false);
  const [exportOpen,setExportOpen]=useState(false);
  const [importPreview,setImportPreview]=useState<ImportPreview|null>(null);
  const [importError,setImportError]=useState("");
  const [saving,setSaving]=useState(false);
  const [busyIds,setBusyIds]=useState<Set<string>>(new Set());
  const [menuOpen,setMenuOpen]=useState(false);
  const [toast,setToast]=useState<{message:string;undoId?:string}|null>(null);
  const sidebarRef=useRef<HTMLElement>(null);
  const textareaRef=useRef<HTMLTextAreaElement>(null);
  const searchRef=useRef<HTMLInputElement>(null);
  const fileRef=useRef<HTMLInputElement>(null);

  useEffect(()=>{
    let initial:"light"|"dark"="light";
    try {if(localStorage.getItem("wenfeng-theme")==="dark")initial="dark";} catch { /* Theme changes still work without browser storage. */ }
    setTheme(initial);document.documentElement.dataset.theme=initial;
  },[]);
  function toggleTheme() {
    const next=theme==="light"?"dark":"light";
    setTheme(next);document.documentElement.dataset.theme=next;
    try {localStorage.setItem("wenfeng-theme",next);} catch { /* The selected theme lasts for this session. */ }
  }

  const load=useCallback(async()=>{
    setLoading(true);setLoadError("");
    try { const result=await api("/api/notes");setNotes(result.notes); }
    catch(error) {setLoadError(error instanceof Error ? error.message : "加载失败，请重试。");}
    finally {setLoading(false);}
  },[api]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),6500);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{if(editor||readerId||helpOpen||exportOpen||importPreview)setToast(null);},[!!editor,readerId,helpOpen,exportOpen,!!importPreview]);
  useEffect(()=>{
    if(!menuOpen)return;
    const previous=document.activeElement as HTMLElement|null;
    const sidebar=sidebarRef.current;
    const nodes=()=>Array.from(sidebar?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')||[]);
    nodes()[0]?.focus();
    const handleKey=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){event.preventDefault();setMenuOpen(false);return;}
      if(event.key!=="Tab")return;
      const focusable=nodes(),first=focusable[0],last=focusable[focusable.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener("keydown",handleKey);
    return()=>{document.removeEventListener("keydown",handleKey);previous?.focus();};
  },[menuOpen]);
  const editorDirty=!!editor && (draftFingerprint(editor.draft,editor.tagText)!==editor.initial || (editor.isNew&&!editor.sample&&!!(editor.draft.content||editor.draft.sourceUrl)));
  useEffect(()=>{
    const beforeUnload=(event:BeforeUnloadEvent)=>{if(editorDirty||shareInput.trim()){event.preventDefault();event.returnValue="";}};
    window.addEventListener("beforeunload",beforeUnload);return()=>window.removeEventListener("beforeunload",beforeUnload);
  },[editorDirty,shareInput]);
  useEffect(()=>{
    const keydown=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"&&!editor&&!readerId&&!helpOpen&&!exportOpen&&!importPreview){event.preventDefault();searchRef.current?.focus();}};
    window.addEventListener("keydown",keydown);return()=>window.removeEventListener("keydown",keydown);
  },[editor,readerId,helpOpen,exportOpen,importPreview]);

  const active=notes.filter(note=>!note.deletedAt);
  const stars=active.filter(note=>note.starred);
  const pending=active.filter(note=>!note.content.trim());
  const trash=notes.filter(note=>note.deletedAt);
  const categories=Array.from(new Set([...CATEGORIES,...active.map(note=>note.category)]));
  const reader=notes.find(note=>note.id===readerId);
  const filtered=useMemo(()=>{
    const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return notes.filter(note=>{
      if(filter==="trash" ? !note.deletedAt : !!note.deletedAt)return false;
      if(filter==="starred"&&!note.starred)return false;
      if(filter==="pending"&&note.content.trim())return false;
      if(filter.startsWith("category:")&&note.category!==filter.slice(9))return false;
      const haystack=[note.title,note.content,note.author,note.category,note.sourceUrl,note.originalShare,...note.tags].join(" ").toLocaleLowerCase();
      return terms.every(term=>haystack.includes(term));
    }).sort((a,b)=>sort==="updated"?b.updatedAt-a.updatedAt:sort==="oldest"?a.createdAt-b.createdAt:b.createdAt-a.createdAt);
  },[notes,filter,query,sort]);
  const currentTitle=filter==="all"?"我的收藏":filter==="starred"?"星标文字":filter==="pending"?"待整理":filter==="trash"?"回收站":filter.slice(9);
  const collectionWords=active.reduce((sum,note)=>sum+note.content.replace(/\s/g,"").length,0);

  function openEditor(draft:Draft,isNew:boolean,notice="",sample=false) {
    const tagText=draft.tags.join("，");setEditor({draft,isNew,notice,tagText,initial:draftFingerprint(draft,tagText),sample});setEditorError("");setDuplicate(null);setReaderId(null);
  }
  function closeEditor() {
    if(saving)return;
    if(editorDirty&&!window.confirm("还有未保存的内容，确定关闭吗？"))return;
    setEditor(null);setEditorError("");setDuplicate(null);
  }
  function changeDraft<K extends keyof Draft>(key:K,value:Draft[K]) {setEditor(current=>current?{...current,draft:{...current.draft,[key]:value,...(key==="content"?{status:String(value).trim()?"manual" as const:"link" as const}:{})}}:null);}
  function chooseFilter(value:string) {setFilter(value);setQuery("");setMenuOpen(false);}
  function focusCapture() {setMenuOpen(false);window.scrollTo({top:0,behavior:"smooth"});setTimeout(()=>textareaRef.current?.focus(),150);}
  function showSample(index=0) {
    const sample=SAMPLES[index];openEditor({...blankDraft(sample.content),title:sample.title,category:sample.category,tags:sample.tags,author:"文风示例"},true,"这是原创演示文字，不是从抖音提取的内容。点击保存后才会加入你的收藏。",true);
  }
  async function pasteClipboard() {
    try {const text=await navigator.clipboard.readText();setShareInput(text);setInputError("");textareaRef.current?.focus();}
    catch {setInputError("浏览器没有允许读取剪贴板，请在输入框中长按粘贴，或按 Ctrl / ⌘ + V。");textareaRef.current?.focus();}
  }
  async function parseInput() {
    if(!shareInput.trim()||parsing)return;
    setInputError("");
    if(inputMode==="text") {openEditor(blankDraft(shareInput.trim()),true,"这是你手动摘录的文字。可以补充标题、来源与分类后收藏。");return;}
    setParsing(true);
    try {
      const result:ParseResult=await api<ParseResult>("/api/parse","POST",{text:shareInput});
      const {notice,...fields}=result;openEditor({...blankDraft(),...fields},true,notice);
    } catch(error) {setInputError(error instanceof Error?error.message:"提取没有完成，请再试一次。");}
    finally {setParsing(false);}
  }
  function upsert(note:Note) {setNotes(current=>[note,...current.filter(item=>item.id!==note.id)]);}
  async function saveEditor() {
    if(!editor||saving)return;
    const tags=Array.from(new Set(editor.tagText.split(/[，,、#\n]/u).map(t=>t.trim()).filter(Boolean)));
    const draft={...editor.draft,category:editor.draft.category.trim()||"未分类",tags};
    const validation=noteInput.safeParse(draft);
    if(!validation.success){setEditorError(validation.error.issues[0]?.message||"请检查填写的内容。");return;}
    setSaving(true);setEditorError("");setDuplicate(null);
    try {
      const result=await api("/api/notes",editor.isNew?"POST":"PATCH",{note:draft});
      const note:Note=editor.isNew?result.notes[0]:result.note;upsert(note);
      setToast({message:editor.isNew?(tokenOnly(note)?"口令已保存，可在「待整理」中补充正文。":"收藏已保存。"):"修改已保存。"});
      setEditor(null);setShareInput("");setQuery("");setFilter("all");
    } catch(error) {setEditorError(error instanceof Error?error.message:"保存失败，内容已保留。");if((error as Error&{existing?:Note}).existing)setDuplicate((error as Error&{existing?:Note}).existing!);}
    finally {setSaving(false);}
  }
  async function updateAction(note:Note,action:"star"|"trash"|"restore"|"delete") {
    if(busyIds.has(note.id))return;
    if(action==="delete"&&!window.confirm(`永久删除《${note.title}》？这条收藏将无法恢复。`))return;
    setBusyIds(current=>new Set([...current,note.id]));
    try {
      const result=await api("/api/notes",action==="delete"?"DELETE":"PATCH",{id:note.id,action,starred:!note.starred});
      if(action==="delete"){setNotes(current=>current.filter(n=>n.id!==note.id));setReaderId(null);setToast({message:"已永久删除这条收藏。"});return;}
      upsert(result.note);
      if(action==="trash"){setReaderId(null);setToast({message:"已移入回收站，随时可以恢复。",undoId:note.id});}
      if(action==="restore"){setToast({message:"已恢复到收藏。"});setReaderId(null);}
    } catch(error) {setToast({message:error instanceof Error?error.message:"操作没有完成，请重试。"});}
    finally {setBusyIds(current=>{const next=new Set(current);next.delete(note.id);return next;});}
  }
  async function copyContent(content:string) {
    try {await navigator.clipboard.writeText(content);setToast({message:"文字已复制。"});}
    catch {setToast({message:"浏览器暂不允许自动复制，可以选中文字后复制。"});}
  }
  function exportNotes(kind:"json"|"markdown") {
    const date=new Date().toISOString().slice(0,10);
    if(kind==="json")downloadFile(`wenfeng-backup-${date}.json`,JSON.stringify({format:"wenfeng",version:1,exportedAt:new Date().toISOString(),notes:active},null,2),"application/json;charset=utf-8");
    else {
      const escape=(value:string)=>value.replace(/[\\`*_{}\[\]<>#]/g,"\\$&").replace(/\n/g," ");
      const body=active.map(note=>{
        const fence="`".repeat(Math.max(3,...Array.from(note.originalShare.matchAll(/`+/g),match=>match[0].length+1)));
        const pendingToken=tokenOnly(note)?`待解析的抖音口令（尚未获得正文）：\n\n${fence}text\n${note.originalShare}\n${fence}`:"（暂未补充正文）";
        return `## ${escape(note.title)}\n\n${note.content||pendingToken}\n\n${note.author?`作者 / 备注：${escape(note.author)}  \n`:""}分类：${escape(note.category)}  \n${note.tags.length?`标签：${note.tags.map(escape).join(" · ")}  \n`:""}收藏日期：${dateText(note.createdAt)}  \n${note.sourceUrl?`[抖音原文](${note.sourceUrl})\n`:""}`;
      }).join("\n---\n\n");
      downloadFile(`wenfeng-collection-${date}.md`,`# 文风 · 文字收藏\n\n共 ${active.length} 条收藏\n\n${body}`,"text/markdown;charset=utf-8");
    }
    setExportOpen(false);setToast({message:kind==="json"?"备份文件已生成，可用于恢复收藏。":"文字集已生成。"});
  }
  async function readBackup(file:File) {
    setImportError("");
    try {
      if(file.size>20000000)throw new Error("备份文件超过 20 MB，请拆分后导入。");
      const data=JSON.parse(await file.text());
      if(data.format!=="wenfeng"||data.version!==1||!Array.isArray(data.notes))throw new Error("请选择文风导出的 JSON 备份文件（格式版本 1）。");
      if(!data.notes.length||data.notes.length>5000)throw new Error("备份应包含 1–5,000 条收藏。");
      const prepared:Note[]=[];let duplicates=0;
      for(let i=0;i<data.notes.length;i++){
        const raw=data.notes[i];const result=noteInput.safeParse(raw);
        if(!result.success)throw new Error(`第 ${i+1} 条收藏格式不正确：${result.error.issues[0]?.message||"字段缺失"}。未导入任何内容。`);
        const canonical=result.data.sourceUrl?douyinUrl(result.data.sourceUrl)!:"";
        const token=shareTokenKey(result.data.originalShare);
        const existing=[...notes,...prepared].some(note=>note.id===result.data.id||(token&&shareTokenKey(note.originalShare)===token)||(canonical&&note.sourceUrl&&sourceKey(note.sourceUrl)===sourceKey(canonical))||(!canonical&&textContentKey(note)===textContentKey(result.data)));
        if(existing){duplicates++;continue;}
        prepared.push({...result.data,sourceUrl:canonical,createdAt:typeof raw.createdAt==="number"?raw.createdAt:Date.now(),updatedAt:typeof raw.updatedAt==="number"?raw.updatedAt:Date.now(),deletedAt:null});
      }
      setExportOpen(false);setImportPreview({notes:prepared,total:data.notes.length,duplicates,filename:file.name});
    } catch(error) {setToast({message:error instanceof SyntaxError?"文件不是有效的 JSON，现有收藏没有变化。":error instanceof Error?error.message:"读取文件失败。"});}
  }
  async function importBackup() {
    if(!importPreview||saving)return;setSaving(true);setImportError("");
    let imported=0,skipped=0;
    try {
      let index=0;
      while(index<importPreview.notes.length){
        const batch:Note[]=[];let bytes=0;
        while(index<importPreview.notes.length&&batch.length<100){
          const note=importPreview.notes[index];const size=new TextEncoder().encode(JSON.stringify(note)).length;
          if(batch.length&&bytes+size>2500000)break;
          batch.push(note);bytes+=size;index++;
        }
        const result=await api("/api/notes","POST",{notes:batch});imported+=result.notes.length;skipped+=result.skipped;
      }
      await load();setImportPreview(null);setFilter("all");setQuery("");setToast({message:`已导入 ${imported} 条收藏${skipped?`，跳过 ${skipped} 条重复内容`:""}。`});
    } catch(error) {await load();setImportError(`已完成 ${imported} 条。${error instanceof Error?error.message:"导入中断。"}重试会跳过已导入的内容。`);}
    finally {setSaving(false);}
  }

  return <div className="app-shell">
    <a href="#collection" className="skip-link">跳到我的收藏</a>
    {menuOpen&&<button className="sidebar-scrim" aria-label="收起菜单" onClick={()=>setMenuOpen(false)}/>}
    <aside ref={sidebarRef} id="sidebar" className={`sidebar ${menuOpen?"is-open":""}`}>
      <a className="brand" href={basePath} aria-label="文风首页"><span className="brand-mark"><BookOpen size={22} strokeWidth={1.8}/></span><span className="brand-word">文风<span>WENFENG READER</span></span></a>
      <div className="sidebar-caption">个人工作空间</div>
      <button className="button primary new-note" onClick={focusCapture}><Plus size={17}/>添加收藏</button>
      <nav aria-label="收藏导航" className="main-nav">
        <button className={`nav-item ${filter==="all"?"selected":""}`} onClick={()=>chooseFilter("all")}><BookOpen size={18}/><span>全部收藏</span><span className="nav-count">{active.length}</span></button>
        <button className={`nav-item ${filter==="starred"?"selected":""}`} onClick={()=>chooseFilter("starred")}><Star size={18}/><span>星标文字</span><span className="nav-count">{stars.length}</span></button>
        <button className={`nav-item ${filter==="pending"?"selected":""}`} onClick={()=>chooseFilter("pending")}><FileText size={18}/><span>待整理</span><span className="nav-count">{pending.length}</span></button>
      </nav>
      <div className="nav-section-label"><span>我的分类</span><Folder size={13}/></div>
      <nav aria-label="按分类查看" className="category-nav">{categories.map((category,index)=><button key={category} className={`nav-item category-nav-item ${filter===`category:${category}`?"selected":""}`} onClick={()=>chooseFilter(`category:${category}`)}><span className={`category-dot dot-${index%5}`}/><span>{category}</span><span className="nav-count">{active.filter(note=>note.category===category).length}</span></button>)}</nav>
      <div className="sidebar-bottom">
        <div className="sidebar-storage"><HardDrive size={16}/><div><strong>{localMode?"本地资料库":"私人资料库"}</strong><p>{localMode?"收藏保存在当前浏览器":"文字与灵感，随时重读"}</p></div></div>
        <button className={`nav-item ${filter==="trash"?"selected":""}`} onClick={()=>chooseFilter("trash")}><Trash2 size={17}/><span>回收站</span><span className="nav-count">{trash.length}</span></button>
        <button className="nav-item" disabled={parsing} onClick={()=>{setMenuOpen(false);setHelpOpen(true);}}><HelpCircle size={17}/><span>使用说明</span><ExternalLink size={13}/></button>
        <div className="sidebar-account"><span className="avatar">文</span><div><strong>{displayName}</strong><span><span className="status-dot"/>{localMode?"保存在此浏览器":"仅自己可见"}</span></div><ShieldCheck size={17}/></div>
      </div>
    </aside>

    <div className="workspace">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-controls="sidebar" aria-expanded={menuOpen} onClick={()=>setMenuOpen(true)} aria-label="打开导航菜单"><Menu size={20}/></button><BookOpen size={16}/><span>资料库</span><span className="breadcrumb-slash">/</span><strong>{currentTitle}</strong></div><div className="topbar-actions"><button className="icon-button theme-toggle" onClick={toggleTheme} aria-label={theme==="light"?"切换到深色模式":"切换到浅色模式"} title={theme==="light"?"深色模式":"浅色模式"}>{theme==="light"?<Moon size={17}/>:<Sun size={17}/>}</button><span className="private-label">{localMode?<HardDrive size={15}/>:<Cloud size={15}/>} {localMode?"本地收藏":"私人收藏"}</span><button className="button subtle export-trigger" disabled={parsing} onClick={()=>setExportOpen(true)}><ArrowDownToLine size={16}/>导入 / 导出</button></div></header>
      <main className="main-content">
        <section className="hero" aria-labelledby="hero-title"><div className="hero-copy"><div className="eyebrow">个人知识空间</div><h1 id="hero-title">{filter==="all"?"我的文字库":currentTitle}</h1><p>{filter==="trash"?"恢复误删的收藏，或清理不再需要的内容。":filter==="pending"?"先留下链接与口令，再慢慢补充值得收藏的正文。":"收集值得重读的文字，把零散的灵感整理在一起。"}</p></div><button className="button secondary hero-action" onClick={()=>setHelpOpen(true)}><HelpCircle size={16}/>使用指南</button></section>

        {localMode&&<div className="storage-notice"><HardDrive size={14}/><span>仅保存在此浏览器 · 定期备份，方便迁移</span><button className="text-button" onClick={()=>setExportOpen(true)}>备份收藏<ArrowRight size={13}/></button></div>}

        <section className="capture-card" aria-busy={parsing} aria-label="新增文字收藏">
          <div className="capture-tabs" role="tablist" aria-label="内容来源"><button id="share-tab" role="tab" aria-selected={inputMode==="share"} aria-controls="capture-panel" className={inputMode==="share"?"active":""} onClick={()=>{setInputMode("share");setInputError("");}}><Link2 size={16}/>分享 / 口令</button><button id="text-tab" role="tab" aria-selected={inputMode==="text"} aria-controls="capture-panel" className={inputMode==="text"?"active":""} onClick={()=>{setInputMode("text");setInputError("");}}><PenLine size={16}/>直接摘录</button><span className="capture-hint"><span className="capture-status-dot"/>{localMode?"在本地整理内容":"提取后确认保存"}</span></div>
          <div id="capture-panel" role="tabpanel" aria-labelledby={`${inputMode}-tab`} className="capture-panel"><label className="sr-only" htmlFor="share-input">{inputMode==="share"?"抖音分享内容、作品链接或口令":"想收藏的文字"}</label><textarea id="share-input" ref={textareaRef} value={shareInput} onChange={event=>{setShareInput(event.target.value);setInputError("");}} maxLength={24000} disabled={parsing} placeholder={inputMode==="share"?"粘贴抖音分享文字、作品链接或口令…\n支持整段分享内容，提取后可以继续编辑。":"粘贴想收藏的文章、句子或笔记…\n保留原文，也可以补充你的想法。"} onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key==="Enter"){event.preventDefault();void parseInput();}}}/><div className="capture-actions"><div className="capture-secondary"><button className="text-button" onClick={()=>void pasteClipboard()} disabled={parsing}><Clipboard size={15}/>粘贴</button><span className="divider"/><button className="text-button muted" disabled={parsing} onClick={()=>showSample()}>试试示例<ArrowRight size={13}/></button></div><button className="button primary parse-button" onClick={()=>void parseInput()} disabled={!shareInput.trim()||parsing}>{parsing?<Loader2 size={17} className="spin"/>:inputMode==="share"?<Sparkles size={16}/>:<Bookmark size={16}/>}<span>{parsing?"正在提取…":inputMode==="share"?"解析内容":"整理收藏"}</span><ArrowRight size={16}/></button></div></div>
          {inputError&&<div className="inline-error" role="alert">{inputError}</div>}
          <div className="capture-note"><ShieldCheck size={13}/><span>{inputMode==="share"?(localMode?"分享文案可提取；纯链接、纯口令会标为待整理，不代表已取得全文。":"提取分享文案与可读的公开页信息；图中文字、视频字幕暂不自动识别。"):"文字可编辑、分类、加标签，保存后可以随时搜索和导出。"}</span></div>
        </section>

        <section id="collection" className="collection-section" aria-labelledby="collection-title">
          <div className="collection-title-row"><div className="collection-heading"><h2 id="collection-title">收藏内容</h2><span className="count-pill">{filtered.length}</span><span className="collection-subtitle">{filter==="trash"?"误删的文字，可以在这里找回来。":"按你的方式整理与阅读"}</span></div><button className="text-button" disabled={parsing} onClick={()=>openEditor(blankDraft(),true)}><Plus size={15}/>手动添加</button></div>
          <div className="collection-toolbar"><div className="search-field"><Search size={17}/><label htmlFor="search" className="sr-only">搜索标题、正文、作者或标签</label><input ref={searchRef} id="search" placeholder="搜索文字、作者、标签…" value={query} onChange={event=>setQuery(event.target.value)}/>{query?<button className="icon-button compact" aria-label="清除搜索" onClick={()=>setQuery("")}><X size={14}/></button>:<kbd>⌘ / Ctrl K</kbd>}</div><div className="view-controls"><div className="select-wrap"><label htmlFor="sort" className="sr-only">收藏排序</label><select id="sort" value={sort} onChange={event=>setSort(event.target.value)}><option value="created">最近收藏</option><option value="updated">最近更新</option><option value="oldest">最早收藏</option></select><ChevronDown size={14}/></div><span className="view-divider"/><button className={`icon-button ${layout==="grid"?"active":""}`} aria-label="卡片视图" aria-pressed={layout==="grid"} onClick={()=>setLayout("grid")}><LayoutGrid size={17}/></button><button className={`icon-button ${layout==="list"?"active":""}`} aria-label="列表视图" aria-pressed={layout==="list"} onClick={()=>setLayout("list")}><List size={19}/></button></div></div>

          {loading?<div className="loading-state" role="status"><Loader2 size={22} className="spin"/><p>正在打开你的文字收藏…</p></div>:loadError?<div className="empty-state error-state"><Cloud size={30}/><h3>暂时还没有打开收藏</h3><p>{loadError}</p><div className="empty-actions">{!authenticated&&<a href="/signin-with-chatgpt?return_to=%2F" target="_top" className="button primary">登录并打开收藏<ArrowRight size={16}/></a>}<button className="button secondary" onClick={()=>void load()}><RotateCcw size={15}/>重新加载</button></div></div>:filtered.length>0?<div className={`notes-grid ${layout==="list"?"notes-list":""}`}>{filtered.map((note,index)=><article key={note.id} className={`note-card tone-${categories.indexOf(note.category)%5}`}><div className="note-topline"><span className="note-category" title={note.category}><span className="small-dot"/><span className="category-name">{note.category}</span></span><button className={`icon-button star-button ${note.starred?"is-starred":""}`} disabled={!!note.deletedAt||busyIds.has(note.id)} onClick={()=>void updateAction(note,"star")} aria-label={note.starred?`取消星标：${note.title}`:`星标：${note.title}`} aria-pressed={note.starred}><Star size={17} fill={note.starred?"currentColor":"none"}/></button></div><button className="note-content-button" disabled={parsing} onClick={()=>setReaderId(note.id)} aria-label={`阅读：${note.title}`}><h3>{note.title}</h3><p className={note.content?"note-excerpt":"note-excerpt note-awaiting"}>{note.content||(tokenOnly(note)?"口令已保留。到抖音打开作品后，可补充链接或正文。":"链接已收藏，可以打开原作品补充正文。")}</p></button><div className="note-tags">{note.tags.slice(0,3).map(tag=><button key={tag} className="tag" onClick={()=>setQuery(tag)}>#{tag}</button>)}{!note.content&&<span className="tag pending-tag">{tokenOnly(note)?"口令待解析":"待补充正文"}</span>}</div><div className="note-footer"><span>{note.sourceUrl?<Link2 size={12}/>:tokenOnly(note)?<Code2 size={12}/>:<PenLine size={12}/>}<span>{note.author||(tokenOnly(note)?"抖音口令":STATUS_LABELS[note.status])}</span></span><time dateTime={new Date(note.createdAt).toISOString()}>{dateText(note.createdAt)}</time><button className="icon-button compact card-more" disabled={parsing} onClick={()=>setReaderId(note.id)} aria-label={`查看 ${note.title} 的详情`}><MoreHorizontal size={18}/></button></div></article>)}</div>:<div className="empty-state"><div className="empty-illustration"><Bookmark size={30} strokeWidth={1.2}/><span>＋</span></div><h3>{query?"还没找到这段文字":filter==="trash"?"回收站里空空的":filter==="starred"?"为特别喜欢的文字，点一颗星":filter==="pending"?"暂时没有待整理的内容":filter.startsWith("category:")?"这个分类，等一段好文字":"建立你的第一条收藏"}</h3><p>{query?"换个关键词试试，也可以搜索正文、作者或标签。":filter==="trash"?"移入回收站的收藏会保留在这里，随时可以恢复。":filter==="starred"?"点击收藏卡片上的星星，就能在这里再次遇见。":filter==="pending"?"尚未补充正文的链接与口令会出现在这里。":"粘贴抖音分享、链接或口令，也可以直接摘录一段文字。"}</p>{query?<button className="button secondary" onClick={()=>setQuery("")}>清除搜索</button>:filter!=="trash"&&filter!=="pending"&&filter!=="starred"?<button className="text-button" onClick={focusCapture}>添加第一条收藏<ArrowRight size={15}/></button>:null}</div>}

          {!loading&&!loadError&&!active.length&&filter==="all"&&!query&&<div className="inspiration-section"><div className="inspiration-title"><span>从一个示例开始</span><span className="demo-label">原创示例 · 尚未收藏</span></div><div className="sample-grid">{SAMPLES.map((sample,index)=><button key={sample.title} className={`sample-card sample-${sample.tone}`} disabled={parsing} onClick={()=>showSample(index)}><span className="sample-category">{sample.category}<ArrowRight size={14}/></span><h3>{sample.title}</h3><p>{sample.content.split("\n")[0]}</p><span className="sample-bottom">看看这段文字<Bookmark size={14}/></span></button>)}</div></div>}
        </section>
        <footer className="main-footer"><span><BookOpen size={13}/>文风 · 为值得重读的文字留一个位置</span><span>{active.length} 条收藏<span className="footer-dot">·</span>{collectionWords.toLocaleString("zh-CN")} 字</span></footer>
      </main>
    </div>

    <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" aria-label="选择文风备份文件" onChange={event=>{const file=event.target.files?.[0];if(file)void readBackup(file);event.target.value="";}}/>

    {editor&&<Dialog feedback={toast?.message} title={editor.isNew?"整理新收藏":"编辑收藏"} onClose={closeEditor} wide><div className="editor-header"><span className={`result-badge ${editor.draft.status==="link"?"result-pending":""}`}>{editor.sample?<Leaf size={13}/>:editor.draft.status==="link"?<Link2 size={13}/>:<Check size={13}/>}<span>{editor.sample?"示例文字":tokenOnly(editor.draft)?"口令待解析":STATUS_LABELS[editor.draft.status]}</span></span><h2>{editor.isNew?(tokenOnly(editor.draft)?"保存口令，稍后补充":"整理新收藏"):"编辑收藏"}</h2>{editor.notice&&<p className="editor-notice">{editor.notice}</p>}{tokenOnly(editor.draft)&&<div className="token-callout"><div className="token-callout-heading"><Code2 size={16}/><strong>原始抖音口令</strong><button type="button" className="text-button" onClick={()=>void copyContent(editor.draft.originalShare)}><Copy size={14}/>复制口令</button></div><p>口令会原样保存。到抖音打开后，复制作品链接或文字回来补充。</p><code>{editor.draft.originalShare}</code></div>}</div><form onSubmit={event=>{event.preventDefault();void saveEditor();}} className="editor-form"><fieldset disabled={saving} className="editor-fieldset"><label>标题<input autoFocus value={editor.draft.title} onChange={event=>changeDraft("title",event.target.value)} placeholder="给这段文字起个名字" maxLength={120} required/></label><label>正文<span className="field-aside">{editor.draft.content.length.toLocaleString()} 字 · 可以继续编辑</span><textarea className="body-editor" value={editor.draft.content} onChange={event=>changeDraft("content",event.target.value)} placeholder="补充文章、句子或文案。也可以先留空，保存已识别的链接或口令。" maxLength={50000}/></label><div className="form-two-columns"><label>分类<input list="category-options" value={editor.draft.category} onChange={event=>changeDraft("category",event.target.value)} placeholder="选择或输入新分类" maxLength={40}/><datalist id="category-options">{categories.map(category=><option key={category} value={category}/>)}</datalist></label><label>作者 / 备注<input value={editor.draft.author} onChange={event=>changeDraft("author",event.target.value)} placeholder="可选，例如作者昵称" maxLength={100}/></label></div><label>标签<span className="field-aside">用逗号分隔，最多 12 个</span><input value={editor.tagText} onChange={event=>setEditor({...editor,tagText:event.target.value})} placeholder="例如：生活，成长，喜欢的句子" maxLength={400}/></label><label>抖音原链接<span className="field-aside">可选，方便以后回访</span><div className="url-input"><Link2 size={16}/><input value={editor.draft.sourceUrl} onChange={event=>changeDraft("sourceUrl",event.target.value)} placeholder="https://v.douyin.com/…" maxLength={2000}/>{douyinUrl(editor.draft.sourceUrl)&&<a href={douyinUrl(editor.draft.sourceUrl)!} target="_blank" rel="noopener noreferrer" className="icon-button" aria-label="打开抖音原文"><ExternalLink size={16}/></a>}</div></label>{editorError&&<div className="form-error" role="alert">{editorError}{duplicate&&<button type="button" className="text-button" onClick={()=>{if(editorDirty&&!window.confirm("关闭当前未保存的编辑，查看已有收藏？"))return;upsert(duplicate);setEditor(null);setReaderId(duplicate.id);}}>查看已有收藏<ArrowRight size={14}/></button>}</div>}<div className="editor-footer"><label className="checkbox-label"><input type="checkbox" checked={editor.draft.starred} onChange={event=>changeDraft("starred",event.target.checked)}/><Star size={16}/>设为星标</label><div><button type="button" className="button secondary" onClick={closeEditor} disabled={saving}>取消</button><button type="submit" className="button primary" disabled={saving}>{saving?<Loader2 size={16} className="spin"/>:<Bookmark size={16}/>}<span>{saving?"正在保存…":editor.isNew?(tokenOnly(editor.draft)?"保存口令":"保存收藏"):"保存修改"}</span></button></div></div></fieldset></form></Dialog>}

    {reader&&<Dialog feedback={toast?.message} title="阅读收藏" onClose={()=>setReaderId(null)} wide side><article className="reader"><div className="reader-meta"><span className="result-badge">{reader.category}</span><span className="reader-type">{tokenOnly(reader)?"口令待解析":STATUS_LABELS[reader.status]}</span>{reader.starred&&<Star size={15} className="reader-star" fill="currentColor"/>}</div><h2>{reader.title}</h2><div className="reader-byline">{reader.author&&<span>{reader.author}</span>}<span>{dateText(reader.createdAt)} 收藏</span></div><div className={`reader-body ${!reader.content?"empty-reader":""}`}>{reader.content||(tokenOnly(reader)?"口令已保存，尚未取得作品正文。\n复制口令到抖音打开作品，再补充原链接或文字。":"这条收藏还没有正文。\n可以打开原文，把喜欢的文字补充进来。")}</div>{reader.tags.length>0&&<div className="reader-tags">{reader.tags.map(tag=><span className="tag" key={tag}>#{tag}</span>)}</div>}{reader.sourceUrl&&<a className="source-card" href={douyinUrl(reader.sourceUrl)||undefined} target="_blank" rel="noopener noreferrer"><span className="source-icon"><Link2 size={19}/></span><span><strong>打开抖音原作品</strong><small>{reader.sourceUrl}</small></span><ExternalLink size={17}/></a>}{reader.originalShare&&<details className="original-share"><summary>{tokenOnly(reader)?"查看保存的抖音口令":"查看原始分享内容"}<ChevronDown size={14}/></summary><p>{reader.originalShare}</p></details>}<div className="reader-actions">{reader.deletedAt?<><button className="button subtle permanent-delete" disabled={busyIds.has(reader.id)} onClick={()=>void updateAction(reader,"delete")}><Trash2 size={15}/>永久删除</button><button className="button primary" disabled={busyIds.has(reader.id)} onClick={()=>void updateAction(reader,"restore")}><RotateCcw size={16}/>恢复收藏</button></>:<><div className="reader-actions-left"><button className="button subtle" disabled={busyIds.has(reader.id)} onClick={()=>void updateAction(reader,"star")}><Star size={16} fill={reader.starred?"currentColor":"none"}/>{reader.starred?"取消星标":"星标"}</button><button className="button subtle" onClick={()=>void copyContent(tokenOnly(reader)?reader.originalShare:reader.content)} disabled={!reader.content&&!tokenOnly(reader)}><Copy size={16}/>{tokenOnly(reader)?"复制口令":"复制正文"}</button><button className="icon-button delete-button" aria-label="移入回收站" disabled={busyIds.has(reader.id)} onClick={()=>void updateAction(reader,"trash")}><Trash2 size={17}/></button></div><button className="button primary" onClick={()=>openEditor(toDraft(reader),false)}><PenLine size={16}/>编辑收藏</button></>}</div></article></Dialog>}

    {helpOpen&&<Dialog feedback={toast?.message} title="使用说明" onClose={()=>setHelpOpen(false)}><div className="help-content"><div className="help-icon"><BookOpen size={26}/></div><h2>收集、整理，然后重读。</h2><div className="help-step"><span>01</span><div><h3>复制分享文字、链接或口令</h3><p>在抖音作品里打开分享菜单，复制整段分享内容并粘贴到文风。无链接的抖音口令也可以先识别并保存。</p></div></div><div className="help-step"><span>02</span><div><h3>提取，然后确认</h3><p>{localMode?"文风会提取分享里已有的文字、作者和话题。只有链接或纯口令时会标成待整理；不透明短码不会被当作文章正文，也不会凭空还原作品。":"文风会提取分享内容中的文案；只有链接时，会尝试读取公开页面。结果可能是简介或节选，可以自行补充和修改。"}</p></div></div><div className="help-step"><span>03</span><div><h3>收藏，留待重读</h3><p>{localMode?"给文字加分类和标签，喜欢的设为星标。收藏保存在当前设备、当前浏览器，普通模式下重新打开仍可查看。换设备或清理浏览器前，请先导出 JSON 备份。":"给文字加分类和标签，喜欢的设为星标。收藏按当前账号保存，重新打开仍可查看。"}</p></div></div><div className="help-boundary"><strong>关于解析范围</strong><p>{localMode?"此网页不自动抓取远程文章、识别图中文字、下载视频、转写口播或同步抖音收藏夹。分享文案可能只是节选，你可以用「直接摘录」补充文章。收藏不会上传到服务器，也不会自动跨设备同步；隐私模式或清理站点数据可能会删除本地收藏。":"当前版本不自动识别图中文字、下载视频、转写口播或同步抖音收藏夹。公开页若需要登录、验证或没有正文，会保留链接并提示补充文字。你也可以用「直接摘录」保存文章。"}</p></div><p className="help-footer">纯口令请使用「复制口令」，到抖音打开目标内容后，再回来补充链接或文字。JSON 可备份和恢复包括口令在内的收藏；示例只有主动保存后才会加入资料库。</p><button className="button primary full-width" onClick={()=>setHelpOpen(false)}>知道了，去收藏<ArrowRight size={16}/></button></div></Dialog>}

    {exportOpen&&<Dialog feedback={toast?.message} title="导入与导出" onClose={()=>setExportOpen(false)}><div className="export-content"><div className="help-icon"><ArrowDownToLine size={25}/></div><h2>把文字带在身边。</h2><p>导出全部 {active.length} 条收藏，不含回收站与未保存的示例。</p><button className="export-option" disabled={!active.length} onClick={()=>exportNotes("json")}><span><FileJson size={24}/></span><div><strong>导出 JSON 备份</strong><small>保留正文、来源、标签和时间，可导回文风。</small></div><ArrowDownToLine size={18}/></button><button className="export-option" disabled={!active.length} onClick={()=>exportNotes("markdown")}><span><FileText size={24}/></span><div><strong>导出 Markdown 文字集</strong><small>适合阅读、归档，或放入自己的笔记软件。</small></div><ArrowDownToLine size={18}/></button><div className="import-divider"><span>已有备份？</span></div><button className="button secondary full-width" onClick={()=>fileRef.current?.click()}><Upload size={16}/>导入文风 JSON 备份</button><p className="export-footnote">导入前会显示数量并检查格式，重复收藏会自动跳过。{localMode&&<>换设备或清理浏览器前，请先备份。</>}</p></div></Dialog>}

    {importPreview&&<Dialog feedback={toast?.message} title="确认导入" onClose={()=>{if(!saving)setImportPreview(null);}}><div className="export-content"><div className="help-icon"><Upload size={25}/></div><h2>让收藏回到书房。</h2><p className="import-filename">{importPreview.filename}</p><div className="import-stats"><div><strong>{importPreview.total}</strong><span>备份中的收藏</span></div><div><strong>{importPreview.duplicates}</strong><span>重复，自动跳过</span></div><div><strong>{importPreview.notes.length}</strong><span>将新增的收藏</span></div></div><p>已有收藏不会被覆盖。回收站里存在的同一条内容，也会视为已收藏。</p>{importError&&<div className="form-error" role="alert">{importError}</div>}<button className="button primary full-width" disabled={saving||!importPreview.notes.length} onClick={()=>void importBackup()}>{saving?<Loader2 size={16} className="spin"/>:<Upload size={16}/>}<span>{saving?"正在导入…":`导入 ${importPreview.notes.length} 条收藏`}</span></button></div></Dialog>}

    {toast&&<div className="toast" role="status"><Check size={16}/><span>{toast.message}</span>{toast.undoId&&<button onClick={()=>{const note=notes.find(n=>n.id===toast.undoId);if(note)void updateAction(note,"restore");}}>撤销</button>}<button className="toast-close" aria-label="关闭提示" onClick={()=>setToast(null)}><X size={15}/></button></div>}
  </div>;
}
