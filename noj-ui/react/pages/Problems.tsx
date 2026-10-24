/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { ListFilter, Plus, Search } from 'lucide-react';
import { Button, Card, Empty, Input, Select, Space, Table, Tag } from '../components/primitives.tsx';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { positiveInteger, problemQuery } from '../routes.ts';
import { useResource } from '../state.tsx';
import type { ProblemList } from '../types.ts';
import { Difficulty, PageHeading, ResourceBoundary } from '../components/Common.tsx';

export function Problems() {
  const [params, setParams] = useSearchParams();
  const urlKeyword = params.get('keyword') ?? '';
  const [keyword, setKeyword] = useState(urlKeyword);
  useEffect(() => setKeyword(urlKeyword), [urlKeyword]);
  const resource = useResource<ProblemList>(problemQuery(params.toString()));
  const tags = useResource<{ data: { id: string; name: string }[] }>('/api/v1/tags');
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
      <PageHeading
        title='题库'
        extra={<Button href='/problems/new' icon={<Plus aria-hidden='true' />}>创建题目</Button>}
      />
      <Card className='mb-5' size='sm'>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            filter('keyword', keyword.trim());
          }}
          className='flex flex-wrap gap-3'
        >
          <Input
            className='!w-full sm:!w-72'
            prefix={<Search aria-hidden='true' />}
            aria-label='搜索题目'
            placeholder='题目编号或关键词'
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            allowClear
          />
          <Button type='submit' icon={<Search aria-hidden='true' />}>搜索</Button>
          <Select
            aria-label='难度'
            placeholder='全部难度'
            allowClear
            className='min-w-28'
            value={params.get('difficulty') || undefined}
            onChange={(value) => filter('difficulty', value)}
            options={[{ value: 'easy', label: '简单' }, { value: 'medium', label: '中等' }, {
              value: 'hard',
              label: '困难',
            }]}
          />
          <Select
            aria-label='题库类型'
            placeholder='全部题库'
            allowClear
            className='min-w-28'
            value={params.get('type') || undefined}
            onChange={(value) => filter('type', value)}
            options={[{ value: 'P', label: '主题题库' }, { value: 'U', label: '用户题库' }]}
          />
          <Select
            aria-label='评测类型'
            placeholder='全部评测类型'
            allowClear
            className='min-w-32'
            value={params.get('judge_type') || undefined}
            onChange={(value) => filter('judge_type', value)}
            options={[{ value: 'dual', label: '工程题' }, { value: 'oi', label: 'OI 题' }]}
          />
          <Select
            aria-label='题目标签'
            placeholder='全部标签'
            allowClear
            showSearch
            optionFilterProp='label'
            className='min-w-36'
            value={params.get('tag') || undefined}
            onChange={(value) => filter('tag', value)}
            options={tags.data?.data.map((tag) => ({ value: tag.id, label: tag.name }))}
          />
          {params.size > 0 && (
            <Button
              icon={<ListFilter aria-hidden='true' />}
              onClick={() => {
                setKeyword('');
                setParams({});
              }}
            >
              重置筛选
            </Button>
          )}
        </form>
      </Card>
      <Card
        title={
          <Space>
            <span>公开题目</span>
            {resource.data && <Tag className='tabular-nums'>{resource.data.total} 题</Tag>}
          </Space>
        }
      >
        <ResourceBoundary {...resource} hasData={Boolean(resource.data)} retry={resource.refresh}>
          <Table
            rowKey='id'
            loading={resource.loading}
            dataSource={resource.data?.data}
            scroll={{ x: 650 }}
            locale={{ emptyText: <Empty description='没有符合筛选条件的题目，试试其他关键词' /> }}
            pagination={{
              current: positiveInteger(params.get('page')),
              pageSize: 20,
              total: resource.data?.total,
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
                title: '编号',
                dataIndex: 'display_id',
                width: 90,
                render: (value) => <span className='font-mono text-xs text-text-muted'>{value}</span>,
              },
              {
                title: '题目',
                render: (_, problem) => (
                  <div>
                    <Link
                      to={`/problems/${encodeURIComponent(problem.display_id || problem.id)}`}
                      className='font-semibold'
                    >
                      {problem.title}
                    </Link>
                    <div className='mt-2 flex flex-wrap gap-1'>
                      {problem.is_objective && <Tag>客观题</Tag>}
                      {problem.judge_type === 'oi' && <Tag>OI</Tag>}
                      {problem.tags?.map((tag) => <Tag key={tag.id}>{tag.name}</Tag>)}
                    </div>
                  </div>
                ),
              },
              { title: '难度', dataIndex: 'difficulty', width: 95, render: (value) => <Difficulty value={value} /> },
              { title: '出题人', width: 150, render: (_, problem) => problem.owner_username ?? '平台题库' },
            ]}
          />
        </ResourceBoundary>
      </Card>
    </>
  );
}
