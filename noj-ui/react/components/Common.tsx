/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { Alert, Button, Empty, Result, Skeleton, Space, Tag } from './primitives.tsx';
import type { PropsWithChildren } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime, formatScore, resultLabels } from '../../utils/submissionFormat.ts';
import type { ResourceError } from '../types.ts';

export function ResourceBoundary({ error, loading, retry, hasData, children }: PropsWithChildren<{
  error?: ResourceError;
  loading: boolean;
  retry: () => void;
  hasData: boolean;
}>) {
  if (!hasData && error?.status === 404) {
    return (
      <Result
        status='404'
        title={error.message}
        extra={<Link to='/problems'>返回题库</Link>}
      />
    );
  }
  if (!hasData && loading) return <Skeleton active paragraph={{ rows: 6 }} />;
  return (
    <>
      {error && (
        <div className='mb-5'>
          <Alert
            type='error'
            showIcon
            title={error.message}
            description={error.requestId ? `请求编号：${error.requestId}` : undefined}
            action={<Button size='sm' onClick={retry}>重试</Button>}
          />
        </div>
      )}
      {hasData ? children : !error && <Empty description='暂无数据' />}
    </>
  );
}

export function PageHeading({ eyebrow, title, description, extra }: {
  eyebrow?: string;
  title: string;
  description?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className='mb-7 flex flex-wrap items-end justify-between gap-4'>
      <div>
        {eyebrow && <p className='mb-2 font-mono text-xs tracking-widest text-primary'>{eyebrow}</p>}
        <h1 className='m-0 text-2xl font-semibold tracking-tight text-text md:text-3xl'>{title}</h1>
        {description && <p className='mb-0 mt-3 max-w-2xl text-sm leading-6 text-text-secondary'>{description}</p>}
      </div>
      {extra}
    </div>
  );
}

export function Difficulty({ value }: { value: string }) {
  const labels: Record<string, string> = { easy: '简单', medium: '中等', hard: '困难' };
  return (
    <Tag color={({ easy: 'success', medium: 'processing', hard: 'warning' } as Record<string, string>)[value]}>
      {labels[value] ?? value}
    </Tag>
  );
}

export function SubmissionStatus(
  { status, result }: { status: string; result?: { status: string; score: number } | null },
) {
  const labels: Record<string, string> = {
    pending: '排队中',
    judging: '评测中',
    finished: '已评测',
    error: '出错',
    cancelled: '已取消',
  };
  return (
    <Space size={4} wrap>
      <Tag color={status === 'finished' ? 'success' : status === 'error' ? 'error' : 'processing'}>
        {labels[status] ?? status}
      </Tag>
      {result && (
        <span className='tabular-nums'>
          {formatScore(result.score)} 分 · {resultLabels[result.status] ?? result.status}
        </span>
      )}
    </Space>
  );
}

export function Timestamp({ value }: { value: string }) {
  return (
    <time dateTime={value} className='whitespace-nowrap tabular-nums text-text-secondary'>{formatDateTime(value)}</time>
  );
}

export function CodeOutput({ title, value }: { title: string; value?: string | null }) {
  return (
    <section className='mt-5'>
      <h3 className='mb-3 text-sm font-semibold'>{title}</h3>
      <pre className='max-h-96 overflow-auto rounded border border-border bg-bg-sunken p-4 font-mono text-sm whitespace-pre-wrap break-words'>{value ?? '暂无输出'}</pre>
    </section>
  );
}
