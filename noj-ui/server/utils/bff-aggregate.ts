import type { BffEnvelope, BffJsonValue, BffSectionName, BffViewKind } from '../../utils/server/bff-view.ts';
import type { AuthUser } from '../../utils/auth/auth-user.ts';
import type { WorkspaceDetail } from '../../utils/domain/workspace/workspace.ts';
import type { DomainTrainingDetail, TrainingViewItem } from '../../utils/domain/problem/domain-trainings.ts';
import { readProblemSummaries } from './bff-problem-summaries.ts';
import { BffError, type CoreReader } from './bff-request.ts';

/** 聚合既有 API，不读 Core 数据库、不推导或替代上游授权。 */
export async function aggregateView(reader: CoreReader, input: {
  kind: BffViewKind;
  slug: string;
  id?: string;
  authenticated: boolean;
  page?: number;
}, siteMeta: () => Promise<unknown>): Promise<BffEnvelope> {
  const viewer = input.authenticated ? (await reader.get<{ data: AuthUser }>('/api/v1/auth/me')).data : null;
  if (viewer?.must_change_password) throw new BffError(401, { error: '请先修改密码', code: 'MUST_CHANGE_PASSWORD' });
  const root = `/api/v1/domains/${encodeURIComponent(input.slug)}`;
  const workspaceResponse = await reader.get<{ data: WorkspaceDetail }>(root);
  const workspace = workspaceResponse.data;
  if (workspace.actor_id !== (viewer?.id ?? null)) {
    throw new BffError(502, { error: '上游身份不一致，请刷新页面', code: 'BFF_ACTOR_MISMATCH' });
  }
  const result: BffEnvelope = {
    kind: input.kind,
    viewer,
    workspace,
    sections: { workspace: { data: workspaceResponse as unknown as BffJsonValue } },
  };
  const put = (name: BffSectionName, data: unknown) => {
    result.sections[name] = { data: data as BffJsonValue };
  };
  const optional = async (name: BffSectionName, load: () => Promise<unknown>) => {
    try {
      put(name, await load());
    } catch (error) {
      if (!(error instanceof BffError)) throw error;
      if (error.statusCode === 401) throw error;
      result.sections[name] = { error: { statusCode: error.statusCode, data: error.data } };
    }
  };
  const read = (name: BffSectionName, path: string) => optional(name, () => reader.get(path, { timeout: 2000 }));
  const tasks: Promise<unknown>[] = [
    optional('siteMeta', siteMeta),
    read('banStatus', '/api/v1/auth/ban-status'),
    read('instanceNavigation', '/api/v1/instance'),
    read('announcementBanner', `${root}/announcements/banner`),
  ];
  const member = !!viewer && (workspace.is_member || workspace.platform_admin);
  if (viewer) {
    tasks.push(read('userSpaces', '/api/v1/me/domains'));
  }
  const features = workspace.configuration.features;
  if (viewer) tasks.push(read('accountNotifications', '/api/v1/notifications?per_page=1'));
  else put('accountNotifications', { data: [], total: 0, unread_count: 0 });
  if (features.community) {
    tasks.push(optional('communityConfig', async () => {
      const response = await reader.get<{ data: Record<string, unknown> }>(`${root}/community/config`, {
        timeout: 2000,
      });
      return { key: `community:${input.slug}:${viewer?.id ?? 'guest'}`, config: response.data };
    }));
  }

  const loadView = async () => {
    if (input.kind === 'home') {
      const reads: Promise<unknown>[] = [
        read('announcements', `${root}/announcements?page=1&per_page=5`),
        read('activity', `${root}/activity`),
      ];
      if (viewer) reads.push(read('checkin', '/api/v1/checkin/today'));
      else put('checkin', { data: { checked_in: false, streak: 0 } });
      if (features.assignment && member) {
        const teaching = workspace.platform_admin || workspace.permissions.includes('classroom:create') ||
          workspace.permissions.includes('classroom:manage_any');
        reads.push(read('dashboard', `${root}/${teaching ? 'teaching' : 'my-learning'}?page=1`));
      } else put('dashboard', null);
      await Promise.all(reads);
    } else {
      const { data } = await reader.get<{ data: DomainTrainingDetail }>(
        `${root}/trainings/${encodeURIComponent(input.id!)}`,
      );
      const { items: all, ...training } = data;
      const page = input.page ?? 1;
      const pageItems = all.slice((page - 1) * 20, page * 20);
      const summaries = await readProblemSummaries(
        reader,
        input.slug,
        pageItems.filter((item) => item.resource_available && item.binding_id).map((item) => item.display_ref),
      );
      const summariesByReference = new Map(summaries.items.map((item) => [item.reference, item]));
      const items = pageItems.map((item): TrainingViewItem => {
        const summary = summariesByReference.get(item.display_ref);
        const row: TrainingViewItem = { ...item, title: null, kind: null, progress: null, summary_error: false };
        if (!item.resource_available || !item.binding_id) return row;
        if (!summary || summary.availability !== 'available') return { ...row, summary_error: true };
        return {
          ...row,
          title: summary.title,
          kind: summary.kind,
          progress: summary.progress,
          ...(summary.best_score !== undefined ? { best_score: summary.best_score } : {}),
        };
      });
      put('training', { data: { training, items, page, per_page: 20, total: all.length } });
    }
  };
  await Promise.all([...tasks, loadView()]);
  return result;
}
