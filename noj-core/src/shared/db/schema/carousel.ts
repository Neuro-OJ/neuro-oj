import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * 首页轮播（与公告解耦）。
 *
 * 轮播是独立的运营展示位，不再由公告驱动（issue #231）。
 * `kind=image` 用图片（复用 StorageProvider），`kind=text` 用渐变 + 文案。
 * `link_url` 为空则整卡不可点；`is_enabled=false` 时公开端不返回。
 */
export const carouselSlides = pgTable(
  "carousel_slides",
  {
    id: text("id").primaryKey(),
    /** 幻灯片类型：image=图片，text=渐变文案 */
    kind: text("kind").notNull(),
    /** 图片存储地址（kind=image 时必填，复用 StorageProvider） */
    image_storage_url: text("image_storage_url"),
    /** 主标题（kind=text 时必填） */
    title: text("title"),
    /** 副标题（可选） */
    subtitle: text("subtitle"),
    /** 渐变预设键（kind=text 用） */
    gradient_key: text("gradient_key"),
    /** 点击跳转地址；为空则整卡不可点 */
    link_url: text("link_url"),
    /** 排序权重（升序展示） */
    sort_order: integer("sort_order").notNull().default(0),
    /** 是否启用（false 时公开端不可见） */
    is_enabled: boolean("is_enabled").notNull().default(true),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    kindCheck: check(
      "carousel_slides_kind_check",
      sql`${table.kind} IN ('image', 'text')`,
    ),
    enabledSortIdx: index("idx_carousel_slides_enabled_sort").on(
      table.is_enabled,
      table.sort_order,
    ),
  }),
);
