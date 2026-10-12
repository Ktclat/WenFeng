import { getChatGPTUser } from "../../chatgpt-auth";
import { allowedFetchUrl, douyinUrl, extractPublicPage, extractTags, parseShare, workId } from "../../lib/parse-share";
import { checkOrigin, readBody } from "../../lib/validation";

export const dynamic = "force-dynamic";

async function publicPage(sourceUrl: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  try {
    let url = sourceUrl;
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (!allowedFetchUrl(url)) return null;
      const response = await fetch(url, {redirect:"manual", signal:controller.signal, headers:{"accept":"text/html,application/xhtml+xml", "accept-language":"zh-CN,zh;q=0.9"}});
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) return null;
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) { await response.body?.cancel(); return null; }
      if (Number(response.headers.get("content-length") || "0") > 2000000) { await response.body?.cancel(); return null; }
      const reader = response.body?.getReader();
      if (!reader) return null;
      const decoder = new TextDecoder();
      let html = "", total = 0;
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 2000000) { await reader.cancel(); return null; }
        html += decoder.decode(value, {stream:true});
      }
      html += decoder.decode();
      if (workId(sourceUrl) && workId(sourceUrl) !== workId(url)) return null;
      return {data:extractPublicPage(html,url,sourceUrl), sourceUrl:douyinUrl(url) || sourceUrl};
    }
    return null;
  } finally { clearTimeout(timer); }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({error:"请先登录后再提取。"}, {status:401});
  if (!checkOrigin(request)) return Response.json({error:"请在文风页面内操作。"}, {status:403});
  try {
    const input = await readBody(request);
    if (typeof input.text !== "string") return Response.json({error:"请粘贴分享内容。"}, {status:400});
    const result = parseShare(input.text);
    if (!result.content && result.sourceUrl) {
      try {
        const remote = await publicPage(result.sourceUrl);
        if (remote) result.sourceUrl = remote.sourceUrl;
        if (remote?.data) {
          Object.assign(result, remote.data, {tags:extractTags(remote.data.content),status:"page",notice:"已提取公开页面文案，可能是简介或节选，并非图文全文或视频字幕。请核对后收藏。"});
        } else result.notice = "已识别到链接，但没有读到可用正文。你可以打开原文补充文字，也可以先收藏链接。";
      } catch { result.notice = "已识别到链接，当前暂时无法读取公开页面。可以补充文字，或先收藏链接。"; }
    }
    return Response.json(result, {headers:{"cache-control":"no-store"}});
  } catch (error) {
    return Response.json({error:error instanceof Error ? error.message : "暂时无法提取，请重新尝试。"}, {status:400});
  }
}
