/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { Alert, Input, Skeleton } from './primitives.tsx';
import { useEffect, useRef, useState } from 'react';
import { getMonacoLanguage } from '../../utils/editorLanguages.ts';

/** Monaco 只在浏览器挂载，worker 沿用已有自托管清单；卸载释放 editor 和 model。 */
export function CodeEditor({ value, language, onChange, disabled }: {
  value: string;
  language: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null);
  const module = useRef<typeof import('monaco-editor') | null>(null);
  const latest = useRef({ value, language, onChange, disabled });
  latest.current = { value, language, onChange, disabled };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      try {
        const [monaco, response] = await Promise.all([import('monaco-editor'), fetch('/monaco/workers.json')]);
        if (!response.ok) throw new Error('Monaco worker 清单不可用');
        const manifest = await response.json() as { editor?: string; workers?: Record<string, string> };
        if (disposed || !container.current) return;
        self.MonacoEnvironment = {
          getWorker(_workerId: string, label: string) {
            const worker = manifest.workers?.[label] ?? manifest.editor;
            if (!worker || worker.includes('..') || worker.startsWith('/')) throw new Error('编辑器 worker 路径无效');
            return new Worker(`/monaco/${worker}`);
          },
        };
        const editor = monaco.editor.create(container.current, {
          ariaLabel: '代码',
          value: latest.current.value,
          language: getMonacoLanguage(latest.current.language),
          theme: 'vs',
          readOnly: latest.current.disabled,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 14,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 4,
          padding: { top: 16, bottom: 16 },
        });
        instance.current = editor;
        module.current = monaco;
        const subscription = editor.onDidChangeModelContent(() => latest.current.onChange(editor.getValue()));
        cleanup = () => {
          subscription.dispose();
          const model = editor.getModel();
          editor.dispose();
          model?.dispose();
          instance.current = null;
        };
        setReady(true);
      } catch {
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);
  useEffect(() => {
    const editor = instance.current;
    if (editor && editor.getValue() !== value) {
      const selection = editor.getSelection();
      editor.setValue(value);
      if (selection) editor.setSelection(selection);
    }
  }, [value, ready]);
  useEffect(() => {
    const model = instance.current?.getModel();
    if (model && module.current) module.current.editor.setModelLanguage(model, getMonacoLanguage(language));
    instance.current?.updateOptions({ readOnly: disabled });
  }, [language, disabled, ready]);
  if (failed) {
    return (
      <div>
        <Alert type='warning' title='高级编辑器加载失败，已切换到文本编辑。' />
        <Input.TextArea
          aria-label='代码'
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          rows={20}
          className='!font-mono'
        />
      </div>
    );
  }
  return (
    <div className='relative'>
      {!ready && (
        <div className='absolute inset-0 z-10 bg-white p-6'>
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      )}
      <div ref={container} className='h-[520px] w-full' aria-label='代码编辑器' />
    </div>
  );
}
