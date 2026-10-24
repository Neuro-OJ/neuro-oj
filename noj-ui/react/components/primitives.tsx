/** @jsxImportSource react */
/** @jsxRuntime automatic */
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  LoaderCircle,
  Search,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import type { ComponentProps, CSSProperties, PropsWithChildren, ReactNode } from 'react';
import { cn } from '../lib/utils.ts';
import { Button as UiButton } from './ui/button.tsx';
import { Card as UiCard, CardContent, CardHeader, CardTitle } from './ui/card.tsx';
import { Input as UiInput } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';
import { Badge } from './ui/badge.tsx';
import { Alert as UiAlert, AlertDescription, AlertTitle } from './ui/alert.tsx';
import { Table as UiTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx';
import { Select as UiSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx';
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.tsx';
import { Skeleton as UiSkeleton } from './ui/skeleton.tsx';
import { Carousel as UiCarousel, CarouselContent, CarouselItem } from './ui/carousel.tsx';
import type { CarouselApi } from './ui/carousel.tsx';

/** 业务按钮仅扩展加载、图标和链接，视觉与交互复用 shadcn Button。 */
export function Button(
  { loading, icon, block, href, children, className, size = 'default', variant = 'outline', type = 'button', ...props }:
    & Omit<ComponentProps<typeof UiButton>, 'size'>
    & { loading?: boolean; icon?: ReactNode; block?: boolean; href?: string; size?: 'sm' | 'lg' | 'default' | 'icon' },
) {
  const content = (
    <>{loading ? <LoaderCircle aria-hidden className='size-4 motion-safe:animate-spin' /> : icon}{children}</>
  );
  const shared = { ...props, variant, size, className: cn('cursor-pointer', block && 'w-full', className) };
  if (href && !props.disabled && !loading) {
    return (
      <UiButton {...shared} asChild>
        <a href={href}>{content}</a>
      </UiButton>
    );
  }
  return (
    <UiButton {...shared} type={type} disabled={props.disabled || loading} aria-busy={loading || undefined}>
      {content}
    </UiButton>
  );
}

/** 带业务标题/操作区的面板，统一复用 shadcn Card。 */
export function Card(
  { title, extra, size, className, styles, children }: PropsWithChildren<
    {
      title?: ReactNode;
      extra?: ReactNode;
      size?: 'small' | 'sm';
      className?: string;
      styles?: { body?: CSSProperties };
    }
  >,
) {
  return (
    <UiCard className={cn('gap-0 rounded py-0 shadow-sm', className)}>
      {(title || extra) && (
        <CardHeader
          className={cn(
            'flex flex-row items-center justify-between gap-3 border-b border-border px-5 py-4',
            (size === 'small' || size === 'sm') && 'px-4 py-3',
          )}
        >
          <CardTitle className='text-base font-semibold'>{title}</CardTitle>
          {extra}
        </CardHeader>
      )}
      <CardContent style={styles?.body} className={cn('p-5', (size === 'small' || size === 'sm') && 'p-4')}>
        {children}
      </CardContent>
    </UiCard>
  );
}

export function Space(
  { children, className, orientation, wrap, size }: PropsWithChildren<
    { className?: string; orientation?: 'vertical'; wrap?: boolean; size?: number | string | number[] }
  >,
) {
  return (
    <div
      className={cn(
        'flex items-center gap-2',
        orientation === 'vertical' && 'flex-col items-stretch',
        wrap && 'flex-wrap',
        size === 'middle' && 'gap-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Alert(
  { title, description, type = 'info', action, className }: {
    title: ReactNode;
    description?: ReactNode;
    type?: 'error' | 'warning' | 'success' | 'info';
    action?: ReactNode;
    showIcon?: boolean;
    className?: string;
  },
) {
  const Icon = type === 'error' || type === 'warning' ? AlertCircle : type === 'success' ? CheckCircle2 : Info;
  return (
    <UiAlert
      className={cn(
        'rounded',
        type === 'error' && 'border-destructive/40 text-destructive',
        type === 'warning' && 'border-warning-text/40',
        type === 'success' && 'border-signal/40',
        className,
      )}
    >
      <Icon aria-hidden className='size-4' />
      <AlertTitle className='leading-6'>{title}</AlertTitle>
      {description && <AlertDescription className='text-inherit'>{description}</AlertDescription>}
      {action && <div className='col-start-2 mt-2'>{action}</div>}
    </UiAlert>
  );
}

export function Tag({ color, children, className }: PropsWithChildren<{ color?: string; className?: string }>) {
  return (
    <Badge
      variant='outline'
      className={cn(
        'rounded px-2 py-0.5 font-normal',
        color === 'success' && 'border-signal/25 bg-signal/5 text-signal-deep',
        color === 'processing' && 'border-primary/25 bg-primary-bg text-primary',
        color === 'warning' && 'border-warning-text/25 text-warning-text',
        color === 'error' && 'border-destructive/25 text-destructive',
        className,
      )}
    >
      {children}
    </Badge>
  );
}

function TextInput(
  { prefix, allowClear, className, ...props }: Omit<ComponentProps<typeof UiInput>, 'prefix'> & {
    prefix?: ReactNode;
    allowClear?: boolean;
  },
) {
  if (!prefix && !allowClear) return <UiInput className={className} {...props} />;
  return (
    <div className={cn('relative', className)}>
      {prefix && (
        <span className='pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-muted'>{prefix}</span>
      )}
      <UiInput {...props} className={cn(prefix && 'pl-9', allowClear && 'pr-9')} />
      {allowClear && props.value && (
        <button
          type='button'
          aria-label='清空'
          className='absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-text-muted focus-visible:outline-2 focus-visible:outline-primary'
          onClick={() => {
            const input = { target: { value: '' } };
            props.onChange?.(input as React.ChangeEvent<HTMLInputElement>);
          }}
        >
          <X aria-hidden className='size-4' />
        </button>
      )}
    </div>
  );
}
function SearchInput(
  { onSearch, defaultValue, className, ...props }: ComponentProps<typeof UiInput> & {
    onSearch: (value: string) => void;
    allowClear?: boolean;
  },
) {
  const [value, setValue] = useState(String(defaultValue ?? ''));
  return (
    <form
      className={cn('flex gap-2', className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(value);
      }}
    >
      <TextInput {...props} value={value} onChange={(event) => setValue(event.target.value)} />
      <Button type='submit' size='icon' aria-label='搜索'>
        <Search aria-hidden className='size-4' />
      </Button>
    </form>
  );
}
export const Input = Object.assign(TextInput, { Search: SearchInput, TextArea: Textarea });

export function Select({
  value,
  onChange,
  options = [],
  placeholder,
  className,
  allowClear,
  disabled,
  ...props
}: {
  value?: string;
  onChange: (value: string) => void;
  options?: { value: string; label: ReactNode }[];
  placeholder?: string;
  className?: string;
  allowClear?: boolean;
  showSearch?: boolean;
  optionFilterProp?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const empty = '__noj_empty__';
  return (
    <UiSelect
      value={value === undefined ? '' : value || empty}
      onValueChange={(next) => onChange(next === '__noj_clear__' ? '' : next === empty ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger className={cn('w-auto min-w-28 bg-bg-panel', className)} aria-label={props['aria-label']}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowClear && <SelectItem value='__noj_clear__'>{placeholder ?? '全部'}</SelectItem>}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value || empty}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </UiSelect>
  );
}

export function Empty({ description }: { description?: ReactNode }) {
  return <p className='py-8 text-center text-sm text-text-muted'>{description ?? '暂无数据'}</p>;
}
export function Skeleton({ paragraph }: { active?: boolean; paragraph?: { rows?: number } }) {
  return (
    <div className='space-y-3 py-4'>
      <UiSkeleton className='h-6 w-1/3' />
      {Array.from({ length: paragraph?.rows ?? 4 }, (_, index) => <UiSkeleton key={index} className='h-4 w-full' />)}
    </div>
  );
}
export function Result(
  { title, subTitle, extra }: { status?: string; title: ReactNode; subTitle?: ReactNode; extra?: ReactNode },
) {
  return (
    <div className='flex flex-col items-center gap-4 py-16 text-center'>
      <h1 className='text-xl font-semibold'>{title}</h1>
      {subTitle && <p className='text-sm text-text-secondary'>{subTitle}</p>}
      {extra}
    </div>
  );
}

interface Column<T> {
  title: ReactNode;
  dataIndex?: keyof T | string;
  width?: number;
  // deno-lint-ignore no-explicit-any -- 异构列的数据类型由 dataIndex 决定；行记录仍由 T 严格约束。
  render?: (value: any, record: T, index: number) => ReactNode;
}
export function Table<T extends object>({
  dataSource = [],
  columns,
  rowKey,
  pagination = false,
  loading,
  locale,
  scroll,
  expandable,
}: {
  dataSource?: T[];
  columns: Column<T>[];
  rowKey: keyof T | string;
  size?: string;
  loading?: boolean;
  locale?: { emptyText?: ReactNode };
  scroll?: { x: number };
  pagination?: false | {
    current: number;
    pageSize: number;
    total?: number;
    showSizeChanger?: boolean;
    onChange: (page: number) => void;
  };
  expandable?: { rowExpandable: (item: T) => boolean; expandedRowRender: (item: T) => ReactNode };
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const totalPages = pagination ? Math.max(1, Math.ceil((pagination.total ?? 0) / pagination.pageSize)) : 1;
  return (
    <div aria-busy={loading || undefined}>
      <UiTable style={scroll ? { minWidth: scroll.x } : undefined}>
        <TableHeader>
          <TableRow className='bg-bg-sunken hover:bg-bg-sunken'>
            {expandable && <TableHead className='w-10' />}
            {columns.map((column, index) => (
              <TableHead key={index} style={{ width: column.width }}>{column.title}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {dataSource.length
            ? dataSource.map((item, index) => {
              const record = item as Record<string, unknown>;
              const key = String(record[String(rowKey)] ?? index);
              return (
                <Fragment key={key}>
                  <TableRow>
                    {expandable && (
                      <TableCell>
                        {expandable.rowExpandable(item) && (
                          <Button
                            size='icon'
                            className='size-7'
                            aria-label={expanded.has(key) ? '收起' : '展开'}
                            onClick={() =>
                              setExpanded((previous) => {
                                const next = new Set(previous);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                              })}
                          >
                            <ChevronDown aria-hidden className={cn('size-4', expanded.has(key) && 'rotate-180')} />
                          </Button>
                        )}
                      </TableCell>
                    )}
                    {columns.map((column, cell) => (
                      <TableCell key={cell}>
                        {column.render
                          ? column.render(column.dataIndex ? record[String(column.dataIndex)] : undefined, item, index)
                          : String(record[String(column.dataIndex)] ?? '')}
                      </TableCell>
                    ))}
                  </TableRow>
                  {expandable && expanded.has(key) && (
                    <TableRow>
                      <TableCell colSpan={columns.length + 1}>{expandable.expandedRowRender(item)}</TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })
            : (
              <TableRow>
                <TableCell colSpan={columns.length + (expandable ? 1 : 0)}>
                  {loading ? <Skeleton /> : locale?.emptyText ?? <Empty />}
                </TableCell>
              </TableRow>
            )}
        </TableBody>
      </UiTable>
      {pagination && (pagination.total ?? 0) > 0 && (
        <nav aria-label='分页' className='mt-5 flex items-center justify-end gap-3'>
          <Button
            size='sm'
            disabled={pagination.current <= 1 || loading}
            onClick={() =>
              pagination.onChange(pagination.current - 1)}
          >
            <ChevronLeft aria-hidden className='size-4' />上一页
          </Button>
          <span className='text-sm tabular-nums'>{pagination.current} / {totalPages}</span>
          <Button
            size='sm'
            disabled={pagination.current >= totalPages || loading}
            onClick={() =>
              pagination.onChange(pagination.current + 1)}
          >
            下一页<ChevronRight aria-hidden className='size-4' />
          </Button>
        </nav>
      )}
    </div>
  );
}

export function Descriptions(
  { items, className, column }: {
    items: { key: string; label: ReactNode; children: ReactNode }[];
    column?: number | object;
    size?: string;
    className?: string;
  },
) {
  return (
    <dl className={cn('grid gap-x-8 gap-y-4', column !== 1 && 'sm:grid-cols-2', className)}>
      {items.map((item) => (
        <div key={item.key} className='flex flex-wrap items-baseline gap-2'>
          <dt className='text-sm text-text-muted'>{item.label}</dt>
          <dd className='text-sm'>{item.children}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Tabs({ items }: { items: { key: string; label: ReactNode; children: ReactNode }[] }) {
  return (
    <UiTabs defaultValue={items[0]?.key}>
      <TabsList>
        {items.map((item) => <TabsTrigger key={item.key} value={item.key}>{item.label}</TabsTrigger>)}
      </TabsList>
      {items.map((item) => <TabsContent className='pt-3' key={item.key} value={item.key}>{item.children}</TabsContent>)}
    </UiTabs>
  );
}

export function Carousel(
  { children, autoplay }: PropsWithChildren<{ autoplay?: boolean; pauseOnFocus?: boolean; pauseOnHover?: boolean }>,
) {
  const [api, setApi] = useState<CarouselApi>();
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!api || !autoplay || paused || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => api.scrollNext(), 5000);
    return () => clearInterval(timer);
  }, [api, autoplay, paused]);
  const slides = Array.isArray(children) ? children : [children];
  return (
    <UiCarousel
      opts={{ loop: true }}
      setApi={setApi}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <CarouselContent>
        {slides.map((slide, index) => <CarouselItem key={index}>{slide}</CarouselItem>)}
      </CarouselContent>
      {slides.length > 1 && (
        <div className='absolute bottom-3 left-3 flex gap-2'>
          {slides.map((_, index) => (
            <Button
              className='size-6 p-0 text-xs'
              key={index}
              aria-label={`第 ${index + 1} 张`}
              onClick={() => api?.scrollTo(index)}
            >
              {index + 1}
            </Button>
          ))}
        </div>
      )}
    </UiCarousel>
  );
}
