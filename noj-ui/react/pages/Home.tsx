/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { CirclePlay, Pause, RefreshCw } from 'lucide-react';
import { Alert, Button, Card, Carousel, Empty, Space, Table, Tag } from '../components/primitives.tsx';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DEFAULT_GRADIENT, gradientClass } from '../../utils/carouselGradient.ts';
import { safeRedirect } from '../routes.ts';
import { useAppState, useResource } from '../state.tsx';
import type { ProblemList, Submission } from '../types.ts';
import { Difficulty, ResourceBoundary, SubmissionStatus } from '../components/Common.tsx';

interface Slide {
  id: string;
  kind: string;
  title: string | null;
  subtitle: string | null;
  image_storage_url: string | null;
  link_url: string | null;
  gradient_key: string | null;
}
interface Announcement {
  id: string;
  public_id?: string;
  title: string;
  excerpt: string;
  is_pinned: boolean;
}
interface FeedItem {
  kind: string;
  post: { id: string; public_id?: string; title: string | null; content: string };
  author: { username: string };
}

export function Home() {
  const { user, api } = useAppState();
  const [page, setPage] = useState(1);
  const [paused, setPaused] = useState(true);
  const [checkingIn, setCheckingIn] = useState(false);
  const resource = useResource<ProblemList>(`/api/v1/problems?page=${page}&limit=6`);
  const slides = useResource<{ data: Slide[] }>('/api/v1/carousel/slides');
  const announcements = useResource<{ data: Announcement[] }>('/api/v1/announcements?per_page=10');
  const latest = useResource<{ data: Submission[] }>(
    user ? '/api/v1/submissions?per_page=10' : '/api/v1/submissions/public/recent?per_page=10',
  );
  const checkin = useResource<{ data: { checked_in: boolean; streak: number } }>(user ? '/api/v1/checkin/today' : null);
  const config = useResource<{ data: { follows_enabled: boolean; moments_enabled: boolean } }>(
    user ? '/api/v1/community/config' : null,
  );
  const feed = useResource<{ data: FeedItem[] }>(
    user && config.data?.data.follows_enabled && config.data.data.moments_enabled
      ? '/api/v1/community/feed?view=following&limit=5'
      : null,
  );
  useEffect(() => {
    const timer = setInterval(latest.refresh, 15000);
    return () => clearInterval(timer);
  }, [latest.refresh]);
  function randomize() {
    const next = Math.floor(Math.random() * Math.max(1, Math.ceil((resource.data?.total ?? 0) / 6))) + 1;
    setPage(next);
    if (next === page) resource.refresh();
  }
  async function checkIn() {
    setCheckingIn(true);
    try {
      await api.post('/api/v1/checkin');
      checkin.refresh();
    } catch {
      /* 统一 API 层显示业务错误。 */
    } finally {
      setCheckingIn(false);
    }
  }
  const welcome = (
    <div className={`flex min-h-[320px] flex-col justify-center bg-gradient-to-br p-8 md:p-12 ${DEFAULT_GRADIENT}`}>
      <h1 className='mb-3 text-2xl font-bold md:text-3xl'>Neuro OJ 正式上线</h1>
      <p className='max-w-[480px] text-sm leading-relaxed text-text-secondary md:text-base'>
        面向 AI 领域认证与竞赛的在线评测平台现已开放注册，提供代码评测、LLM 工程题与类 Kaggle 产物提交评测。
      </p>
    </div>
  );
  return (
    <>
      <section className='mb-5 grid overflow-hidden rounded-md border border-border bg-bg-panel lg:grid-cols-[minmax(0,1fr)_300px]'>
        <div className='relative min-w-0' aria-label='首页轮播'>
          {slides.data?.data.length
            ? (
              <Carousel autoplay={!paused} pauseOnFocus pauseOnHover>
                {slides.data.data.map((slide) => (
                  <div key={slide.id}>
                    <div
                      className={`relative flex min-h-[320px] flex-col justify-center bg-gradient-to-br p-8 md:p-12 ${
                        gradientClass(slide.gradient_key)
                      }`}
                    >
                      {slide.kind === 'image' && slide.image_storage_url && (
                        <img
                          className='absolute inset-0 size-full object-cover'
                          src={`/api/v1/carousel/slides/${encodeURIComponent(slide.id)}/image`}
                          alt={slide.title ?? '轮播图'}
                        />
                      )}
                      <div className='relative'>
                        <h2 className='mb-3 text-2xl font-bold md:text-3xl'>{slide.title}</h2>
                        <p className='max-w-[480px] text-sm leading-relaxed text-text-secondary md:text-base'>
                          {slide.subtitle}
                        </p>
                        {slide.link_url && (
                          <a href={safeRedirect(slide.link_url, '#')} className='mt-4 inline-block'>查看详情</a>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </Carousel>
            )
            : welcome}
          {(slides.data?.data.length ?? 0) > 1 && (
            <Button
              className='!absolute bottom-4 right-4'
              size='sm'
              icon={paused ? <CirclePlay aria-hidden='true' /> : <Pause aria-hidden='true' />}
              aria-label={paused ? '继续轮播' : '暂停轮播'}
              onClick={() => setPaused(!paused)}
            />
          )}
        </div>
        <div className='flex min-h-64 flex-col items-center justify-center gap-3 border-t border-border p-6 text-center lg:border-t-0 lg:border-l'>
          {user
            ? (
              <>
                <p className='text-lg font-semibold'>欢迎回来</p>
                <p className='text-sm text-text-muted'>{user.username}</p>
                <Button
                  variant='default'
                  disabled={checkin.loading || checkin.data?.data.checked_in}
                  loading={checkingIn}
                  onClick={() => void checkIn()}
                >
                  {checkin.data?.data.checked_in ? '已签到' : '签到'}
                </Button>
                {checkin.data && (
                  <p className='text-xs text-text-secondary tabular-nums'>
                    已连续签到 <strong className='text-primary'>{checkin.data.data.streak}</strong> 天
                  </p>
                )}
                {checkin.error && (
                  <Alert
                    type='error'
                    title={checkin.error.message}
                    action={<Button size='sm' onClick={checkin.refresh}>重试</Button>}
                  />
                )}
                <p className='text-xs text-text-muted'>按 UTC 日期统计 · UTC 0 点刷新</p>
              </>
            )
            : (
              <>
                <p className='text-lg font-semibold'>登录以解锁</p>
                <p className='text-sm text-text-muted'>签到、提交等完整功能</p>
                <Link to='/login'>
                  <Button variant='default'>登录</Button>
                </Link>
                <a href='/register' className='text-xs'>没有账号？立即注册</a>
              </>
            )}
        </div>
      </section>
      {!!announcements.data?.data.length && (
        <Card title='公告' className='mb-5'>
          <div className='space-y-3'>
            {announcements.data.data.map((item) => (
              <div className='flex flex-wrap items-center gap-3 rounded border border-border p-4' key={item.id}>
                {item.is_pinned && <Tag color='processing'>置顶</Tag>}
                <div className='min-w-0 flex-1'>
                  <p className='font-medium'>{item.title}</p>
                  <p className='mt-1 text-sm text-text-secondary'>{item.excerpt}</p>
                </div>
                <a href={`/announcements/${encodeURIComponent(item.public_id ?? item.id)}`}>点击查看详情</a>
              </div>
            ))}
          </div>
        </Card>
      )}
      <div className='grid items-start gap-5 lg:grid-cols-2'>
        <Card
          title='随机题目'
          extra={
            <Button
              size='sm'
              icon={<RefreshCw aria-hidden='true' />}
              aria-label='换一批'
              loading={resource.loading}
              onClick={randomize}
            />
          }
        >
          <ResourceBoundary {...resource} hasData={Boolean(resource.data)} retry={resource.refresh}>
            <Table
              rowKey='id'
              pagination={false}
              scroll={{ x: 360 }}
              dataSource={resource.data?.data.slice(0, 3)}
              locale={{ emptyText: <Empty description='暂无题目' /> }}
              columns={[
                {
                  title: '编号',
                  dataIndex: 'display_id',
                  width: 85,
                  render: (value) => <span className='font-mono text-xs text-text-muted'>{value}</span>,
                },
                {
                  title: '题目',
                  render: (_, problem) => (
                    <Link
                      className='font-medium'
                      to={`/problems/${encodeURIComponent(problem.display_id || problem.id)}`}
                    >
                      {problem.title}
                    </Link>
                  ),
                },
                { title: '难度', dataIndex: 'difficulty', width: 80, render: (value) => <Difficulty value={value} /> },
              ]}
            />
          </ResourceBoundary>
          <div className='mt-4 text-center'>
            <Link to='/problems'>查看全部题目</Link>
          </div>
        </Card>
        <Card title='最新评测'>
          <ResourceBoundary {...latest} hasData={Boolean(latest.data)} retry={latest.refresh}>
            {!latest.data?.data.length ? <Empty description='暂无评测记录' /> : (
              <div className='space-y-3'>
                {latest.data.data.slice(0, 3).map((submission) => (
                  <div key={submission.id} className='rounded border border-border p-3'>
                    <Link to={`/submissions/${encodeURIComponent(submission.public_id ?? submission.id)}`}>
                      {submission.problem?.title ?? submission.problem_id}
                    </Link>
                    <div className='mt-2'>
                      <SubmissionStatus status={submission.status} result={submission.result} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ResourceBoundary>
          <div className='mt-4 text-center'>
            <Link to='/submissions'>查看全部提交</Link>
          </div>
        </Card>
        {user && config.data?.data.follows_enabled && config.data.data.moments_enabled && (
          <Card
            className='lg:col-span-2'
            title='关注动态'
            extra={
              <Button
                size='sm'
                icon={<RefreshCw aria-hidden='true' />}
                aria-label='换一批'
                onClick={feed.refresh}
              />
            }
          >
            <ResourceBoundary {...feed} hasData={Boolean(feed.data)} retry={feed.refresh}>
              {feed.data?.data.length
                ? (
                  <div className='space-y-3'>
                    {feed.data.data.filter((item) => item.kind === 'moment').map((item) => (
                      <div key={item.post.id} className='rounded border border-border p-4'>
                        <Space>
                          <strong>{item.author.username}</strong>
                          <a href={`/community/posts/${encodeURIComponent(item.post.public_id ?? item.post.id)}`}>
                            {item.post.title ?? '查看详情'}
                          </a>
                        </Space>
                        <p className='mt-2 line-clamp-3 text-sm text-text-secondary'>{item.post.content}</p>
                      </div>
                    ))}
                  </div>
                )
                : (
                  <Empty
                    description={
                      <>
                        还没有关注动态<br />去用户主页关注感兴趣的人吧
                      </>
                    }
                  />
                )}
            </ResourceBoundary>
          </Card>
        )}
      </div>
    </>
  );
}
