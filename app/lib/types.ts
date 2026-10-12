export type ContentStatus = "share" | "page" | "manual" | "link";
export type Note = {
  id: string;
  title: string;
  content: string;
  author: string;
  sourceUrl: string;
  originalShare: string;
  category: string;
  tags: string[];
  starred: boolean;
  status: ContentStatus;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};
export type Draft = Omit<Note, "createdAt" | "updatedAt" | "deletedAt">;
export type ApiReply = { notes: Note[]; note: Note; skipped: number; error?: string };
export type ParseResult = {
  title: string;
  content: string;
  author: string;
  sourceUrl: string;
  originalShare: string;
  tags: string[];
  status: ContentStatus;
  notice: string;
};
export const STATUS_LABELS: Record<ContentStatus, string> = {
  share: "分享文案", page: "公开页文案", manual: "文字摘录", link: "待补充正文",
};
export const CATEGORIES = ["未分类", "生活感悟", "自我成长", "浪漫诗意", "表达灵感"];
