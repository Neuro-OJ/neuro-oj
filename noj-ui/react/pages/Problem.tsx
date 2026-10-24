/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { ArrowLeft, Code2 } from 'lucide-react';
import { Alert, Button, Card, Descriptions, Input, Select, Space, Tag } from '../components/primitives.tsx';
import { useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ARTIFACT_FILE_ACCEPT, PREDICTION_FILE_ACCEPT } from '../../utils/problemView.ts';
import { errorInfo } from '../api.ts';
import { problemEndpoint } from '../routes.ts';
import { useAppState, useResource, versionConflict } from '../state.tsx';
import type { Problem as ProblemData } from '../types.ts';
import { Difficulty, PageHeading, ResourceBoundary } from '../components/Common.tsx';
import { Markdown } from '../components/Markdown.tsx';

export function Problem() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const resource = useResource<{ data: ProblemData }>(problemEndpoint(id, params.toString()));
  const problem = resource.data?.data;
  const versions = useResource<{ data: { id: string; version: number; is_latest: boolean }[] }>(
    problem ? `/api/v1/problems/${encodeURIComponent(problem.id)}/versions?page=1&per_page=100` : null,
  );
  const versionQuery = params.get('version_id') ? `?version_id=${encodeURIComponent(params.get('version_id')!)}` : '';
  const classic = `/problems/${encodeURIComponent(id)}${versionQuery}`;
  const editor = `/editor/${encodeURIComponent(id)}${versionQuery}`;
  return (
    <>
      <Link to='/problems' className='mb-5 inline-flex items-center gap-2 text-sm'>
        <ArrowLeft aria-hidden='true' />返回题库
      </Link>
      <ResourceBoundary {...resource} hasData={Boolean(problem)} retry={resource.refresh}>
        {problem && (
          <>
            <PageHeading
              eyebrow={problem.display_id}
              title={problem.title}
              extra={
                <Space wrap>
                  <Difficulty value={problem.difficulty} />
                  <Tag>{problem.is_objective ? '客观题' : problem.judge_type === 'oi' ? 'OI 题' : '工程题'}</Tag>
                </Space>
              }
            />
            {!!problem.contest_secrecy?.length && (
              <div className='mb-5'>
                <Alert
                  type='warning'
                  showIcon
                  title='本题在未结束的公开赛中保密'
                  description='当前题面仅向有权限的用户提供；题解与讨论入口暂不开放。'
                />
              </div>
            )}
            <div className='grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_280px]'>
              <Card title='题目说明'>
                <Markdown content={problem.description} />
                {problem.samples?.map((sample, index) => (
                  <section key={sample.id} className='mt-7'>
                    <h3 className='mb-3 font-semibold'>样例 {index + 1}</h3>
                    <div className='grid gap-3 sm:grid-cols-2'>
                      <div>
                        <p className='text-sm text-text-muted'>输入</p>
                        <pre className='overflow-auto rounded bg-bg-sunken p-3 text-sm'>{sample.input}</pre>
                      </div>
                      <div>
                        <p className='text-sm text-text-muted'>输出</p>
                        <pre className='overflow-auto rounded bg-bg-sunken p-3 text-sm'>{sample.output}</pre>
                      </div>
                    </div>
                    {sample.explanation && <Markdown content={sample.explanation} />}
                  </section>
                ))}
              </Card>
              <div className='grid gap-5'>
                <Card size='sm' title='作答版本'>
                  <Select
                    className='w-full'
                    aria-label='作答版本'
                    value={params.get('version_id') ?? ''}
                    onChange={(value) =>
                      setParams((previous) => {
                        const next = new URLSearchParams(previous);
                        if (value) next.set('version_id', value);
                        else next.delete('version_id');
                        return next;
                      })}
                    options={[
                      { value: '', label: '默认版本（按有效策略）' },
                      ...(versions.data?.data ?? []).map((version) => ({
                        value: version.id,
                        label: `v${version.version}${version.is_latest ? ' · 最新' : ''}`,
                      })),
                    ]}
                  />
                  <Descriptions
                    column={1}
                    size='sm'
                    className='mt-4'
                    items={[
                      {
                        key: 'version',
                        label: '当前版本',
                        children: problem.version != null ? `v${problem.version}` : '尚未发布',
                      },
                      {
                        key: 'policy',
                        label: '有效策略',
                        children: problem.effective_version_policy?.mode === 'exact' ? '固定版本' : '任意已发布版本',
                      },
                    ]}
                  />
                  {versions.error && (
                    <p className='mt-3 text-xs text-text-secondary'>版本列表暂不可用，当前版本仍可作答。</p>
                  )}
                  {problem.is_latest === false && (
                    <p className='mt-3 text-xs text-warning-text'>正在查看历史版本，提交会绑定此版本。</p>
                  )}
                </Card>
                <Card size='sm' title='开始练习'>
                  {!problem.version_id
                    ? <Alert type='info' title='本题尚未发布版本，暂时无法提交。' />
                    : problem.is_objective || problem.submission_mode === 'ui'
                    ? (
                      <>
                        <Button variant='default' href={problem.submission_mode === 'ui' ? editor : classic} block>
                          {problem.is_objective ? '开始作答' : '打开界面'}
                        </Button>
                      </>
                    )
                    : problem.submission_mode === 'artifact' || problem.submission_mode === 'prediction'
                    ? (
                      <FileSubmission
                        key={`${problem.id}:${problem.version_id}`}
                        problem={problem}
                        refresh={resource.refresh}
                      />
                    )
                    : (
                      <>
                        <Link to={editor}>
                          <Button variant='default' block icon={<Code2 aria-hidden='true' />}>
                            开始编码
                          </Button>
                        </Link>
                      </>
                    )}
                </Card>
                {!!problem.tags?.length && (
                  <Card size='sm' title='题目标签'>
                    <Space size={[4, 8]} wrap>{problem.tags.map((tag) => <Tag key={tag.id}>{tag.name}</Tag>)}</Space>
                  </Card>
                )}
              </div>
            </div>
          </>
        )}
      </ResourceBoundary>
    </>
  );
}

function FileSubmission({ problem, refresh }: { problem: ProblemData; refresh: () => void }) {
  const { api, user } = useAppState();
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [submissionId, setSubmissionId] = useState('');
  const prediction = problem.submission_mode === 'prediction';
  const accept = prediction ? PREDICTION_FILE_ACCEPT : ARTIFACT_FILE_ACCEPT;
  async function submit() {
    if (!file || !problem.version_id) return;
    setSending(true);
    setError('');
    try {
      const body = new FormData();
      body.append('problem_id', problem.id);
      body.append('version_id', problem.version_id);
      body.append('language', 'python3');
      body.append('file', file);
      const response = await api.post<{ data: { id: string; public_id?: string } }>('/api/v1/submissions', body, {
        silent: true,
        timeout: 120_000,
      });
      setSubmissionId(response.data.public_id ?? response.data.id);
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (caught) {
      setError(errorInfo(caught).message);
      if (versionConflict(caught)) refresh();
    } finally {
      setSending(false);
    }
  }
  if (!user) {
    return (
      <Link
        to={`/login?redirect=${
          encodeURIComponent(
            `/react/problems/${problem.display_id}?version_id=${encodeURIComponent(problem.version_id ?? '')}`,
          )
        }`}
      >
        <Button variant='default' block>登录后上传</Button>
      </Link>
    );
  }
  return (
    <Space orientation='vertical' className='w-full' size='middle'>
      <p className='m-0 text-sm text-text-secondary'>
        {prediction ? '上传单个预测结果文件。' : '上传 ZIP 格式的产物文件。'}
        {problem.artifact_max_size_mb ? `最大 ${problem.artifact_max_size_mb} MB。` : '文件大小遵循平台上限。'}
      </p>
      <Input
        ref={fileInput}
        type='file'
        aria-label='选择文件'
        accept={accept}
        disabled={sending}
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0];
          setFile(null);
          if (!selected) return;
          const extensions = prediction ? PREDICTION_FILE_ACCEPT.split(',') : ['.zip'];
          if (!extensions.some((extension) => selected.name.toLowerCase().endsWith(extension))) {
            setError('文件格式不符合要求');
            return;
          }
          if (problem.artifact_max_size_mb && selected.size > problem.artifact_max_size_mb * 1024 * 1024) {
            setError('文件超过题目大小上限');
            return;
          }
          setFile(selected);
          setError('');
        }}
      />
      {error && <Alert type='error' showIcon title={error} />}
      {submissionId && (
        <Alert
          type='success'
          title='提交成功'
          description={<Link to={`/submissions/${encodeURIComponent(submissionId)}`}>查看评测结果</Link>}
        />
      )}
      <Button
        aria-label='提交评测'
        variant='default'
        block
        loading={sending}
        disabled={!file}
        onClick={() => void submit()}
      >
        提交评测
      </Button>
    </Space>
  );
}
