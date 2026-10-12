import type { ParseResult } from "./types";

const HOSTS = new Set(["douyin.com", "www.douyin.com", "v.douyin.com", "iesdouyin.com", "www.iesdouyin.com", "m.iesdouyin.com"]);
const URL_PATTERN = /https?:\/\/[^\s<>"'(),\[\]，。！？；、（）【】《》「」『』\u3000]+/giu;
const DIRECT_PATH = /^\/(?:share\/)?(video|note|slides)\/(\d{10,24})\/?$/u;
const TOKEN_BLOCK = /##([A-Za-z0-9_-]{6,128})##[ \t]*(?:\[抖音口令\]|【抖音口令】)/gu;
const TOKEN_END = /##([A-Za-z0-9_-]{6,128})##[ \t]*(?:\[抖音口令\]|【抖音口令】)[\s，。！!；;]*$/u;
const TOKEN_PROMPT_END = /长按复制此条消息[，,：:\s]*打开抖音查看精彩(?:[:：]\/[ \t]*)?内容[，,。！!：:\s]*$/u;
const COPY_PREFIX = /^\s*(?:[A-Za-z0-9@#$&*:.\/_=%+!\- \t]{0,100})?复制打开抖音[，,：:\s]*/u;
const AUTHOR_PREFIX = /^\s*(?:[A-Za-z0-9@#$&*:.\/_=%+!\- \t]{0,100}复制打开抖音[，,：:\s]*)?看看【([^】\n]{1,80}?)(?:的作品|的图文|的视频)】\s*/u;

function isShareTracking(text: string): boolean {
  const value = text.trim();
  const [marker, ...parts] = value.split(/\s+/u);
  return value.length <= 100 && /^(?:\d{1,2}:\/|#\d{1,2}-)$/u.test(marker)
    && parts.every(part => /^[A-Za-z0-9@._:/=%+\-]{1,25}$/u.test(part) && /[\d@._:/=%+\-]/u.test(part));
}

function removeTrailingTracking(text: string): string {
  if (isShareTracking(text)) return "";
  const suffix = text.match(/(?:^|\s)((?:\d{1,2}:\/|#\d{1,2}-)(?:\s+[A-Za-z0-9@._:/=%+\-]{1,25}){0,7})\s*$/u);
  return suffix && isShareTracking(suffix[1]) ? text.slice(0, suffix.index).trimEnd() : text;
}

/** Only explicit, terminal Douyin token blocks are removed; quoted examples stay text. */
function tokenTrailer(text: string): { content: string; token: string } | null {
  const block = text.match(TOKEN_END);
  if (!block) return null;
  let before = text.slice(0, block.index).trimEnd();
  const prompt = before.match(TOKEN_PROMPT_END);
  if (!prompt && before.trim() && !isShareTracking(before) && !COPY_PREFIX.test(before) && !AUTHOR_PREFIX.test(before)) return null;
  if (prompt) before = removeTrailingTracking(before.slice(0, prompt.index).trimEnd());
  else if (isShareTracking(before)) before = "";
  return { content: before, token: block[1] };
}

function removeSharePrefix(text: string, allowAuthor: boolean): { content: string; author: string } {
  const author = allowAuthor ? text.match(AUTHOR_PREFIX) : null;
  if (author) return { content: text.slice(author[0].length), author: author[1].trim() };
  return { content: text.replace(COPY_PREFIX, ""), author: "" };
}

function singleTokenTrailer(text: string): { content: string; token: string } | null {
  return text && text.length <= 24000 && [...text.matchAll(TOKEN_BLOCK)].length === 1 ? tokenTrailer(text.trim()) : null;
}

function isTokenShareList(text: string): boolean {
  const blocks = [...text.matchAll(TOKEN_BLOCK)];
  if (blocks.length < 2) return false;
  let start = 0;
  for (const block of blocks) {
    const end = block.index! + block[0].length;
    if (!tokenTrailer(text.slice(start, end))) return false;
    start = end;
  }
  return /^[\s，。！!；;]*$/u.test(text.slice(start));
}

/** Stable identity survives later edits to the saved content or source URL. */
export function shareTokenKey(originalShare: string): string | null {
  const trailer = singleTokenTrailer(originalShare);
  // The code is opaque and case-sensitive. It is not a work ID or a short URL.
  return trailer ? JSON.stringify(["douyin-token", trailer.token]) : null;
}

/** Recognizes a complete opaque share token, never a bare number or random code. */
export function isUnresolvedShareToken(text: string): boolean {
  const trailer = singleTokenTrailer(text);
  return !!trailer && !removeSharePrefix(trailer.content, true).content.trim();
}

/** Keep opaque token identities separate from empty-text titles in JSON backups. */
export function textContentKey(note: { title: string; content: string; originalShare: string }): string {
  if (!note.content.trim() && isUnresolvedShareToken(note.originalShare)) {
    return shareTokenKey(note.originalShare)!;
  }
  return JSON.stringify(["text", note.title, note.content.trim()]);
}

export function workId(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!HOSTS.has(url.hostname)) return null;
    const pathId = url.pathname.match(DIRECT_PATH)?.[2];
    const modal = url.searchParams.get("modal_id");
    if (pathId && modal && pathId !== modal) return null;
    return pathId || (modal && /^\d{10,24}$/.test(modal) ? modal : null);
  } catch { return null; }
}

export function douyinUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim().replace(/[，。！？；：、）】》」』,.!?;:)\]}]+$/u, ""));
    if (!HOSTS.has(url.hostname) || url.username || url.password || url.port || !["http:","https:"].includes(url.protocol)) return null;
    url.protocol = "https:"; url.hash = "";
    const item = url.pathname.match(DIRECT_PATH);
    const modal = url.searchParams.get("modal_id");
    if (item && modal && item[2] !== modal) return null;
    if (item && url.hostname !== "v.douyin.com") return `https://www.douyin.com/${item[1] === "video" ? "video" : "note"}/${item[2]}`;
    if (modal && /^\d{10,24}$/.test(modal) && ["douyin.com","www.douyin.com"].includes(url.hostname)) {
      url.hostname = "www.douyin.com";url.search = `?modal_id=${modal}`;return url.href;
    }
    if (url.hostname === "v.douyin.com" && /^\/[\w-]{3,80}\/?$/.test(url.pathname)) {
      url.pathname = `/${url.pathname.split("/")[1]}/`;return url.href;
    }
    return null;
  } catch { return null; }
}

export function sourceKey(raw: string): string {
  return workId(raw) ? `work:${workId(raw)}` : (douyinUrl(raw) || raw);
}

export function allowedFetchUrl(raw: string): boolean {
  try { const url = new URL(raw);return url.protocol === "https:" && HOSTS.has(url.hostname) && !url.username && !url.password && !url.port; }
  catch { return false; }
}

export function extractTags(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/#([^\s#，。！？；,!?;]{1,24})/gu), x => x[1]))).slice(0,12);
}
export function makeTitle(content: string): string {
  return content.trim().split(/[\n。！？]/u)[0]?.replace(/#[^\s#]+/g, "").trim().slice(0,40) || "待整理的抖音收藏";
}

export function parseShare(input: string): ParseResult {
  const originalShare = input.trim();
  if (!originalShare) throw new Error("先粘贴一段分享内容或文字吧。");
  if (originalShare.length > 24000) throw new Error("这段内容有点长，请控制在 24,000 字以内。");
  const matches = [...originalShare.matchAll(URL_PATTERN)];
  const recognized = matches.map(match => ({match,url:douyinUrl(match[0])})).filter(value => value.url);
  const unique = new Map(recognized.map(value => [sourceKey(value.url!),value.url!]));
  if (unique.size > 1) throw new Error("检测到多条抖音链接，请一次粘贴一条分享内容。");
  if (matches.length && !unique.size) throw new Error("没有识别到抖音作品链接。请复制作品的分享内容，或切换到「直接摘录」。");
  const sourceUrl = [...unique.values()][0] || "";
  const trailer = tokenTrailer(originalShare);
  if ((trailer && [...originalShare.matchAll(TOKEN_BLOCK)].length > 1) || isTokenShareList(originalShare)) {
    throw new Error("检测到多条抖音口令，请一次粘贴一条完整分享内容。");
  }
  let content = trailer?.content ?? originalShare;
  const isShare = !!sourceUrl || !!trailer || COPY_PREFIX.test(content);
  const hasWrapper = isShare && AUTHOR_PREFIX.test(content);
  const opening = isShare ? removeSharePrefix(content, true) : { content, author: "" };
  content = opening.content;
  const author = opening.author;
  if (sourceUrl) {
    const contentMatches = [...content.matchAll(URL_PATTERN)].filter(match => !!douyinUrl(match[0]));
    // Remove links from right to left so surrounding user text remains intact.
    for (const match of contentMatches.reverse()) {
      let start = match.index!, end = start + match[0].length;
      const pairs:Record<string,string> = {"（":"）","(":")","【":"】","[":"]","《":"》","<":">"};
      const closing = pairs[content[start-1]];
      if (closing && closing === content[end]) { start--;end++; }
      const suffix = content.slice(end);
      const trackingSuffix = /^[\s，。]*(?:[A-Za-z][A-Za-z0-9@._:/%=\-]{1,20}\s+)?\d{1,2}\/\d{1,2}(?:\s+[A-Za-z0-9@._:/%=\-]{1,25}){0,3}\s*$/u;
      content = content.slice(0,start) + (hasWrapper && trackingSuffix.test(suffix) ? "" : suffix);
    }
    content = content.split(/\r?\n/u).filter(line => !/^[\s，,。；;：（）()【】\[\]《》]*$/u.test(line)).join("\n");
  }
  content = content.replace(/\r\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
  if (!content && !sourceUrl && trailer) {
    return {title:"待解析的抖音口令",content:"",author,sourceUrl:"",originalShare,tags:[],status:"link",notice:"已识别到抖音口令，可以先保存为待整理；目前没有解析出文章。请在抖音中打开口令，再复制作品链接或手动补充正文。"};
  }
  if (!content && !sourceUrl) throw new Error("已识别到分享提示，但没有找到文案、作品链接或完整口令。请重新复制完整分享内容。");
  return {title:makeTitle(content),content,author,sourceUrl,originalShare,tags:extractTags(content),status:content ? (isShare ? "share" : "manual") : "link",notice:content ? (isShare ? "已提取你粘贴的分享文案。分享文字可能只是节选，请核对后收藏。" : "已整理为文字摘录，可以继续编辑后收藏。") : "已识别到作品链接，正在尝试读取公开页面。"};
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/gi, entity => {
    const map:Record<string,string> = {"&amp;":"&","&quot;":'"',"&apos;":"'","&lt;":"<","&gt;":">","&nbsp;":" "};
    if (map[entity.toLowerCase()]) return map[entity.toLowerCase()];
    const n = entity[2]?.toLowerCase() === "x" ? parseInt(entity.slice(3,-1),16) : parseInt(entity.slice(2,-1),10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
  }).trim();
}
function attributes(tag:string):Record<string,string> {
  const attrs:Record<string,string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) attrs[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? "");
  return attrs;
}
function usefulMetadata(text:string):boolean {
  const clean = text.trim().replace(/\s+/g," ");
  return clean.length > 1
    && !/^(?:抖音(?:短视频)?[\s，,：:丨|\-–—·]*记录美好生活[。！!]?|记录美好生活[。！!]?|抖音|抖音短视频|安全验证|验证码|访问验证|页面不存在|作品已删除|欢迎来到抖音|下载抖音)$/u.test(clean)
    && !/^.{1,80}在抖音记录美好生活\s*\d{8}[。！!\s]*$/u.test(clean)
    && !/^(?:抖音(?:短视频)?(?:是一个|是|致力于)|请完成.*验证|验证后继续|登录后.*观看)/u.test(clean);
}
function jsonIdentity(value:unknown):string|null {
  if (typeof value === "string") return workId(value);
  if (value && typeof value === "object") return workId(String((value as Record<string,unknown>)["@id"] || ""));
  return null;
}

export function extractPublicPage(html:string,finalUrl:string,originalUrl=finalUrl):{content:string;title:string;author:string}|null {
  const originalId = workId(originalUrl), finalId = workId(finalUrl);
  if (originalId && originalId !== finalId) return null;
  let expectedId = finalId || originalId;
  const pageTitle = decodeHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] || "");
  if (/安全验证|访问验证|验证码|登录抖音|账号登录|作品已删除|页面不存在/u.test(pageTitle)) return null;
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/iu)?.[1]?.replace(/<[^>]+>/g," ").trim();
  if (main && /^(?:请完成(?:安全)?验证|请先登录|作品已删除|该作品不存在)/u.test(main)) return null;
  const meta:Record<string,string> = {};
  for (const tag of html.matchAll(/<meta\b[^>]*>/giu)) { const attrs=attributes(tag[0]),key=attrs.property||attrs.name;if(key&&attrs.content)meta[key.toLowerCase()]=attrs.content; }
  const canonical = [...html.matchAll(/<link\b[^>]*>/giu)].map(tag=>attributes(tag[0])).find(attrs=>attrs.rel?.toLowerCase()==="canonical")?.href;
  for (const identityUrl of [canonical,meta["og:url"]].filter(Boolean)) {
    const canonicalId = workId(identityUrl!);
    if (expectedId && canonicalId !== expectedId) return null;
    expectedId = canonicalId || expectedId;
  }
  if (!expectedId) return null;
  const payloads:unknown[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    const attrs=attributes(match[1]),raw=match[2].trim();
    try {
      if (attrs.id === "RENDER_DATA") { try {payloads.push(JSON.parse(raw));} catch {payloads.push(JSON.parse(decodeURIComponent(raw)));} }
      else if (["__NEXT_DATA__","SIGI_STATE"].includes(attrs.id) || ["application/ld+json","application/json"].includes(attrs.type)) payloads.push(JSON.parse(raw));
      else if (/^(?:window\.)?_ROUTER_DATA\s*=/u.test(raw)) payloads.push(JSON.parse(raw.replace(/^(?:window\.)?_ROUTER_DATA\s*=\s*/u,"").replace(/;\s*$/u,"")));
    } catch { /* Only JSON is read. Page scripts are never executed. */ }
  }
  const queue=[...payloads];
  for (let index=0;index<queue.length && index<5000;index++) {
    const current=queue[index];if(!current||typeof current!=="object")continue;
    const o=current as Record<string,unknown>;
    const id=String(o.aweme_id??o.awemeId??o.item_id??o.video_id??"");
    const authorObject=o.author&&typeof o.author==="object"?o.author as Record<string,unknown>:{};
    if (id===expectedId && typeof o.desc==="string" && o.desc.trim()) {
      const content=decodeHtml(o.desc).slice(0,24000);
      return {content,title:makeTitle(content),author:typeof authorObject.nickname==="string"?authorObject.nickname.slice(0,80):""};
    }
    if (["Article","SocialMediaPosting","VideoObject"].includes(String(o["@type"])) && [o.url,o["@id"],o.mainEntityOfPage].some(value=>jsonIdentity(value)===expectedId)) {
      const content=typeof o.articleBody==="string"?o.articleBody:typeof o.description==="string"?o.description:"";
      if (content.trim()) return {content:decodeHtml(content).slice(0,24000),title:typeof o.headline==="string"?decodeHtml(o.headline).slice(0,100):typeof o.name==="string"?decodeHtml(o.name).slice(0,100):makeTitle(content),author:typeof authorObject.name==="string"?decodeHtml(authorObject.name).slice(0,80):""};
    }
    for(const value of Object.values(o))if(value&&typeof value==="object")queue.push(value);
  }
  // Open Graph descriptions are excerpts, never promised as complete articles.
  const description=meta["og:description"]||meta.description||"";
  const title=(meta["og:title"]||pageTitle).replace(/\s*[-|丨–—]\s*抖音.*$/u,"").trim();
  if (usefulMetadata(description)) return {content:description.slice(0,24000),title:usefulMetadata(title)?title.slice(0,100):makeTitle(description),author:""};
  return null;
}
