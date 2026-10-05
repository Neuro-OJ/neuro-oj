/** 做题工作区只展示服务端允许提交的语言。 */
export interface EditorLanguageConfig {
  judge_type?: 'dual' | 'oi';
  supported_languages?: string[];
}

/** 兼容旧 Python 题；OI 题缺少白名单时禁止猜测可用语言。 */
export function getEditorLanguages(problem: EditorLanguageConfig | null) {
  const allowed = problem?.supported_languages ?? (problem?.judge_type === 'oi' ? [] : ['python3']);
  return [
    { value: 'cc', label: 'C++11' },
    { value: 'c', label: 'C99' },
    { value: 'python3', label: 'Python 3' },
  ].filter((option) => allowed.includes(option.value));
}

/** 后端 cc 标识对应 Monaco 的 cpp 语言模式。 */
export function getMonacoLanguage(language = 'python3'): string {
  return ({
    python3: 'python',
    python: 'python',
    cc: 'cpp',
    cpp: 'cpp',
    c: 'c',
    javascript: 'javascript',
    js: 'javascript',
  } as Record<string, string>)[language] ?? 'plaintext';
}
