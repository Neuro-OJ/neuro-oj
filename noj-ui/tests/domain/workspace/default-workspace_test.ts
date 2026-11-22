// deno-lint-ignore no-import-prefix -- 复用仓库既有断言依赖，不引入新版本。
import { assertEquals } from 'jsr:@std/assert@^1';
import {
    defaultProblemReference,
    defaultWorkspaceDestination,
} from '../../../utils/domain/workspace/default-workspace.ts';
Deno.test('旧Public入口固定main，不从偏好或题库类型决定空间', () => {
    assertEquals(defaultWorkspaceDestination('/problems/'), { path: '/d/main/problems' });
    assertEquals(defaultWorkspaceDestination('/trainings'), { path: '/d/main/trainings' });
    assertEquals(defaultWorkspaceDestination('/my/submissions'), { path: '/d/main/submissions' });
    assertEquals(defaultWorkspaceDestination('/search'), { path: '/d/main/search' });
    assertEquals(defaultWorkspaceDestination('/admin/problems'), { path: '/d/main/problem-bindings' });
    assertEquals(defaultWorkspaceDestination('/admin/contests'), { path: '/d/main/contests' });
    assertEquals(defaultWorkspaceDestination('/admin/submissions'), { path: '/d/main/submissions' });
    assertEquals(defaultWorkspaceDestination('/contests/ct-one/ranking'), { path: '/d/main/contests/ct-one/ranking' });
    assertEquals(defaultWorkspaceDestination('/admin/llm/providers'), { path: '/d/main/llm' });
    assertEquals(defaultWorkspaceDestination('/admin/llm/quotas'), null);
    assertEquals(defaultWorkspaceDestination('/editor/P1001'), { problemRef: 'P1001', editor: false, solve: true });
    assertEquals(defaultWorkspaceDestination('/problems/P1001/edit'), { problemRef: 'P1001', editor: true });
    assertEquals(defaultWorkspaceDestination('/problems/new/objective'), {
        path: '/d/main/problems/new',
        kind: 'objective',
    });
    assertEquals(defaultWorkspaceDestination('/d/school/problems/1001'), null);
});
Deno.test('旧入口规则表是唯一来源：队列与题目包导入转 main，全站排行榜不是旧入口', () => {
    assertEquals(defaultWorkspaceDestination('/queue'), { path: '/d/main/queue' });
    assertEquals(defaultWorkspaceDestination('/problems/new/bundle'), {
        path: '/d/main/problems/new',
        query: { import: '1' },
    });
    assertEquals(defaultWorkspaceDestination('/problems/new/oi'), { path: '/d/main/problems/new', kind: 'oi' });
    // 全站排行榜（含签到榜）在 `/leaderboard`；v0.11.0 的 `/ranking` 301 可能已被浏览器缓存。
    assertEquals(defaultWorkspaceDestination('/ranking'), { path: '/leaderboard' });
    assertEquals(defaultWorkspaceDestination('/leaderboard'), null);
});
Deno.test('旧入口静态段不区分大小写，ID 与引用保持原样', () => {
    assertEquals(defaultWorkspaceDestination('/Search'), { path: '/d/main/search' });
    assertEquals(defaultWorkspaceDestination('/Ranking'), { path: '/leaderboard' });
    assertEquals(defaultWorkspaceDestination('/Contests/Foo/ranking'), { path: '/d/main/contests/Foo/ranking' });
    assertEquals(defaultWorkspaceDestination('/Trainings/tr-AbC'), { trainingRef: 'tr-AbC' });
    assertEquals(defaultWorkspaceDestination('/Problems/P1001/Edit'), { problemRef: 'P1001', editor: true });
    assertEquals(defaultWorkspaceDestination('/Editor/P1001'), { problemRef: 'P1001', editor: false, solve: true });
    assertEquals(defaultWorkspaceDestination('/Community/Posts/AbC'), { path: '/d/main/community/posts/AbC' });
    assertEquals(defaultWorkspaceDestination('/Problems/New/OI'), { path: '/d/main/problems/new', kind: 'oi' });
});
Deno.test('旧P号只转数字，U题不能猜成默认域题，UUID需只读授权解析', () => {
    assertEquals(defaultProblemReference('P1001'), '1001');
    assertEquals(defaultProblemReference('1001'), '1001');
    assertEquals(defaultProblemReference('U1001'), null);
    assertEquals(defaultProblemReference('uuid'), null);
    assertEquals(defaultProblemReference('2147483648'), null);
    assertEquals(defaultWorkspaceDestination('/trainings/tr-one'), { trainingRef: 'tr-one' });
});
