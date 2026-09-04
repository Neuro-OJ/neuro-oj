// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { addPostPreviews } from '../utils/communityPostPreview.ts';

Deno.test('community post previews are generated when rows enter the list', () => {
  const posts = addPostPreviews([
    {
      post: {
        id: 'post-1',
        type: 'discussion',
        title: '标题',
        content: '**正文**',
        status: 'published',
        is_locked: false,
        is_pinned: false,
        problem_id: null,
        board_id: null,
        author_id: 'user-1',
        moderation_reason: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      author: { id: 'user-1', username: 'alice' },
      likes: 0,
      comments: 0,
    },
  ]);

  assertEquals(posts[0]?.preview, '正文');
});
