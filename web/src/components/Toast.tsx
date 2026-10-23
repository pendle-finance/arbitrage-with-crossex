import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'error' | 'success' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  key?: string;
  action?: ToastAction;
}

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  action?: ToastAction;
  key?: string;
}

interface ToastApi {
  push: (kind: ToastKind, text: string, opts?: ToastOptions) => void;
  clear: (key: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

/** For components that also render in provider-less unit tests. */
export function useToastOptional(): ToastApi | null {
  return useContext(ToastCtx);
}

const KIND_CLASSES: Record<ToastKind, string> = {
  error: 'border-rose-500/50 text-rose-200',
  success: 'border-emerald-500/50 text-emerald-200',
  info: 'border-ink-600 text-ink-200',
};

/** Tiny toast host: bottom-right stack, auto-dismiss after 5s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string, opts?: ToastOptions) => {
      const id = ++seq.current;
      const key = opts?.key;
      setToasts((prev) => [
        ...prev.filter((t) => key === undefined || t.key !== key),
        { id, kind, text, key, action: opts?.action },
      ]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const clear = useCallback((key: string) => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
  }, []);

  return (
    <ToastCtx.Provider value={{ push, clear }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="alert"
            className={`pointer-events-auto flex items-center gap-3 rounded border bg-ink-900 px-4 py-3 text-xs ${KIND_CLASSES[t.kind]}`}
          >
            <span className="flex-1">{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="btn-link shrink-0"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
