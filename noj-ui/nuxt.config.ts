// https://nuxt.com/docs/api/configuration/nuxt-config
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const apiBase = process.env.NUXT_API_BASE ?? 'http://localhost:8000';
// 站点对外地址（用于 sitemap/canonical 等需要**绝对 URL** 的场景）。
// 必须来自配置而非请求 Host 头：Host 由客户端控制，一旦被写入进程级缓存
// 就是缓存投毒（2026-09-12 架构评审 §4.2）。未配置时 sitemap 会退化为
// "按 Host 分键缓存 + 形状校验"，仅用于本地开发。
const siteUrl = process.env.NUXT_SITE_URL ?? '';

/**
 * 构建身份（前端三要素）：版本 / commit / 构建时间。
 *
 * 生产：release.yml 以 build-arg 注入 `NOJ_BUILD_*`，本文件在**构建期**读入并写进
 * `runtimeConfig.public`，随 nuxt build 一起编译进产物（运行期无需再读 ENV，也不
 * 产生额外请求）。
 *
 * 开发：无 ENV 时回退本地真值——version 取 `package.json`，commit 取本地
 * `git rev-parse --short HEAD`（工作区脏则缀 `-dirty`），`builtAt` 取 dev server
 * 本次启动时刻（dev 没有"构建"这一步，用启动时刻才能回答"我重启过没有"）。
 * 镜像内没有 `.git`，所以生产路径不会调用 git。
 */
function resolveBuildInfo(): {
  version: string;
  commit: string | null;
  builtAt: string;
} {
  /** 执行 git 并返回标准输出；无 git / 非仓库 / 出错一律返回 null。 */
  const git = (args: string[]): string | null => {
    try {
      return execSync(`git ${args}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };

  const envVersion = process.env.NOJ_BUILD_VERSION?.trim();
  const envCommit = process.env.NOJ_BUILD_COMMIT?.trim();
  const envBuiltAt = process.env.NOJ_BUILD_TIME?.trim();

  let pkgVersion = 'unknown';
  try {
    pkgVersion = String(
      (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
        version?: string;
      }).version ?? 'unknown',
    );
  } catch {
    // package.json 不可读：保持 unknown
  }

  let commit = envCommit || null;
  if (!commit) {
    const head = git('rev-parse --short HEAD');
    if (head) commit = git('status --porcelain') ? `${head}-dirty` : head;
  }

  return {
    version: envVersion || pkgVersion,
    commit,
    builtAt: envBuiltAt || new Date().toISOString(),
  };
}

export default defineNuxtConfig({
  compatibilityDate: '2026-06-26',
  devtools: { enabled: true },
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],

  // @nuxt/icon：lucide 集合本地打包，SSR/单二进制离线渲染图标
  // （scan 扫描源码中实际用到的图标打包进客户端；@nuxt/icon 2.x 无
  //   collections / includeAllCollections 选项，配置会被忽略，已移除）
  icon: {
    serverBundle: 'local',
    clientBundle: {
      scan: true,
    },
  },

  // @nuxt/fonts：仅保留本地 provider（fonts.google.com 元数据 API 在大陆网络不可达，
  // 远程 provider 会导致 SSR 模块加载挂起；字体回退到系统字体栈）
  fonts: {
    providers: {
      google: false,
      googleicons: false,
      bunny: false,
      adobe: false,
      fontshare: false,
    },
  },

  // 运行时配置（服务端私有，不暴露给浏览器）
  runtimeConfig: {
    apiBase,
    siteUrl,
    // 前端构建身份：`public` 段会随 SSR payload 下发到浏览器，页脚据此渲染。
    // 值在构建期定型（见 resolveBuildInfo），运行期不读 ENV。
    public: {
      buildInfo: resolveBuildInfo(),
    },
  },

  // 子目录组件不添加路径前缀（feature/LatestSubmissions.vue → <LatestSubmissions>）
  components: {
    dirs: [{ path: '~/components', pathPrefix: false }],
  },

  // API 请求由 server/api/[...slug].ts 代理到 noj-core

  app: {
    head: {
      // 页面语言声明（WCAG 3.1.1）：缺失时屏幕阅读器无法确定朗读语言
      htmlAttrs: {
        lang: 'zh-CN',
      },
      title: 'Neuro OJ',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Neuro OJ — 面向 AI 领域认证与竞赛（IOAI / NOAI / LMCC）的在线评测平台' },
        { property: 'og:title', content: 'Neuro OJ' },
        {
          property: 'og:description',
          content: 'Neuro OJ — 面向 AI 领域认证与竞赛（IOAI / NOAI / LMCC）的在线评测平台',
        },
        { property: 'og:type', content: 'website' },
      ],
    },
  },

  // Deno Compile 用，删了没法编译
  hooks: {
    close: () => {
      // 仅在编译产物（deno compile 单二进制）中主动退出；
      // nuxt dev 的配置变更重启也会触发 close，直接退出会杀掉整个开发服务器
      // （管理后台创建竞赛时前端报「网络连接失败，请检查网络」的根因）。
      if (!process.argv.includes('dev')) {
        process.exit(0);
      }
    },
  },

  // 通用 API 代理不在 Nitro 层启用 SWR：代理响应可能是上游 Node 响应对象，无法安全
  // 序列化；同时同一路径下存在按用户鉴权/个性化的接口（例如 U 型题列表），缓存会
  // 导致请求挂起、复用错误响应，甚至把一个用户的数据暴露给另一个用户。需要缓存时，
  // 应在明确的、非个性化 server handler 中单独实现。
  routeRules: {
    '/api/v1/auth/**': { headers: { 'cache-control': 'no-store' } },
    '/api/v1/submissions/**': { headers: { 'cache-control': 'no-store' } },
    '/api/v1/queue/**': { headers: { 'cache-control': 'no-store' } },
    '/api/v1/community/**': { headers: { 'cache-control': 'no-store' } },
    '/api/v1/users/me/**': { headers: { 'cache-control': 'no-store' } },
  },

  nitro: {
    preset: 'deno-server',
  },
});
