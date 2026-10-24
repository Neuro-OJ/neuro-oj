import ts from 'typescript';

/**
 * 混合迁移期仅编译 react/ 下的 TSX，避免 Nuxt 的 Vue JSX 默认配置影响 React。
 * 不修改全局 JSX/Refresh 配置，现有 Vue 页面继续使用原编译链。
 */
export function reactTsxPlugin() {
  return {
    name: 'noj-react-tsx',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const filename = id.split('?')[0]!;
      if (!/\/react\/.*\.tsx$/.test(filename)) return null;
      const result = ts.transpileModule(code, {
        fileName: filename,
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          jsxImportSource: 'react',
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          sourceMap: true,
          inlineSources: true,
        },
      });
      return {
        code: result.outputText.replace(/\/\/# sourceMappingURL=.*$/m, ''),
        map: result.sourceMapText ? JSON.parse(result.sourceMapText) : null,
      };
    },
  };
}
