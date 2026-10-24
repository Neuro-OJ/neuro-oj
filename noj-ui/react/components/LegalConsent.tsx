/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { useState } from 'react';
import { toast } from 'sonner';
import { collectPendingConsents } from '../../utils/legalConsent.ts';
import { errorInfo } from '../api.ts';
import { useAppState } from '../state.tsx';
import type { User } from '../types.ts';
import { Alert, Button } from './primitives.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx';

/** 沿用原有重大政策变更门槛、接口及文案，不改变同意记录的业务规则。 */
export function LegalConsent() {
  const { user, api, setUser } = useAppState();
  const pending = collectPendingConsents(user?.legal);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  if (!pending.length || user?.must_change_password) return null;
  async function agreeAll() {
    setSubmitting(true);
    setError('');
    try {
      for (const item of pending) await api.post('/api/v1/legal/consent', { kind: item.kind }, { silent: true });
      const refreshed = await api.get<{ data: User }>('/api/v1/auth/me', { silent: true });
      setUser(refreshed.data);
      toast.success('感谢确认，已记录你的同意');
    } catch (caught) {
      setError(errorInfo(caught).message);
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>政策更新通知</DialogTitle>
          <DialogDescription>我们更新了以下条款。请阅读并确认后继续使用本平台：</DialogDescription>
        </DialogHeader>
        <ul className='space-y-3 text-sm'>
          {pending.map((item) => (
            <li key={item.kind}>
              <b>{item.label}</b>
              <span className='ml-2 text-text-muted tabular-nums'>v{item.agreedVersion} → v{item.requiredVersion}</span>
              {item.changeSummary && <p className='mt-1 text-xs text-text-muted'>变更摘要：{item.changeSummary}</p>}
              {(item.kind === 'privacy' || item.kind === 'terms') && (
                <a
                  className='mt-1 inline-block text-xs text-primary'
                  href={item.kind === 'terms' ? '/legal/terms' : '/legal/privacy'}
                  target='_blank'
                  rel='noopener noreferrer'
                >
                  查看全文
                </a>
              )}
            </li>
          ))}
        </ul>
        <p className='text-xs text-text-muted'>我已年满 14 周岁，或在监护人陪同下已阅读并同意更新后的上述条款。</p>
        {error && <Alert type='error' title={error} />}
        <DialogFooter>
          <Button variant='default' block loading={submitting} onClick={() => void agreeAll()}>我已知悉并同意</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
