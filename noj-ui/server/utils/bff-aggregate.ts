import type { BffEnvelope, BffSectionName, BffViewKind } from '../../utils/bff-view.ts';
import type { AuthUser } from '../../utils/auth-user.ts';
import type { WorkspaceDetail } from '../../utils/workspace.ts';
import type { AssignmentDetail, ClassroomDetail } from '../../utils/education.ts';
import type { DomainTrainingDetail, TrainingViewItem } from '../../utils/domain-trainings.ts';
import type { DomainProblemDetail, DomainProblemSummary } from '../../utils/domain-problems.ts';
import { classroomCan } from '../../utils/education.ts';
import { BffError, type CoreReader } from './bff-request.ts';

/** 聚合既有 API，不读 Core 数据库、不推导或替代上游授权。 */
export async function aggregateView(reader: CoreReader, input: {
  kind: BffViewKind;
  slug: string;
  id?: string;
  authenticated: boolean;
  page?: number;
  help?: string;
  feedback?: string;
  history?: boolean;
}, siteMeta: () => Promise<unknown>): Promise<BffEnvelope> {
  const viewer = input.authenticated ? (await reader.get<{ data: AuthUser }>('/api/v1/auth/me')).data : null;
  if (!viewer && input.kind !== 'home' && input.kind !== 'training') {
    throw new BffError(401, { error: '请先登录', code: 'UNAUTHORIZED' });
  }
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
    sections: { workspace: { data: workspaceResponse } },
  };
  const put = (name: BffSectionName, data: unknown) => {
    result.sections[name] = { data };
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
    tasks.push(read('userSpaces', '/api/v1/me/domains'), read('messageUnread', '/api/v1/conversations/unread-count'));
  }
  const features = workspace.configuration.features;
  if (features.assignment && member) tasks.push(read('educationNotifications', `${root}/notifications?page=1`));
  else put('educationNotifications', { data: { unread: 0 } });
  let community: Record<string, unknown> | null = null;
  const communityTask = features.community
    ? optional('communityConfig', async () => {
      const response = await reader.get<{ data: Record<string, unknown> }>(`${root}/community/config`, {
        timeout: 2000,
      });
      community = response.data;
      return { key: `community:${input.slug}:${viewer?.id ?? 'guest'}`, config: community };
    })
    : Promise.resolve();
  tasks.push(communityTask.then(async () => {
    if (viewer && community?.enabled) await read('communityUnread', `${root}/community/notifications/unread-count`);
    else put('communityUnread', { data: { count: 0 } });
  }));

  const loadView = async () => {
    if (input.kind === 'home') {
      const reads: Promise<unknown>[] = [
        read('carousel', `${root}/carousel/slides`),
        read('announcements', `${root}/announcements?page=1&per_page=5`),
        read('activity', `${root}/activity`),
        optional('randomProblems', async () => {
          const first = await reader.get<{ items: DomainProblemSummary[]; total: number }>(
            `${root}/problems?page=1&limit=30&keyword=`,
            { timeout: 2000 },
          );
          const page = Math.floor(Math.random() * Math.max(1, Math.ceil(first.total / 30))) + 1;
          const selected = page === 1
            ? first
            : await reader.get<{ items: DomainProblemSummary[] }>(`${root}/problems?page=${page}&limit=30&keyword=`, {
              timeout: 2000,
            });
          return selected.items.slice().sort(() => Math.random() - 0.5).slice(0, 3);
        }),
        communityTask.then(() => {
          if (viewer && community?.follows_enabled && community?.moments_enabled) {
            return read('feed', `${root}/community/feed?view=following&limit=5`);
          }
          put('feed', { data: [] });
        }),
      ];
      if (viewer) reads.push(read('checkin', '/api/v1/checkin/today'));
      else put('checkin', { data: { checked_in: false, streak: 0 } });
      if (features.assignment && member) {
        const teaching = workspace.platform_admin || workspace.permissions.includes('classroom:create') ||
          workspace.permissions.includes('classroom:manage_any');
        reads.push(read('dashboard', `${root}/${teaching ? 'teaching' : 'my-learning'}?page=1`));
      } else put('dashboard', null);
      await Promise.all(reads);
    } else if (input.kind === 'training') {
      const { data } = await reader.get<{ data: DomainTrainingDetail }>(
        `${root}/trainings/${encodeURIComponent(input.id!)}`,
      );
      const { items: all, ...training } = data;
      const page = input.page ?? 1;
      const items = await Promise.all(
        all.slice((page - 1) * 20, page * 20).map(async (item): Promise<TrainingViewItem> => {
          const row: TrainingViewItem = { ...item, title: null, kind: null, progress: null, summary_error: false };
          if (!item.resource_available || !item.binding_id) return row;
          try {
            const problem = await reader.get<DomainProblemDetail>(
              `${root}/problems/${encodeURIComponent(item.display_ref)}`,
              { timeout: 2000 },
            );
            return {
              ...row,
              title: problem.content.title,
              kind: problem.content.kind,
              progress: viewer ? problem.statistics?.progress ?? null : null,
            };
          } catch (error) {
            if (!(error instanceof BffError) || error.statusCode === 401) throw error;
            return { ...row, summary_error: true };
          }
        }),
      );
      put('training', { data: { training, items, page, per_page: 20, total: all.length } });
    } else if (input.kind === 'classroom') {
      // 班级是主资源；鉴权通过后再读取作业。
      put('classroom', await reader.get(`${root}/classrooms/${encodeURIComponent(input.id!)}`));
      await read('assignments', `${root}/classrooms/${encodeURIComponent(input.id!)}/assignments?page=1`);
    } else {
      const base = `${root}/assignments/${encodeURIComponent(input.id!)}`;
      const assignment = await reader.get<{ data: AssignmentDetail }>(base);
      put('assignment', assignment);
      const classroom = await reader.get<{ data: ClassroomDetail }>(
        `${root}/classrooms/${encodeURIComponent(assignment.data.classroom_id)}`,
      );
      put('classroom', classroom);
      const room = classroom.data;
      const student = room.membership?.role === 'student' || room.historical_student === true;
      const reads: Promise<unknown>[] = [];
      if (!assignment.data.published_at && classroomCan(room, 'assignments:manage')) {
        reads.push(
          read('draftRoster', `${root}/classrooms/${encodeURIComponent(assignment.data.classroom_id)}/members`),
        );
        if (assignment.data.source_training_id) {
          reads.push(
            read('draftTraining', `${root}/trainings/${encodeURIComponent(assignment.data.source_training_id)}`),
          );
        } else put('draftTraining', null);
      }
      if (classroomCan(room, 'progress:read') && assignment.data.published_at) {
        reads.push(read('matrix', `${base}/matrix?scope=on_time&page=1&recipients=current`));
      } else put('matrix', null);
      if (student && assignment.data.published_at) reads.push(read('progress', `${base}/progress?scope=on_time`));
      else put('progress', null);
      if (student || classroomCan(room, 'feedback:write')) {
        reads.push(read('feedback', `${base}/feedback?page=1`));
        if (input.feedback) {
          reads.push(read('focusedFeedback', `${base}/feedback/${encodeURIComponent(input.feedback)}`));
        } else put('focusedFeedback', null);
      } else {
        put('feedback', null);
        put('focusedFeedback', null);
      }
      if (student || classroomCan(room, 'help:manage')) {
        reads.push(read('help', `${base}/help-requests?page=1`));
        if (input.help) {
          reads.push(read('helpDetail', `${base}/help-requests/${encodeURIComponent(input.help)}?page=1`));
        } else put('helpDetail', null);
      } else {
        put('help', null);
        put('helpDetail', null);
      }
      if (input.history) reads.push(read('history', `${base}/history?page=1`));
      await Promise.all(reads);
    }
  };
  await Promise.all([...tasks, loadView()]);
  return result;
}
