import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  author: text("author").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  originalShare: text("original_share").notNull().default(""),
  category: text("category").notNull().default("未分类"),
  tags: text("tags").notNull().default("[]"),
  starred: integer("starred", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("manual"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (table) => [index("notes_user_updated_idx").on(table.userId, table.updatedAt)]);
