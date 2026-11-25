import { Trans, useTranslation } from 'react-i18next';
import { useAckAlert, useAlerts, useDealView } from '../api/queries';
import type { DealReport } from '../api/types';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { useNow } from '../lib/useNow';
import { dealRunProps } from './DealModalBits';
import { RunView } from './RunView';

export function DealModal({ dealId, onClose }: { dealId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const view = useDealView(dealId);
  const alerts = useAlerts();
  const ack = useAckAlert();
  const now = useNow(1_000);
  const report: DealReport | null = view.data?.pair.reportJson ? (JSON.parse(view.data.pair.reportJson) as DealReport) : null;
  const alertLines = (alerts.data ?? [])
    .filter((a) => a.pairId === dealId)
    .map((a) => (
      <span key={a.id} role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-rose-300">
        <span>{a.message}</span>
        <button type="button" className="btn-ghost-xs shrink-0" onClick={() => ack.mutate(a.id)}>
          {t('common.dismiss')}
        </button>
      </span>
    ));

  return (
    <Modal
      onClose={onClose}
      widthClass="w-[560px]"
      title={
        <Trans
          i18nKey="trade.deal.title"
          values={{ id: dealId.slice(0, 8) }}
          components={{ n: <span className="num text-ink-400" /> }}
        />
      }
    >
      {!view.data ? (
        <div className="py-6 text-center text-xs text-ink-500">
          {view.isError ? (
            <span role="alert" className="text-rose-300">
              {t('trade.deal.loadFailed')}
            </span>
          ) : (
            <Spinner className="inline h-4 w-4" />
          )}
        </div>
      ) : (
        <RunView {...dealRunProps(view.data, report, now, alertLines)} />
      )}
    </Modal>
  );
}
