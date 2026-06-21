<template>
    <div>
        <div v-if="pending" class="loading">
            <Loader2 class="spinner" :size="24" />
            加载中...
        </div>

        <div v-else-if="error" class="error">加载失败，请稍后重试</div>

        <template v-else>
            <div class="sub-nav">
                <div class="sub-nav-inner">
                    <div class="search-row">
                        <div class="search-wrapper">
                            <Search :size="18" class="search-icon" />
                            <input
                                v-model="search"
                                type="text"
                                placeholder="搜索题目名称..."
                                class="search-input"
                            />
                        </div>
                        <button class="detail-toggle" :class="{ active: showDetailedSearch }" @click="toggleDetail()">详细搜索</button>
                    </div>

                    <div class="detail-collapse" :class="{ open: showDetailedSearch }">
                        <div class="detail-inner">
                            <div class="filter-row">
                                    <div class="filter-group" :class="{ 'has-inputs': activeFilterType }">
                                    <select
                                        v-model="activeFilterType"
                                        class="filter-select"
                                        @change="filterError = ''; filterWarning = ''"
                                    >
                                        <option value="">选择筛选项</option>
                                        <option v-for="ft in filterTypes" :key="ft.key" :value="ft.key">{{ ft.label }}</option>
                                    </select>
                                    <div class="filter-inputs-wrap">
                                        <Transition name="filter" mode="out-in">
                                            <div v-if="activeFilterType" class="filter-inputs" :key="activeFilterType">
                                            <template v-if="activeFilterType === 'difficulty'">
                                                <button
                                                    v-for="d in difficultyOptions"
                                                    :key="d.value"
                                                    class="tag-btn"
                                                    :class="{ selected: difficultyFilter.includes(d.value) }"
                                                    @click="toggleDifficulty(d.value)"
                                                >{{ d.label }}</button>
                                            </template>
                                            <template v-else-if="activeFilterType === 'time'">
                                                <input v-model="timeMinInput" placeholder="最小 (ms)" class="num-input" @input="onRangeInput('time')" @keydown.enter="commitTime()" :key="'tmin'" />
                                                <span class="sep">~</span>
                                                <input v-model="timeMaxInput" placeholder="最大 (ms)" class="num-input" @input="onRangeInput('time')" @keydown.enter="commitTime()" :key="'tmax'" />
                                            </template>
                                            <template v-else-if="activeFilterType === 'memory'">
                                                <input v-model="memMinInput" placeholder="最小 (MB)" class="num-input" @input="onRangeInput('mem')" @keydown.enter="commitMem()" :key="'mmin'" />
                                                <span class="sep">~</span>
                                                <input v-model="memMaxInput" placeholder="最大 (MB)" class="num-input" @input="onRangeInput('mem')" @keydown.enter="commitMem()" :key="'mmax'" />
                                            </template>
                                            <template v-else-if="activeFilterType === 'id'">
                                                <input v-model="idMinInput" placeholder="起始编号" class="num-input" @input="onRangeInput('id')" @keydown.enter="commitId()" :key="'imin'" />
                                                <span class="sep">~</span>
                                                <input v-model="idMaxInput" placeholder="结束编号" class="num-input" @input="onRangeInput('id')" @keydown.enter="commitId()" :key="'imax'" />
                                            </template>
                                        </div>
                                    </Transition>
                                    </div>
                                </div>
                                <button v-if="activeFilterType && activeFilterType !== 'difficulty'" class="confirm-btn" @click="commitCurrent()"><Check :size="16" /></button>
                                <div class="filter-msg">
                                    <Transition name="msg">
                                        <p v-if="filterError" class="filter-error"><AlertCircle :size="14" class="msg-icon" /> {{ filterError }}</p>
                                    </Transition>
                                    <Transition name="msg">
                                        <p v-if="filterWarning" class="filter-warning"><AlertCircle :size="14" class="msg-icon" /> {{ filterWarning }}</p>
                                    </Transition>
                                </div>
                            </div>

                            <div v-if="activeFilters.length" class="active-tags">
                                <span
                                    v-for="tag in activeFilters"
                                    :key="tag.key"
                                    class="filter-tag"
                                    :class="'filter-tag--' + tag.type"
                                >
                                    {{ tag.label }}: <span v-if="tag.type === 'difficulty'" class="tag-value" :class="'tag-value--' + tag.key.split(':')[1]">{{ tag.value }}</span><template v-else>{{ tag.value }}</template>
                                    <button class="tag-remove" @click="removeFilter(tag.key)">✕</button>
                                </span>
                                <button class="clear-all" @click="clearAllFilters">清除全部</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="page">
                <div class="table-wrap">
                    <table class="problem-table">
                        <thead>
                            <tr>
                                <th class="col-id" @click="toggleSort('id')">
                                    <Hash :size="14" />
                                    题号
                                    <span v-if="sortKey === 'id'" class="sort-arrow">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
                                </th>
                                <th class="col-title" @click="toggleSort('title')">
                                    <FileText :size="14" />
                                    题目
                                    <span v-if="sortKey === 'title'" class="sort-arrow">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
                                </th>
                                <th class="col-diff" @click="toggleSort('difficulty')">
                                    <Signal :size="14" />
                                    难度
                                    <span v-if="sortKey === 'difficulty'" class="sort-arrow">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
                                </th>
                                <th class="col-time" @click="toggleSort('time_limit_ms')">
                                    <Clock :size="14" />
                                    时间限制
                                    <span v-if="sortKey === 'time_limit_ms'" class="sort-arrow">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
                                </th>
                                <th class="col-mem" @click="toggleSort('memory_limit_mb')">
                                    <HardDrive :size="14" />
                                    空间限制
                                    <span v-if="sortKey === 'memory_limit_mb'" class="sort-arrow">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="problem in pagedProblems" :key="problem.id" @click="$router.push(`/problems/${problem.id}`)">
                                <td class="col-id">
                                    <span class="problem-id">#{{ shortId(problem.id) }}</span>
                                </td>
                                <td class="col-title">
                                    <NuxtLink :to="`/problems/${problem.id}`" class="problem-title">{{ problem.title }}</NuxtLink>
                                </td>
                                <td class="col-diff">
                                    <span class="difficulty" :class="`difficulty--${problem.difficulty}`">{{ difficultyLabel(problem.difficulty) }}</span>
                                </td>
                                <td class="col-time">{{ problem.time_limit_ms }}ms</td>
                                <td class="col-mem">{{ problem.memory_limit_mb }}MB</td>
                            </tr>
                            <tr v-if="pagedProblems.length === 0">
                                <td colspan="5" class="empty">暂无题目</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div v-if="totalPages > 1" class="pagination">
                    <button class="page-btn" :disabled="page <= 1" @click="page--">上一页</button>
                    <span class="page-info">
                        <input v-model.number="gotoPage" class="page-input" @keydown.enter="goToPage" @blur="gotoPage = page" /> / {{ totalPages }}
                    </span>
                    <button class="page-btn" :disabled="page >= totalPages" @click="page++">下一页</button>
                </div>
            </div>
        </template>
    </div>
</template>

<script setup lang="ts">
definePageMeta({
    pageTitle: "题库",
    pageSubtitle: "浏览所有可用题目，选择感兴趣的题目开始挑战",
})

import { Search, Loader2, Hash, FileText, Signal, Clock, HardDrive, AlertCircle, Check } from "@lucide/vue"

type SortKey = "id" | "title" | "difficulty" | "time_limit_ms" | "memory_limit_mb"
type SortDir = "asc" | "desc"

const { data, pending, error } = useFetch("/api/v1/problems?limit=100")

const search = ref("")
const page = ref(1)
const perPage = 15
const gotoPage = ref(1)

watch(page, (val) => {
    gotoPage.value = val
    window.scrollTo({ top: 0, behavior: "smooth" })
})

function goToPage() {
    const p = gotoPage.value
    if (p >= 1 && p <= totalPages.value) {
        page.value = p
    } else {
        gotoPage.value = page.value
    }
}
const sortKey = ref<SortKey>("id")
const sortDir = ref<SortDir>("asc")

interface RangeEntry { min: string; max: string }

const showDetailedSearch = ref(false)

function toggleDetail() {
    showDetailedSearch.value = !showDetailedSearch.value
    filterError.value = ""
    filterWarning.value = ""
}

const activeFilterType = ref("")
const difficultyFilter = ref<string[]>([])

const timeRanges = ref<RangeEntry[]>([])
const timeMinInput = ref("")
const timeMaxInput = ref("")
const memRanges = ref<RangeEntry[]>([])
const memMinInput = ref("")
const memMaxInput = ref("")
const idRanges = ref<RangeEntry[]>([])
const idMinInput = ref("")
const idMaxInput = ref("")

const filterError = ref("")
const filterWarning = ref("")
let errorTimer: ReturnType<typeof setTimeout> | null = null
let warningTimer: ReturnType<typeof setTimeout> | null = null

watch(filterError, (val) => {
    if (errorTimer) clearTimeout(errorTimer)
    if (val) errorTimer = setTimeout(() => { filterError.value = "" }, 3000)
})
watch(filterWarning, (val) => {
    if (warningTimer) clearTimeout(warningTimer)
    if (val) warningTimer = setTimeout(() => { filterWarning.value = "" }, 3000)
})

function onRangeInput(type: string) {
    filterError.value = ""
    filterWarning.value = ""
}

function toggleDifficulty(val: string) {
    filterWarning.value = ""
    const i = difficultyFilter.value.indexOf(val)
    if (i >= 0) difficultyFilter.value.splice(i, 1)
    else difficultyFilter.value.push(val)
}

function commitCurrent() {
    if (activeFilterType.value === "time") commitTime()
    else if (activeFilterType.value === "memory") commitMem()
    else if (activeFilterType.value === "id") commitId()
}

function isDuplicate(arr: RangeEntry[], min: string, max: string) {
    return arr.some(r => r.min === min && r.max === max)
}

function isSubset(a: RangeEntry, b: RangeEntry) {
    const aMin = a.min ? Number(a.min) : -Infinity
    const aMax = a.max ? Number(a.max) : Infinity
    const bMin = b.min ? Number(b.min) : -Infinity
    const bMax = b.max ? Number(b.max) : Infinity
    return bMin <= aMin && bMax >= aMax
}

function deduplicate(arr: RangeEntry[]) {
    let removed = 0
    for (let i = arr.length - 1; i >= 0; i--) {
        const covered = arr.some((b, j) => j !== i && isSubset(arr[i], b))
        if (covered) { arr.splice(i, 1); removed++ }
    }
    return removed
}

function commitTime() {
    filterWarning.value = ""
    const rawMin = timeMinInput.value
    const rawMax = timeMaxInput.value
    if (!rawMin && !rawMax) return
    if (rawMin.includes("-") || rawMax.includes("-")) {
        filterError.value = "不允许负数"
        timeMinInput.value = ""; timeMaxInput.value = ""
        return
    }
    if (!/^\d*$/.test(rawMin) || !/^\d*$/.test(rawMax)) {
        filterError.value = "请输入数字"
        timeMinInput.value = ""; timeMaxInput.value = ""
        return
    }
    const min = rawMin; const max = rawMax
    if (min && max && Number(min) > Number(max)) {
        filterError.value = "最小值不能大于最大值"
        timeMinInput.value = ""; timeMaxInput.value = ""
        return
    }
    if ((min && Number(min) < 1) || (max && Number(max) < 1)) {
        filterError.value = "最小值为 1ms"
        timeMinInput.value = ""; timeMaxInput.value = ""
        return
    }
    if (isDuplicate(timeRanges.value, min, max)) {
        filterWarning.value = "该范围已存在"
        timeMinInput.value = ""; timeMaxInput.value = ""
        return
    }
    timeRanges.value.push({ min, max })
    if (deduplicate(timeRanges.value)) filterWarning.value = "已移除被覆盖的范围"
    timeMinInput.value = ""; timeMaxInput.value = ""
}

function commitMem() {
    filterWarning.value = ""
    const rawMin = memMinInput.value
    const rawMax = memMaxInput.value
    if (!rawMin && !rawMax) return
    if (rawMin.includes("-") || rawMax.includes("-")) {
        filterError.value = "不允许负数"
        memMinInput.value = ""; memMaxInput.value = ""
        return
    }
    if (!/^\d*$/.test(rawMin) || !/^\d*$/.test(rawMax)) {
        filterError.value = "请输入数字"
        memMinInput.value = ""; memMaxInput.value = ""
        return
    }
    const min = rawMin; const max = rawMax
    if (min && max && Number(min) > Number(max)) {
        filterError.value = "最小值不能大于最大值"
        memMinInput.value = ""; memMaxInput.value = ""
        return
    }
    if ((min && Number(min) < 1) || (max && Number(max) < 1)) {
        filterError.value = "最小值为 1MB"
        memMinInput.value = ""; memMaxInput.value = ""
        return
    }
    if (isDuplicate(memRanges.value, min, max)) {
        filterWarning.value = "该范围已存在"
        memMinInput.value = ""; memMaxInput.value = ""
        return
    }
    memRanges.value.push({ min, max })
    if (deduplicate(memRanges.value)) filterWarning.value = "已移除被覆盖的范围"
    memMinInput.value = ""; memMaxInput.value = ""
}

function commitId() {
    filterWarning.value = ""
    const rawMin = idMinInput.value
    const rawMax = idMaxInput.value
    if (!rawMin && !rawMax) return
    if (rawMin.includes("-") || rawMax.includes("-")) {
        filterError.value = "不允许负数"
        idMinInput.value = ""; idMaxInput.value = ""
        return
    }
    if (!/^\d*$/.test(rawMin) || !/^\d*$/.test(rawMax)) {
        filterError.value = "请输入数字"
        idMinInput.value = ""; idMaxInput.value = ""
        return
    }
    const min = rawMin; const max = rawMax
    if (min && max && Number(min) > Number(max)) {
        filterError.value = "起始编号不能大于结束编号"
        idMinInput.value = ""; idMaxInput.value = ""
        return
    }
    if (isDuplicate(idRanges.value, min, max)) {
        filterWarning.value = "该范围已存在"
        idMinInput.value = ""; idMaxInput.value = ""
        return
    }
    const ids = problems.value.map((p: any) => Number(p.id)).filter((n: number) => !isNaN(n))
    const minId = Math.min(...ids)
    const maxId = Math.max(...ids)
    if ((min && (Number(min) < minId || Number(min) > maxId)) ||
        (max && (Number(max) < minId || Number(max) > maxId))) {
        filterError.value = `题号范围 ${minId} ~ ${maxId}`
        idMinInput.value = ""; idMaxInput.value = ""
        return
    }
    idRanges.value.push({ min, max })
    if (deduplicate(idRanges.value)) filterWarning.value = "已移除被覆盖的范围"
    idMinInput.value = ""; idMaxInput.value = ""
}

function rangeLabel(r: RangeEntry, unit: string) {
    if (r.min && r.max) {
        if (r.min === r.max) return `${r.min}${unit}`
        return `${r.min}~${r.max}${unit}`
    }
    if (r.min) return `≥${r.min}${unit}`
    return `≤${r.max}${unit}`
}

const filterTypes = [
    { key: "difficulty", label: "难度" },
    { key: "time", label: "时间限制" },
    { key: "memory", label: "空间限制" },
    { key: "id", label: "题号范围" },
]

const difficultyOptions = [
    { value: "easy", label: "简单" },
    { value: "medium", label: "中等" },
    { value: "hard", label: "困难" },
]

const activeFilters = computed(() => {
    const tags: { key: string; label: string; value: string; type: string }[] = []
    for (const v of difficultyFilter.value) {
        const d = difficultyOptions.find(o => o.value === v)
        tags.push({ key: `difficulty:${v}`, label: "难度", value: d?.label || "", type: "difficulty" })
    }
    for (let i = 0; i < timeRanges.value.length; i++) {
        tags.push({ key: `time:${i}`, label: "时间", value: rangeLabel(timeRanges.value[i], "ms"), type: "time" })
    }
    for (let i = 0; i < memRanges.value.length; i++) {
        tags.push({ key: `memory:${i}`, label: "空间", value: rangeLabel(memRanges.value[i], "MB"), type: "memory" })
    }
    for (let i = 0; i < idRanges.value.length; i++) {
        tags.push({ key: `id:${i}`, label: "题号", value: rangeLabel(idRanges.value[i], ""), type: "id" })
    }
    return tags
})

function removeFilter(key: string) {
    if (key.startsWith("difficulty:")) difficultyFilter.value = difficultyFilter.value.filter(v => `difficulty:${v}` !== key)
    else if (key.startsWith("time:")) timeRanges.value.splice(Number(key.slice(5)), 1)
    else if (key.startsWith("memory:")) memRanges.value.splice(Number(key.slice(7)), 1)
    else if (key.startsWith("id:")) idRanges.value.splice(Number(key.slice(3)), 1)
}

function clearAllFilters() {
    difficultyFilter.value = []
    timeRanges.value = []
    memRanges.value = []
    idRanges.value = []
    activeFilterType.value = ""
    filterError.value = ""
    filterWarning.value = ""
    search.value = ""
}

const problems = computed(() => (data.value as any)?.data ?? [])

function toggleSort(key: SortKey) {
    if (sortKey.value === key) {
        sortDir.value = sortDir.value === "asc" ? "desc" : "asc"
    } else {
        sortKey.value = key
        sortDir.value = "desc"
    }
}

const filteredProblems = computed(() => {
    let list = [...(problems.value as any[])]

    if (search.value.trim()) {
        const q = search.value.trim().toLowerCase()
        list = list.filter(p => p.title.toLowerCase().includes(q) || String(p.id).toLowerCase().includes(q))
    }

    if (showDetailedSearch.value && difficultyFilter.value.length) {
        list = list.filter(p => difficultyFilter.value.includes(p.difficulty))
    }

    if (showDetailedSearch.value && timeRanges.value.length) {
        list = list.filter(p => timeRanges.value.some(r => {
            const v = p.time_limit_ms
            if (r.min && r.max) return v >= Number(r.min) && v <= Number(r.max)
            if (r.min) return v >= Number(r.min)
            return v <= Number(r.max)
        }))
    }

    if (showDetailedSearch.value && memRanges.value.length) {
        list = list.filter(p => memRanges.value.some(r => {
            const v = p.memory_limit_mb
            if (r.min && r.max) return v >= Number(r.min) && v <= Number(r.max)
            if (r.min) return v >= Number(r.min)
            return v <= Number(r.max)
        }))
    }

    if (showDetailedSearch.value && idRanges.value.length) {
        list = list.filter(p => idRanges.value.some(r => {
            const pid = String(p.id)
            if (r.min && r.max) return pid.localeCompare(r.min) >= 0 && pid.localeCompare(r.max) <= 0
            if (r.min) return pid.localeCompare(r.min) >= 0
            return pid.localeCompare(r.max) <= 0
        }))
    }

    list.sort((a, b) => {
        let va = a[sortKey.value]
        let vb = b[sortKey.value]
        if (sortKey.value === "title") { va = va.toLowerCase(); vb = vb.toLowerCase() }
        if (va < vb) return sortDir.value === "asc" ? -1 : 1
        if (va > vb) return sortDir.value === "asc" ? 1 : -1
        return 0
    })

    return list
})

const totalPages = computed(() => Math.max(1, Math.ceil(filteredProblems.value.length / perPage)))

const pagedProblems = computed(() => {
    const start = (page.value - 1) * perPage
    return filteredProblems.value.slice(start, start + perPage)
})

watch([search, difficultyFilter, timeRanges, memRanges, idRanges, sortKey, sortDir], () => { page.value = 1 }, { deep: true })

function difficultyLabel(d: string) {
    return { easy: "简单", medium: "中等", hard: "困难" }[d] || d
}

function shortId(id: string) {
    return id.length > 8 ? id.slice(0, 8) : id
}
</script>

<style scoped>
.page {
    padding: 32px 24px;
    max-width: 1060px;
    margin: 0 auto;
}

.loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 80px 0;
    color: var(--c-text-secondary);
    font-size: 15px;
}

.spinner {
    animation: spin 0.8s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

.error {
    text-align: center;
    padding: 80px 0;
    color: #dc2626;
    font-size: 15px;
}

.content {
    animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
    from { opacity: 0; transform: translateX(30px); }
    to { opacity: 1; transform: translateX(0); }
}

.sub-nav {
    position: sticky;
    top: 64px;
    z-index: 50;
    background: var(--c-bg-page);
    border-bottom: 1px solid var(--c-border);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
    padding: 12px 0;
    margin-bottom: 4px;
}

.sub-nav-inner {
    max-width: 1060px;
    margin: 0 auto;
    padding: 0 24px;
}

.search-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}

.search-wrapper {
    position: relative;
    flex: 1;
    min-width: 200px;
}

.search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--c-text-muted);
    pointer-events: none;
}

.search-input {
    width: 100%;
    padding: 9px 12px 9px 38px;
    border: 1.5px solid var(--c-border);
    border-radius: 8px;
    font-size: 14px;
    color: var(--c-text);
    background: var(--c-white);
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
}

.search-input:focus {
    border-color: var(--c-primary);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.search-input::placeholder {
    color: var(--c-text-muted);
}

.detail-toggle {
    padding: 9px 16px;
    border: 1.5px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-white);
    font-size: 14px;
    color: var(--c-text-secondary);
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.2s;
    flex-shrink: 0;
}

.detail-toggle:hover {
    border-color: var(--c-primary);
    color: var(--c-primary);
}

.detail-toggle.active {
    background: var(--c-primary);
    border-color: var(--c-primary);
    color: var(--c-white);
}

.filter-row {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
}

.filter-group {
    display: flex;
    align-items: center;
    gap: 0;
    height: 36px;
    box-sizing: border-box;
    padding: 5px 10px;
    border: 1.5px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-white);
    transition: border-color 0.2s;
}

.filter-group:focus-within {
    border-color: var(--c-primary);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.filter-inputs-wrap {
    overflow: hidden;
    min-width: 0;
    max-width: 0;
    height: 26px;
    transition: max-width 0.3s ease;
    flex-shrink: 0;
}

.filter-group.has-inputs .filter-inputs-wrap {
    max-width: 320px;
}

.msg-enter-active {
    transition: opacity 0.2s ease, transform 0.2s ease;
}

.msg-leave-active {
    transition: opacity 0.15s ease, transform 0.15s ease;
}

.msg-enter-from {
    opacity: 0;
    transform: translateX(16px);
}

.msg-leave-to {
    opacity: 0;
    transform: translateX(-16px);
}

.filter-msg {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
}

.filter-error {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    font-size: 12px;
    color: #dc2626;
    line-height: 1.4;
    white-space: nowrap;
}

.filter-warning {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    font-size: 12px;
    color: #ca8a04;
    line-height: 1.4;
    white-space: nowrap;
}

.msg-icon {
    flex-shrink: 0;
}

.detail-collapse {
    max-height: 0;
    overflow: hidden;
    opacity: 0;
    transition: max-height 0.5s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s ease;
}

.detail-collapse.open {
    max-height: 500px;
    opacity: 1;
}

.filter-enter-active,
.filter-leave-active {
    transition: opacity 0.3s ease, transform 0.3s ease;
}

.filter-enter-from {
    opacity: 0;
    transform: translateY(-8px);
}

.filter-leave-to {
    opacity: 0;
    transform: translateY(8px);
}

.filter-enter-active > * {
    animation: childEnter 0.2s ease both;
}

.filter-leave-active > * {
    animation: childLeave 0.2s ease both;
}

@keyframes childEnter {
    from { opacity: 0; transform: translateY(-8px); }
    to   { opacity: 1; transform: translateY(0); }
}

@keyframes childLeave {
    from { opacity: 1; transform: translateY(0); }
    to   { opacity: 0; transform: translateY(8px); }
}

.filter-enter-active > *:nth-child(1) { animation-delay: 0ms; }
.filter-enter-active > *:nth-child(2) { animation-delay: 40ms; }
.filter-enter-active > *:nth-child(3) { animation-delay: 80ms; }

.filter-leave-active > *:nth-child(1) { animation-delay: 80ms; }
.filter-leave-active > *:nth-child(2) { animation-delay: 40ms; }
.filter-leave-active > *:nth-child(3) { animation-delay: 0ms; }

.confirm-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1.5px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-white);
    color: var(--c-text-secondary);
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
}

.confirm-btn:hover {
    border-color: var(--c-primary);
    color: var(--c-primary);
    background: var(--c-primary-bg);
}

.filter-select {
    border: none;
    background: transparent;
    font-size: 13px;
    color: var(--c-text);
    outline: none;
    cursor: pointer;
    min-width: 110px;
    flex-shrink: 0;
    transition: min-width 0.2s ease;
}

.filter-inputs {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 10px;
    border-left: 1.5px solid var(--c-border);
}

.filter-inputs .num-input {
    width: 100px;
    height: 26px;
    padding: 0 8px;
    border: 1.5px solid var(--c-border);
    border-radius: 6px;
    font-size: 13px;
    color: var(--c-text);
    outline: none;
    transition: width 0.2s ease, border-color 0.2s;
    box-sizing: border-box;
}

.filter-inputs .num-input:focus {
    border-color: var(--c-primary);
}

.filter-inputs .sep {
    color: var(--c-text-muted);
    font-size: 13px;
}

.tag-btn {
    height: 26px;
    padding: 0 12px;
    border: 1.5px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-white);
    font-size: 13px;
    color: var(--c-text-secondary);
    cursor: pointer;
    transition: all 0.15s;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
}

.tag-btn:hover {
    border-color: var(--c-primary);
    color: var(--c-primary);
}

.tag-btn.selected {
    background: var(--c-primary);
    border-color: var(--c-primary);
    color: var(--c-white);
}

.active-tags {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    flex-wrap: wrap;
}

.filter-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border: 1px solid;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
}

.filter-tag--difficulty {
    background: var(--c-primary-bg);
    border-color: var(--c-primary);
    color: var(--c-primary);
}

.filter-tag--difficulty .tag-remove { color: var(--c-primary); }

.tag-value--easy { color: #16a34a; }
.tag-value--medium { color: #ca8a04; }
.tag-value--hard { color: #dc2626; }

.tag-value--easy { color: #16a34a; }
.tag-value--medium { color: #ca8a04; }
.tag-value--hard { color: #dc2626; }

.filter-tag--time {
    background: #ecfeff;
    border-color: #0891b2;
    color: #0891b2;
}

.filter-tag--time .tag-remove { color: #0891b2; }

.filter-tag--memory {
    background: #fffbeb;
    border-color: #d97706;
    color: #d97706;
}

.filter-tag--memory .tag-remove { color: #d97706; }

.filter-tag--id {
    background: #eef2ff;
    border-color: #4f46e5;
    color: #4f46e5;
}

.filter-tag--id .tag-remove { color: #4f46e5; }

.tag-remove {
    background: none;
    border: none;
    color: var(--c-primary);
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    line-height: 1;
    opacity: 0.6;
    transition: opacity 0.15s;
}

.tag-remove:hover {
    opacity: 1;
}

.clear-all {
    background: none;
    border: none;
    font-size: 13px;
    color: var(--c-text-muted);
    cursor: pointer;
    padding: 4px 8px;
    transition: color 0.15s;
}

.clear-all:hover {
    color: #dc2626;
}

.table-wrap {
    background: var(--c-white);
    border: 1px solid var(--c-border);
    border-radius: 10px;
    overflow: hidden;
    animation: fadeIn 0.35s ease backwards;
}

.problem-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
}

.problem-table th {
    padding: 12px 16px;
    font-size: 13px;
    font-weight: 600;
    color: var(--c-text-secondary);
    text-align: left;
    background: var(--c-bg-page);
    border-bottom: 1px solid var(--c-border);
    cursor: pointer;
    user-select: none;
    transition: color 0.15s;
    white-space: nowrap;
}

.problem-table th svg {
    vertical-align: -2px;
    margin-right: 4px;
    opacity: 0.7;
}

.problem-table th.col-diff,
.problem-table th.col-time,
.problem-table th.col-mem {
    text-align: center;
}

.problem-table th.col-time,
.problem-table th.col-mem {
    padding-right: 24px;
}

.problem-table th:hover {
    color: var(--c-primary);
}

.sort-arrow {
    font-size: 10px;
    margin-left: 3px;
    color: var(--c-primary);
}

.problem-table td {
    padding: 12px 16px;
    font-size: 14px;
    color: var(--c-text);
    border-bottom: 1px solid var(--c-border);
}

.problem-table tbody tr {
    cursor: pointer;
    transition: background 0.15s;
}

.problem-table tbody tr:nth-child(1) { --delay: 0.02s; }
.problem-table tbody tr:nth-child(2) { --delay: 0.04s; }
.problem-table tbody tr:nth-child(3) { --delay: 0.06s; }
.problem-table tbody tr:nth-child(4) { --delay: 0.08s; }
.problem-table tbody tr:nth-child(5) { --delay: 0.10s; }
.problem-table tbody tr:nth-child(6) { --delay: 0.12s; }
.problem-table tbody tr:nth-child(7) { --delay: 0.14s; }
.problem-table tbody tr:nth-child(8) { --delay: 0.16s; }
.problem-table tbody tr:nth-child(9) { --delay: 0.18s; }
.problem-table tbody tr:nth-child(10) { --delay: 0.20s; }
.problem-table tbody tr:nth-child(11) { --delay: 0.22s; }
.problem-table tbody tr:nth-child(12) { --delay: 0.24s; }
.problem-table tbody tr:nth-child(13) { --delay: 0.26s; }
.problem-table tbody tr:nth-child(14) { --delay: 0.28s; }
.problem-table tbody tr:nth-child(15) { --delay: 0.30s; }

.problem-table tbody tr td {
    animation: fadeIn 0.25s ease backwards;
    animation-delay: var(--delay, 0s);
}

.problem-table tbody tr:hover {
    background: var(--c-primary-bg);
}

.problem-table tbody tr:last-child td {
    border-bottom: none;
}

.col-id { width: 100px; }
.col-diff { width: 80px; text-align: center; }
.col-time { width: 110px; text-align: center; padding-right: 24px !important; font-weight: 600; }
.col-mem { width: 110px; text-align: center; padding-right: 24px !important; font-weight: 600; }

.col-diff .difficulty {
    display: inline-block;
}

.problem-id {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 13px;
    color: var(--c-text-muted);
}

.problem-title {
    font-weight: 600;
    color: var(--c-text);
    text-decoration: none;
    transition: color 0.2s;
}

.problem-title:hover {
    color: var(--c-primary);
}

.difficulty {
    font-size: 12px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    display: inline-block;
}

.difficulty--easy {
    color: #16a34a;
    background: #f0fdf4;
}

.difficulty--medium {
    color: #ca8a04;
    background: #fefce8;
}

.difficulty--hard {
    color: #dc2626;
    background: #fef2f2;
}

.empty {
    text-align: center;
    padding: 48px 0 !important;
    color: var(--c-text-muted);
    font-size: 15px;
}

.pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-top: 24px;
    padding-top: 20px;
    border-top: 1px solid var(--c-border);
}

.page-btn {
    padding: 8px 20px;
    border: 1.5px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-white);
    font-size: 14px;
    color: var(--c-text-secondary);
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s;
}

.page-btn:hover:not(:disabled) {
    border-color: var(--c-primary);
    color: var(--c-primary);
    background: var(--c-primary-bg);
}

.page-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
}

.page-info {
    font-size: 14px;
    color: var(--c-text-secondary);
    min-width: 80px;
    text-align: center;
}

.page-input {
    width: 36px;
    height: 28px;
    padding: 0 4px;
    border: 1.5px solid var(--c-border);
    border-radius: 6px;
    font-size: 14px;
    color: var(--c-text);
    text-align: center;
    outline: none;
    transition: border-color 0.2s;
    box-sizing: border-box;
}

.page-input:focus {
    border-color: var(--c-primary);
}
</style>
