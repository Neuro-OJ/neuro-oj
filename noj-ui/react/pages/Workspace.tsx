/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { ArrowLeft, CirclePlay, Send } from 'lucide-react';
import { Alert, Button, Card, Input, Select, Space, Tabs, Tag } from '../components/primitives.tsx';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { getEditorLanguages } from '../../utils/editorLanguages.ts';
import { errorInfo } from '../api.ts';
import { draftKey, isTerminal, problemEndpoint } from '../routes.ts';
import { useAppState, useResource, versionConflict } from '../state.tsx';
import type { Problem, SelfTest } from '../types.ts';
import { CodeOutput, PageHeading, ResourceBoundary, SubmissionStatus } from '../components/Common.tsx';
import { CodeEditor } from '../components/CodeEditor.tsx';
import { Markdown } from '../components/Markdown.tsx';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.tsx';

export function Workspace() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const resource = useResource<{ data: Problem }>(problemEndpoint(id, params.toString()));
  const problem = resource.data?.data;
  return (
    <>
      <Link
        to={`/problems/${encodeURIComponent(id)}${params.size ? `?${params}` : ''}`}
        className='mb-5 inline-flex items-center gap-2 text-sm'
      >
        <ArrowLeft aria-hidden='true' />返回题目
      </Link>
      <ResourceBoundary {...resource} retry={resource.refresh} hasData={Boolean(problem)}>
        {problem && (problem.is_objective || (problem.submission_mode && problem.submission_mode !== 'code')
          ? (
            <Alert
              type='info'
              showIcon
              title='这道题使用专用作答模式'
              description={
                <Link to={`/problems/${encodeURIComponent(id)}${params.size ? `?${params}` : ''}`}>
                  返回题目查看作答入口
                </Link>
              }
            />
          )
          : problem && (
            <WorkspaceEditor
              key={`${problem.id}:${problem.version_id}`}
              problem={problem}
              refreshProblem={resource.refresh}
            />
          ))}
      </ResourceBoundary>
    </>
  );
}

function WorkspaceEditor({ problem, refreshProblem }: { problem: Problem; refreshProblem: () => void }) {
  const { api, user } = useAppState();
  const [templateCode, setTemplateCode] = useState<string | null>(null);
  const languages = getEditorLanguages(problem);
  const [language, setLanguage] = useState(languages[0]?.value ?? '');
  const [draft, setDraft] = useState({ key: '', code: '', dirty: false });
  const [storageError, setStorageError] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [submitted, setSubmitted] = useState('');
  const [selfTestId, setSelfTestId] = useState<string | null>(null);
  const [customInput, setCustomInput] = useState('');
  const storage = user && problem.version_id ? draftKey(user.id, problem.id, problem.version_id, language) : '';
  const code = draft.key === storage ? draft.code : '';
  const selfTestUrl = selfTestId ? `/api/v1/self-tests/${encodeURIComponent(selfTestId)}` : null;
  const selfTest = useResource<{ data: SelfTest }>(selfTestUrl);
  const running = Boolean(selfTestId && !selfTest.error && (!selfTest.data || !isTerminal(selfTest.data.data.status)));
  // 自测接口目前只保证轮询协议，不向不存在的 SSE 端点建立连接。
  useEffect(() => {
    if (!running) return;
    const timer = globalThis.setTimeout(selfTest.refresh, 1500);
    return () => globalThis.clearTimeout(timer);
  }, [running, selfTest.data, selfTest.loading, selfTest.refresh]);

  useEffect(() => {
    const controller = new AbortController();
    setStorageError('');
    setSubmitted('');
    setSelfTestId(null);
    if (!storage) {
      setDraft({ key: storage, code: '', dirty: false });
      return;
    }
    try {
      const saved = localStorage.getItem(storage);
      if (saved !== null) {
        setDraft({ key: storage, code: saved, dirty: true });
        return;
      }
    } catch {
      setStorageError('无法读取本地草稿；本次代码仍可编辑和提交。');
    }
    setDraft({ key: storage, code: '', dirty: false });
    const version = problem.version_id ? `?version_id=${encodeURIComponent(problem.version_id)}` : '';
    void api.get<{ data: { content: string; language: string } }>(
      `/api/v1/problems/${encodeURIComponent(problem.id)}/template${version}`,
      { silent: true, signal: controller.signal },
    ).then((response) => {
      if (controller.signal.aborted || response.data.language !== language) return;
      setDraft((previous) =>
        previous.key === storage && !previous.dirty ? { ...previous, code: response.data.content } : previous
      );
    }).catch((caught) => {
      if (!controller.signal.aborted && errorInfo(caught).status !== 404) {
        setStorageError('模板暂不可用，可以直接编写代码，或稍后重载模板。');
      }
    });
    return () => controller.abort();
  }, [storage, api, problem.id, problem.version_id, language]);
  useEffect(() => {
    if (!storage || draft.key !== storage || !draft.dirty) return;
    try {
      localStorage.setItem(storage, draft.code);
    } catch {
      setStorageError('本地空间不足，代码未能保存为草稿；请先复制备份。');
    }
  }, [draft, storage]);

  function updateCode(value: string) {
    setDraft({ key: storage, code: value, dirty: true });
  }
  async function resetTemplate() {
    try {
      const response = await api.get<{ data: { content: string; language: string } }>(
        `/api/v1/problems/${encodeURIComponent(problem.id)}/template?version_id=${
          encodeURIComponent(problem.version_id ?? '')
        }`,
        { silent: true },
      );
      if (response.data.language !== language) {
        setError('此模板对应其他语言，请先选择相应语言。');
        return;
      }
      setTemplateCode(response.data.content);
    } catch (caught) {
      setError(errorInfo(caught).message);
    }
  }
  async function submit(selfTesting: boolean) {
    if (!problem.version_id || !code.trim() || !languages.some((item) => item.value === language)) return;
    setError('');
    if (selfTesting) setTesting(true);
    else setSending(true);
    try {
      const body = {
        problem_id: problem.id,
        version_id: problem.version_id,
        language,
        code,
        ...(selfTesting && problem.judge_type === 'oi'
          ? {
            cases: customInput ? [{ id: 'custom_1', input: customInput }] : (problem.samples ?? []).map((sample) => ({
              id: `sample_${sample.id}`,
              input: sample.input,
              expected_output: sample.output,
            })),
          }
          : {}),
      };
      if (selfTesting && problem.judge_type === 'oi' && (!body.cases || body.cases.length === 0)) {
        setError('请在自测面板输入测试数据，或使用包含样例的题目。');
        return;
      }
      const response = await api.post<{ data: { id: string; public_id?: string } }>(
        selfTesting ? `/api/v1/problems/${encodeURIComponent(problem.id)}/self-test` : '/api/v1/submissions',
        body,
        { silent: true },
      );
      if (selfTesting) setSelfTestId(response.data.id);
      else setSubmitted(response.data.public_id ?? response.data.id);
    } catch (caught) {
      setError(errorInfo(caught).message);
      // 冲突后保留当前版本与草稿，由用户明确选择刷新，绝不自动换版重提。
      if (versionConflict(caught)) setError(`${errorInfo(caught).message}。代码草稿已保留，请确认题目版本后重试。`);
    } finally {
      setSending(false);
      setTesting(false);
    }
  }
  const canSend = Boolean(problem.version_id && code.trim() && language && !sending && !testing);
  return (
    <>
      <AlertDialog
        open={templateCode !== null}
        onOpenChange={(open) => {
          if (!open) setTemplateCode(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重置为模板</AlertDialogTitle>
            <AlertDialogDescription>这将覆盖当前代码并替换本地草稿，是否继续？</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (templateCode !== null) updateCode(templateCode);
                setTemplateCode(null);
              }}
            >
              重置
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PageHeading
        eyebrow={problem.display_id}
        title={problem.title}
        extra={
          <Space>
            <Tag>{problem.version != null ? `作答版本 v${problem.version}` : '尚未发布版本'}</Tag>
            <Button
              href={`/editor/${encodeURIComponent(problem.display_id)}?version_id=${
                encodeURIComponent(problem.version_id ?? '')
              }`}
            >
              做题工作区
            </Button>
          </Space>
        }
      />
      {storageError && (
        <div className='mb-4'>
          <Alert type='warning' showIcon title={storageError} />
        </div>
      )}
      {error && (
        <div className='mb-4'>
          <Alert
            type='error'
            showIcon
            title={error}
            action={<Button size='sm' onClick={refreshProblem}>刷新题面</Button>}
          />
        </div>
      )}
      {submitted && (
        <div className='mb-4'>
          <Alert
            type='success'
            showIcon
            title='提交已进入评测队列'
            description={<Link to={`/submissions/${encodeURIComponent(submitted)}`}>查看本次评测结果</Link>}
          />
        </div>
      )}
      <div className='grid items-start gap-5 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)]'>
        <Card className='min-w-0' title='题目说明'>
          <Markdown content={problem.description} />
          {problem.samples?.map((sample, index) => (
            <div key={sample.id} className='mt-5'>
              <CodeOutput title={`样例 ${index + 1} 输入`} value={sample.input} />
              <CodeOutput title='预期输出' value={sample.output} />
            </div>
          ))}
        </Card>
        <div className='min-w-0 space-y-5'>
          <Card
            className='overflow-hidden'
            styles={{ body: { padding: 0 } }}
            title={
              <Select
                aria-label='编程语言'
                className='min-w-32'
                options={languages}
                value={language || undefined}
                onChange={setLanguage}
                disabled={sending || testing}
              />
            }
            extra={
              <Button
                size='sm'
                disabled={!problem.version_id || sending || testing}
                onClick={() => void resetTemplate()}
              >
                重载模板
              </Button>
            }
          >
            {!languages.length && <Alert type='warning' title='题目未提供可提交的语言，请在做题工作区查看完整配置。' />}
            <CodeEditor
              value={code}
              language={language}
              onChange={updateCode}
              disabled={sending || testing || !problem.version_id}
            />
            <div className='flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3'>
              <span className='text-xs text-text-muted'>
                {draft.dirty ? '草稿自动保存在本机' : '编写代码后自动保存'} ·{' '}
                {problem.version != null ? `v${problem.version}` : '未发布'}
              </span>
              <Space wrap>
                <Button
                  aria-label='运行自测'
                  icon={<CirclePlay aria-hidden='true' />}
                  disabled={!canSend || running}
                  loading={testing}
                  onClick={() => void submit(true)}
                >
                  运行自测
                </Button>
                <Button
                  variant='default'
                  aria-label='提交评测'
                  icon={<Send aria-hidden='true' />}
                  disabled={!canSend}
                  loading={sending}
                  onClick={() => void submit(false)}
                >
                  提交评测
                </Button>
              </Space>
            </div>
          </Card>
          <Card size='sm'>
            <Tabs
              items={[
                {
                  key: 'self-test',
                  label: '自测',
                  children: (
                    <>
                      {problem.judge_type === 'oi' && (
                        <div className='mb-4'>
                          <label htmlFor='react-custom-input' className='mb-2 block text-sm font-medium'>
                            自定义输入（留空时运行题目样例）
                          </label>
                          <Input.TextArea
                            id='react-custom-input'
                            value={customInput}
                            onChange={(event) => setCustomInput(event.target.value)}
                            rows={4}
                            className='!font-mono'
                          />
                        </div>
                      )}
                      {!selfTestId
                        ? <p className='text-sm text-text-secondary'>自测只验证运行结果，不计入正式成绩。</p>
                        : (
                          <ResourceBoundary {...selfTest} hasData={Boolean(selfTest.data)} retry={selfTest.refresh}>
                            {selfTest.data && (
                              <>
                                <Space>
                                  <SubmissionStatus status={selfTest.data.data.status} />
                                  {running && (
                                    <Button
                                      size='sm'
                                      onClick={() => {
                                        void api.post(`/api/v1/self-tests/${selfTestId}/cancel`, {}).then(
                                          selfTest.refresh,
                                        ).catch(() => {});
                                      }}
                                    >
                                      停止自测
                                    </Button>
                                  )}
                                </Space>
                                <CodeOutput
                                  title='运行输出'
                                  value={selfTest.data.data.output ?? selfTest.data.data.error_message}
                                />
                                {(selfTest.data.data.details?.oi as {
                                  subtasks?: {
                                    cases?: { case_id: string; status: string; stdout?: string; stderr?: string }[];
                                  }[];
                                } | undefined)?.subtasks?.flatMap((subtask) => subtask.cases ?? []).map((item) => (
                                  <section key={item.case_id} className='mt-4 rounded border border-border p-3'>
                                    <p className='text-sm font-medium'>{item.case_id} · {item.status}</p>
                                    {item.stdout != null && (
                                      <CodeOutput title='标准输出 · stdout' value={item.stdout} />
                                    )}
                                    {item.stderr && <CodeOutput title='标准错误 · stderr' value={item.stderr} />}
                                  </section>
                                ))}
                              </>
                            )}
                          </ResourceBoundary>
                        )}
                    </>
                  ),
                },
                {
                  key: 'history',
                  label: '提交记录',
                  children: (
                    <Link to={`/submissions?problem_id=${encodeURIComponent(problem.id)}`}>查看本题的正式提交记录</Link>
                  ),
                },
              ]}
            />
          </Card>
        </div>
      </div>
    </>
  );
}
