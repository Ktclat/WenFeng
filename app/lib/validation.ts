import { z } from "zod";
import { douyinUrl, isUnresolvedShareToken } from "./parse-share";

export const noteInput = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1, "请写一个标题").max(120),
  content: z.string().max(50000).default(""),
  author: z.string().trim().max(100).default(""),
  sourceUrl: z.string().max(2000).default("").refine(value => !value || !!douyinUrl(value), "来源需要是抖音作品链接"),
  originalShare: z.string().max(24000).default(""),
  category: z.string().trim().min(1).max(40).default("未分类"),
  tags: z.array(z.string().trim().min(1).max(30)).max(12).default([]),
  starred: z.boolean().default(false),
  status: z.enum(["share", "page", "manual", "link"]).default("manual"),
}).refine(value => !!value.content.trim() || !!value.sourceUrl || isUnresolvedShareToken(value.originalShare), "请补充正文或抖音作品链接，或粘贴完整的抖音口令");

export function checkOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return request.headers.get("sec-fetch-site") !== "cross-site" && (!origin || origin === new URL(request.url).origin);
}

export async function readBody(request: Request, maxSize = 120000) {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new Error("请使用 JSON 格式提交。");
  if (Number(request.headers.get("content-length") || "0") > maxSize) throw new Error("提交的内容太大，请分批处理。");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("没有收到内容。");
  const decoder = new TextDecoder();
  let size = 0, text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxSize) { await reader.cancel(); throw new Error("提交的内容太大，请分批处理。"); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  try { return JSON.parse(text); } catch { throw new Error("内容格式不正确，请重新尝试。"); }
}
