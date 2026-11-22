import { stripMarkdown } from './markdown.ts';

export type PostRowWithPreview<T extends { post: { content: string } }> = T & {
  preview: string;
};

/** 为新进入社区列表的帖子生成一次纯文本摘要。 */
export function addPostPreviews<T extends { post: { content: string } }>(
  posts: T[],
): PostRowWithPreview<T>[] {
  return posts.map((item) => ({
    ...item,
    preview: stripMarkdown(item.post.content),
  }));
}
