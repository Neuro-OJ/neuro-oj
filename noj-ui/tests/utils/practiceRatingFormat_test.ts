/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  formatEffectiveDifficulty,
  formatPracticeEntryScore,
  formatPracticeProgressHint,
  formatPracticeScoreRatio,
  getPracticeRatingTierMeta,
} from '../../utils/domain/ranking/practiceRatingFormat.ts';

Deno.test('practiceRatingFormat: 段位标签与未知值回退', () => {
  assertEquals(getPracticeRatingTierMeta('unrated').label, '未定级');
  assertEquals(getPracticeRatingTierMeta('proficient').label, '熟练');
  assertEquals(getPracticeRatingTierMeta('grandmaster').label, '宗师');
  assertEquals(getPracticeRatingTierMeta('unknown').label, '未定级');
});

Deno.test('practiceRatingFormat: 得分、得分率与难度口径格式化', () => {
  assertEquals(formatPracticeScoreRatio(0), '0.0%');
  assertEquals(formatPracticeScoreRatio(0.875), '87.5%');
  assertEquals(formatPracticeScoreRatio(1.2), '100.0%');

  assertEquals(formatPracticeEntryScore(9000, 10000), '90.0 / 100');
  assertEquals(formatPracticeEntryScore(300, 400), '3.0 / 4');

  assertEquals(formatEffectiveDifficulty(75, true), 'd=75 · 校准');
  assertEquals(formatEffectiveDifficulty(50, false), 'd=50 · 先验');
});

Deno.test('practiceRatingFormat: 推分引导文案', () => {
  assertEquals(
    formatPracticeProgressHint(0, 30, null),
    '在官方主域公开题库获得有效得分后即可生成能力值',
  );
  assertEquals(
    formatPracticeProgressHint(12, 30, null),
    '已收录 12/30 题，继续完成官方公开题库题目可直接累计能力值',
  );
  assertEquals(
    formatPracticeProgressHint(30, 30, 341),
    '当前 B30 门槛 341 分，单题超过此分或刷新 B30 内最高分即可涨分',
  );
});
