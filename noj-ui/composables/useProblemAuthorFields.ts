import type { ProblemSample } from '~/utils/oiWorkspace';

/** 同一编辑器的 OI/AI tab 共享题目元数据，切换时不丢失输入。 */
export interface ProblemAuthorFields {
  title: Ref<string>;
  description: Ref<string>;
  difficulty: Ref<string>;
  samples: Ref<ProblemSample[]>;
  tagIds: Ref<string[]>;
  visibility: Ref<'public' | 'private'>;
}

export function useProblemAuthorFields(): ProblemAuthorFields {
  return inject<ProblemAuthorFields>('problem-author-fields') ?? {
    title: ref(''),
    description: ref(''),
    difficulty: ref('medium'),
    samples: ref([]),
    tagIds: ref([]),
    visibility: ref('private'),
  };
}
