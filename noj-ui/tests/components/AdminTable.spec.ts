/**
 * AdminTable 回归测试。
 *
 * 背景：Nuxt UI v4 的 `UTable` 用 `data` 接收行数据（v2 的 `rows` 已不是 prop）。
 * 曾因 AdminTable 仍传 `:rows` 导致 12 个管理页面「API 有数据但表格恒为空」。
 *
 * 这里用与 v4 契约一致的 UTable 桩件（只认 `data`）挂载组件：
 * 一旦有人改回 `:rows`，桩件拿不到数据、渲染不出任何行，测试立即失败。
 */
import { mount } from '@vue/test-utils';
import { computed, defineComponent, h, useSlots } from 'vue';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import AdminTable from '~/components/admin/AdminTable.vue';

// AdminTable 依赖 Nuxt 自动导入的 Vue API；vitest 无 Nuxt 上下文，挂到全局
beforeAll(() => {
  vi.stubGlobal('useSlots', useSlots);
  vi.stubGlobal('computed', computed);
});

const columns = [
  { key: 'username', label: '用户名' },
  { key: 'email', label: '邮箱' },
  { key: 'actions', label: '操作' },
];

const items = [
  { id: 'u1', username: 'alice', email: 'alice@test.com' },
  { id: 'u2', username: 'bob', email: 'bob@test.com' },
];

/** UTable 桩件：只按 Nuxt UI v4 契约读取 `data` + `columns[].cell` */
const UTableStub = defineComponent({
  name: 'UTable',
  props: {
    data: { type: Array, default: () => [] },
    columns: { type: Array, default: () => [] },
    getRowId: { type: Function, default: undefined },
    onSelect: { type: Function, default: undefined },
  },
  setup(props) {
    return () =>
      h('table', [
        h(
          'tbody',
          (props.data as Record<string, unknown>[]).map((row) =>
            h(
              'tr',
              { 'data-row-id': props.getRowId ? props.getRowId(row) : undefined },
              (props.columns as { cell?: (ctx: unknown) => unknown }[]).map((column) =>
                h('td', column.cell ? (column.cell({ row: { original: row } }) as never) : '')
              ),
            )
          ),
        ),
      ]);
  },
});

const UPaginationStub = defineComponent({
  name: 'UPagination',
  props: {
    page: { type: Number, default: 1 },
    total: { type: Number, default: 0 },
    itemsPerPage: { type: Number, default: 10 },
  },
  emits: ['update:page'],
  setup(props, { emit }) {
    return () =>
      h('button', {
        class: 'pager',
        'data-total': String(props.total),
        onClick: () => emit('update:page', 2),
      });
  },
});

function mountTable(props: Record<string, unknown> = {}) {
  return mount(AdminTable, {
    props: { columns, items, loading: false, error: '', totalPages: 1, currentPage: 1, ...props },
    global: { components: { UTable: UTableStub, UPagination: UPaginationStub } },
  });
}

describe('AdminTable', () => {
  it('把行数据以 v4 的 data prop 传给 UTable 并渲染出所有行', () => {
    const wrapper = mountTable();
    const rows = wrapper.findAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(wrapper.text()).toContain('alice');
    expect(wrapper.text()).toContain('bob');
  });

  it('#cell 插槽收到原始行数据与列定义', () => {
    const wrapper = mount(AdminTable, {
      props: { columns, items, loading: false, totalPages: 1, currentPage: 1 },
      global: { components: { UTable: UTableStub, UPagination: UPaginationStub } },
      slots: {
        cell:
          `<template #cell="{ row, column }"><span class="cell">{{ column.key }}={{ row.username }}</span></template>`,
      },
    });
    expect(wrapper.findAll('.cell').map((n) => n.text())).toEqual([
      'username=alice',
      'email=alice',
      'actions=alice',
      'username=bob',
      'email=bob',
      'actions=bob',
    ]);
  });

  it('#actions 插槽只作用于 actions 列', () => {
    const wrapper = mount(AdminTable, {
      props: { columns, items: [items[0]], loading: false, totalPages: 1, currentPage: 1 },
      global: { components: { UTable: UTableStub, UPagination: UPaginationStub } },
      slots: { actions: `<template #actions="{ row }"><i class="act">{{ row.id }}</i></template>` },
    });
    expect(wrapper.findAll('.act').map((n) => n.text())).toEqual(['u1']);
  });

  it('没有 cell 插槽时回退显示原始字段值', () => {
    const wrapper = mountTable();
    expect(wrapper.text()).toContain('alice@test.com');
  });

  it('部分覆盖的 #cell 插槽：未覆盖列回退显示原始值', () => {
    // 回归：题目管理页的 #cell 只处理 type/difficulty/tags/created_at，
    // 题号（display_id）与标题（title）两列曾整列空白。
    const wrapper = mount(AdminTable, {
      props: { columns, items: [items[0]], loading: false, totalPages: 1, currentPage: 1 },
      global: { components: { UTable: UTableStub, UPagination: UPaginationStub } },
      slots: {
        cell:
          `<template #cell="{ row, column }"><template v-if="column.key === 'username'"><b class="u">{{ row.username }}</b></template></template>`,
      },
    });
    expect(wrapper.find('.u').text()).toBe('alice');
    // email 列没有被插槽覆盖 → 必须回退为原始字段值，而不是空白
    expect(wrapper.text()).toContain('alice@test.com');
  });

  it('插槽命中但渲染为空字符串时也回退原始值', () => {
    const wrapper = mount(AdminTable, {
      props: {
        columns,
        items: [{ id: 'u9', username: 'carol', email: 'carol@test.com' }],
        loading: false,
        totalPages: 1,
        currentPage: 1,
      },
      global: { components: { UTable: UTableStub, UPagination: UPaginationStub } },
      slots: {
        cell:
          `<template #cell="{ row, column }"><template v-if="column.key === 'username'">{{ '' }}</template></template>`,
      },
    });
    expect(wrapper.text()).toContain('carol');
  });

  it('未覆盖列取值为 null/undefined 时渲染空串而非 "null"', () => {
    const wrapper = mount(AdminTable, {
      props: {
        columns,
        items: [{ id: 'u10', username: 'dave', email: null }],
        loading: false,
        totalPages: 1,
        currentPage: 1,
      },
      global: { components: { UTable: UTableStub, UPagination: UPaginationStub } },
      slots: {
        cell:
          `<template #cell="{ row, column }"><template v-if="column.key === 'username'">{{ row.username }}</template></template>`,
      },
    });
    expect(wrapper.text()).toContain('dave');
    expect(wrapper.text()).not.toContain('null');
  });

  it('标签管理页形态：名称与关联题目数回退原始值（含数值 0）', () => {
    // 复刻 pages/admin/tags.vue：列 = 名称/类型/关联题目数/创建时间/操作，
    // #cell 只处理 kind 与 created_at。「名称」「关联题目数」曾整列空白。
    const tagColumns = [
      { key: 'name', label: '名称' },
      { key: 'kind', label: '类型' },
      { key: 'problem_count', label: '关联题目数' },
      { key: 'created_at', label: '创建时间' },
      { key: 'actions', label: '操作' },
    ];
    const wrapper = mount(AdminTable, {
      props: {
        columns: tagColumns,
        items: [{
          id: 'tag-dp',
          name: 'DP',
          kind: 'algorithm',
          problem_count: 0,
          created_at: '2026-09-25T17:03:30.439Z',
        }],
        loading: false,
        totalPages: 1,
        currentPage: 1,
      },
      global: { components: { UTable: UTableStub, UPagination: UPaginationStub } },
      slots: {
        cell: `<template #cell="{ row, column }">
          <template v-if="column.key === 'kind'"><span class="kind-badge">{{ row.kind }}</span></template>
          <template v-else-if="column.key === 'created_at'">{{ row.created_at }}</template>
        </template>`,
      },
    });
    // 插槽命中列仍走插槽
    expect(wrapper.find('.kind-badge').text()).toBe('algorithm');
    // 未覆盖列回退原始值：名称
    expect(wrapper.text()).toContain('DP');
    // 数值 0 必须渲染为 "0"，不能被当成"空值"丢掉
    expect(wrapper.text()).toContain('0');
  });

  it('loading / error / 空数据按优先级展示状态而非表格', () => {
    expect(mountTable({ loading: true }).text()).toContain('加载中');
    expect(mountTable({ error: '后端炸了' }).text()).toContain('后端炸了');
    expect(mountTable({ items: [] }).text()).toContain('暂无数据');
  });

  it('总页数大于 1 时渲染分页并把 total 传给 UPagination', async () => {
    const wrapper = mountTable({ totalPages: 4, currentPage: 2 });
    const pager = wrapper.find('.pager');
    expect(pager.exists()).toBe(true);
    expect(pager.attributes('data-total')).toBe('4');
    await pager.trigger('click');
    expect(wrapper.emitted('update:page')).toEqual([[2]]);
  });

  it('单页时不渲染分页', () => {
    expect(mountTable({ totalPages: 1 }).find('.pager').exists()).toBe(false);
  });
});
