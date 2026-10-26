import type { ProblemSample } from './oiWorkspace.ts';
export interface DomainOiCase {
  id: string;
  input: string;
  output: string;
  score?: number;
}
export interface DomainOiSubtask {
  id: string;
  score: number;
  scoring: 'min' | 'max' | 'sum';
  depends_on: string[];
  cases: DomainOiCase[];
}
export interface DomainOiRuntime {
  backend: 'native' | 'wasm';
  languages: ('c' | 'cc')[];
  time_limit_ms: number;
  memory_limit_mb: number;
  checker: { type: 'default' | 'strict' | 'testlib'; path?: string };
  subtasks: DomainOiSubtask[];
  filename?: string;
  [key: string]: unknown;
}
export interface DomainAiRuntime {
  evaluator: {
    image: string;
    command: string;
    time_limit_ms: number;
    memory_limit_mb: number;
    network: { enabled: boolean };
    workspace_size_mb?: number;
  };
  solution: { image: string; call_timeout_ms: number; memory_limit_mb: number };
}
export interface DomainObjectiveSnapshot {
  key: string;
  sort_order: number;
  type: 'single' | 'multiple' | 'judge';
  prompt: string;
  options: { key: string; text: string }[];
  answer: (string | boolean)[];
  explanation: string;
}
export interface DomainEditorContent {
  kind: 'oi' | 'ai' | 'objective';
  title: string;
  description: string;
  samples: ProblemSample[];
  runtime_config?: DomainAiRuntime | DomainOiRuntime | null;
  questions?: DomainObjectiveSnapshot[];
  submission_mode?: 'code' | 'artifact' | 'prediction' | 'ui';
  artifact_max_size_mb?: number | null;
  template_content?: string;
  llm_config?: { max_calls?: number; max_tokens?: number; models?: string[] } | null;
  [key: string]: unknown;
}
/** 新题从可编辑草稿开始，具体文件存在性和运行上限由发布预检判断。 */
export function newDomainEditorContent(kind: DomainEditorContent['kind']): DomainEditorContent {
  const base = { kind, title: '', description: '', samples: [] };
  if (kind === 'objective') return { ...base, questions: [] };
  if (kind === 'oi') {
    return {
      ...base,
      runtime_config: {
        backend: 'wasm',
        languages: ['c', 'cc'],
        time_limit_ms: 1000,
        memory_limit_mb: 256,
        checker: { type: 'default' },
        subtasks: [{
          id: 'all',
          score: 100,
          scoring: 'sum',
          depends_on: [],
          cases: [{ id: 'case1', input: 'testdata/1.in', output: 'testdata/1.out' }],
        }],
      },
    };
  }
  return {
    ...base,
    submission_mode: 'code',
    template_content: '',
    artifact_max_size_mb: null,
    llm_config: null,
    runtime_config: {
      evaluator: {
        image: '',
        command: 'python3 /workspace/evaluate.py',
        time_limit_ms: 5000,
        memory_limit_mb: 512,
        network: { enabled: false },
      },
      solution: { image: '', call_timeout_ms: 1000, memory_limit_mb: 256 },
    },
  };
}
/** 不删除未在表单展示的配置；已有 OI 扩展文件与子任务约束继续随草稿保存。 */
export function normalizeDomainEditorContent(input: Record<string, unknown>): DomainEditorContent {
  const content = JSON.parse(JSON.stringify(input)) as DomainEditorContent;
  const defaults = newDomainEditorContent(content.kind);
  if (content.kind === 'ai') {
    const runtime = content.runtime_config as DomainAiRuntime | null;
    const initial = defaults.runtime_config as DomainAiRuntime;
    content.runtime_config = {
      ...runtime,
      evaluator: {
        ...initial.evaluator,
        ...runtime?.evaluator,
        network: { enabled: false, ...runtime?.evaluator?.network },
      },
      solution: { ...initial.solution, ...runtime?.solution },
    };
    content.template_content ??= '';
    content.llm_config ??= null;
    content.artifact_max_size_mb ??= null;
  }
  if (content.kind === 'oi' && content.runtime_config) {
    const runtime = content.runtime_config as DomainOiRuntime;
    runtime.subtasks = runtime.subtasks.map((item) => ({
      ...item,
      scoring: (item.scoring as string) === 'all' ? 'min' : item.scoring ?? 'min',
      depends_on: item.depends_on ?? [],
      cases: item.cases.map((test, index) => ({ ...test, id: test.id ?? `${item.id}_${index + 1}` })),
    }));
  }
  return content;
}
/** 空预算表示采用实例默认值，不能发送空字符串冒充数字。 */
export function domainEditorPayload(content: DomainEditorContent): DomainEditorContent {
  const result = JSON.parse(JSON.stringify(content)) as DomainEditorContent;
  if (result.llm_config) {
    const { max_calls, max_tokens, models } = result.llm_config;
    result.llm_config = { max_calls, max_tokens, ...(models ? { models } : {}) };
    for (const key of ['max_calls', 'max_tokens'] as const) {
      const value = result.llm_config[key] as unknown;
      if (value == null || value === '') delete result.llm_config[key];
    }
  }
  if (result.kind === 'ai' && (result.artifact_max_size_mb as unknown) === '') result.artifact_max_size_mb = null;
  if (result.kind === 'ai' && result.submission_mode === 'prediction') {
    const runtime = result.runtime_config as DomainAiRuntime;
    delete (runtime as Partial<DomainAiRuntime>).solution;
    if ((runtime.evaluator.workspace_size_mb as unknown) === '') delete runtime.evaluator.workspace_size_mb;
  }
  if (result.kind === 'oi') {
    const runtime = result.runtime_config as DomainOiRuntime;
    if (runtime.filename === '') delete runtime.filename;
    if (runtime.checker.type !== 'testlib') delete runtime.checker.path;
  }
  return result;
}
