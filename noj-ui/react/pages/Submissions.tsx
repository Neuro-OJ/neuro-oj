/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { Alert, Card, Descriptions, Input, Select, Space, Table, Tag } from '../components/primitives.tsx';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  formatMemory,
  formatScore,
  formatTime,
  getLanguageLabel,
  resultLabels,
  submissionVersionLabel,
} from '../../utils/submissionFormat.ts';
import { normalizeSubmissionCases } from '../../utils/submissionCaseResults.ts';
import { isTerminal, positiveInteger, submissionsQuery } from '../routes.ts';
import { useLiveRefresh, useResource } from '../state.tsx';
import type { Submission, SubmissionList } from '../types.ts';
import { CodeOutput, PageHeading, ResourceBoundary, SubmissionStatus, Timestamp } from '../components/Common.tsx';

export function Submissions() {
  const [params, setParams] = useSearchParams();
  const resource = useResource<SubmissionList>(submissionsQuery(params.toString()));
  function filter(key: string, value?: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('page');
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }
  return (
    <>
      <PageHeading title='提交历史' />
      <Card size='sm' className='mb-5'>
        <Space wrap>
          <Input.Search
            aria-label='按题目搜索提交'
            placeholder='题目编号或标题'
            key={params.get('problem_search') ?? ''}
            defaultValue={params.get('problem_search') ?? ''}
            onSearch={(value) => filter('problem_search', value)}
            allowClear
            className='!w-60'
          />
          <Select
            aria-label='提交状态'
            placeholder='全部状态'
            className='min-w-32'
            value={params.get('status') || undefined}
            allowClear
            onChange={(value) => filter('status', value)}
            options={[
              { value: 'pending', label: '排队中' },
              { value: 'judging', label: '评测中' },
              { value: 'finished', label: '已评测' },
              { value: 'error', label: '出错' },
            ]}
          />
          <Select
            aria-label='提交语言'
            placeholder='全部语言'
            className='min-w-32'
            value={params.get('language') || undefined}
            allowClear
            onChange={(value) => filter('language', value)}
            options={[
              { value: 'python3', label: 'Python 3' },
              { value: 'cc', label: 'C++11' },
              { value: 'c', label: 'C99' },
            ]}
          />
        </Space>
      </Card>
      <Card>
        <ResourceBoundary {...resource} hasData={Boolean(resource.data)} retry={resource.refresh}>
          <Table
            rowKey='id'
            loading={resource.loading}
            dataSource={resource.data?.data}
            scroll={{ x: 850 }}
            pagination={{
              current: positiveInteger(params.get('page')),
              pageSize: 20,
              total: resource.data?.pagination.total,
              showSizeChanger: false,
              onChange: (page) =>
                setParams((previous) => {
                  const next = new URLSearchParams(previous);
                  next.set('page', String(page));
                  return next;
                }),
            }}
            columns={[
              {
                title: '提交',
                render: (_, submission) => (
                  <Link
                    to={`/submissions/${encodeURIComponent(submission.public_id ?? submission.id)}`}
                    className='font-mono text-xs'
                  >
                    {submission.public_id ?? submission.id.slice(0, 8)}
                  </Link>
                ),
              },
              {
                title: '题目',
                render: (_, submission) => (
                  <Link to={`/problems/${encodeURIComponent(submission.problem?.display_id ?? submission.problem_id)}`}>
                    {submission.problem?.title ?? submission.problem_id}
                  </Link>
                ),
              },
              {
                title: '状态与分数',
                render: (_, submission) => <SubmissionStatus status={submission.status} result={submission.result} />,
              },
              { title: '语言', dataIndex: 'language', render: getLanguageLabel },
              { title: '版本', render: (_, submission) => submissionVersionLabel(submission) },
              { title: '提交时间', dataIndex: 'created_at', render: (value) => <Timestamp value={value} /> },
            ]}
          />
        </ResourceBoundary>
      </Card>
    </>
  );
}

export function SubmissionDetail() {
  const { id = '' } = useParams();
  const url = `/api/v1/submissions/${encodeURIComponent(id)}`;
  const resource = useResource<{ data: Submission }>(url);
  const submission = resource.data?.data;
  useLiveRefresh(url, Boolean(submission && !isTerminal(submission.status) && !resource.error), resource.refresh);
  const cases = normalizeSubmissionCases(submission?.result?.details);
  const latestAttempt = submission?.attempts?.find((attempt) =>
    attempt.sequence === Math.max(...(submission?.attempts ?? []).map((item) => item.sequence))
  );
  return (
    <>
      <Link to='/submissions' className='mb-5 inline-block text-sm'>返回提交记录</Link>
      <ResourceBoundary {...resource} hasData={Boolean(submission)} retry={resource.refresh}>
        {submission && (
          <>
            <PageHeading
              title={`提交 ${submission.public_id ?? submission.id.slice(0, 8)}`}
              extra={<SubmissionStatus status={submission.status} result={submission.result} />}
            />
            {latestAttempt?.result_kind === 'platform_error' && (
              <div className='mb-5'>
                <Alert type='warning' showIcon title='最近一次执行发生平台错误，已有正式判定仍按有效版本策略保留。' />
              </div>
            )}
            <Card>
              <Descriptions
                column={{ xs: 1, sm: 2, lg: 3 }}
                items={[
                  {
                    key: 'problem',
                    label: '题目',
                    children: (
                      <Link
                        to={`/problems/${encodeURIComponent(submission.problem?.display_id ?? submission.problem_id)}`}
                      >
                        {submission.problem?.title ?? submission.problem_id}
                      </Link>
                    ),
                  },
                  { key: 'version', label: '提交版本', children: submissionVersionLabel(submission) },
                  { key: 'language', label: '语言', children: getLanguageLabel(submission.language) },
                  {
                    key: 'score',
                    label: '分数',
                    children: <span className='tabular-nums'>{formatScore(submission.result?.score)}</span>,
                  },
                  { key: 'time', label: '耗时', children: formatTime(submission.result?.time_ms) },
                  { key: 'memory', label: '内存', children: formatMemory(submission.result?.memory_kb) },
                  { key: 'created', label: '提交时间', children: <Timestamp value={submission.created_at} /> },
                  ...(submission.queue_position != null
                    ? [{ key: 'queue', label: '队列位置', children: String(submission.queue_position) }]
                    : []),
                ]}
              />
            </Card>
            {submission.version_results && submission.version_results.length > 0 && (
              <Card title='各版本正式成绩' className='mt-5'>
                <Table
                  rowKey='attempt_id'
                  size='sm'
                  pagination={false}
                  scroll={{ x: 450 }}
                  dataSource={submission.version_results}
                  columns={[
                    {
                      title: '版本',
                      render: (_, value) =>
                        value.version != null ? `v${value.version}` : '未知历史版本',
                    },
                    {
                      title: '结果',
                      dataIndex: 'status',
                      render: (status) =>
                        resultLabels[status] ?? status,
                    },
                    { title: '分数', dataIndex: 'score', render: formatScore },
                    {
                      title: '成绩指针',
                      render: (_, value) => (
                        <Space>
                          {value.is_effective && <Tag color='processing'>有效成绩</Tag>}
                          {value.is_accepted && <Tag color='success'>通过</Tag>}
                        </Space>
                      ),
                    },
                  ]}
                />
              </Card>
            )}
            {submission.attempts && submission.attempts.length > 0 && (
              <Card title='完整评测尝试' className='mt-5'>
                <Table
                  rowKey='attempt_id'
                  size='sm'
                  pagination={false}
                  scroll={{ x: 650 }}
                  dataSource={submission.attempts}
                  columns={[
                    { title: '序号', dataIndex: 'sequence' },
                    {
                      title: '来源',
                      dataIndex: 'source',
                      render: (value) =>
                        ({ initial: '首次提交', rejudge: '重测', upgrade: '升级', legacy_import: '存量导入' } as Record<
                          string,
                          string
                        >)[value] ?? value,
                    },
                    {
                      title: '版本',
                      render: (_, value) => value.version != null ? `v${value.version}` : '未知历史版本',
                    },
                    {
                      title: '状态',
                      render: (_, value) =>
                        value.result_kind === 'platform_error' ? '平台错误' : resultLabels[value.status] ?? value.state,
                    },
                    { title: '分数', dataIndex: 'score', render: formatScore },
                    { title: '时间', dataIndex: 'created_at', render: (value) => <Timestamp value={value} /> },
                  ]}
                />
              </Card>
            )}
            {cases.length > 0 && (
              <Card title='测试点结果' className='mt-5'>
                <Table
                  rowKey='caseId'
                  size='sm'
                  pagination={false}
                  scroll={{ x: 500 }}
                  dataSource={cases}
                  columns={[
                    { title: '测试点', dataIndex: 'caseId' },
                    { title: '结果', dataIndex: 'status', render: (status) => resultLabels[status] ?? status },
                    { title: '耗时', dataIndex: 'timeMs', render: formatTime },
                    { title: '内存', dataIndex: 'memoryKb', render: formatMemory },
                  ]}
                  expandable={{
                    rowExpandable: (item) => item.visibility === 'visible',
                    expandedRowRender: (item) => (
                      <>
                        <CodeOutput title='输入' value={item.input} />
                        <CodeOutput title='预期输出' value={item.expectedOutput} />
                        <CodeOutput title='实际输出' value={item.actualOutput} />
                      </>
                    ),
                  }}
                />
              </Card>
            )}
            {(submission.code != null || submission.result?.output != null) && (
              <Card className='mt-5'>
                {submission.code != null && <CodeOutput title='提交代码' value={submission.code} />}
                {submission.result?.output != null && <CodeOutput title='评测输出' value={submission.result.output} />}
                {submission.result?.output_truncated && <p className='text-sm text-warning-text'>输出已截断</p>}
              </Card>
            )}
          </>
        )}
      </ResourceBoundary>
    </>
  );
}
