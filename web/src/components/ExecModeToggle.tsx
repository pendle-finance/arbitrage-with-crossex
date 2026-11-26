import type { ReactNode } from 'react';
import type { ExecMode } from '../trade/PairTicketBits';
import { SegmentedToggle } from './SegmentedToggle';

export function ExecModeToggle({
  value,
  onChange,
  ariaLabel,
  labels,
  order,
  subs,
  fill,
  className,
}: {
  value: ExecMode;
  onChange: (m: ExecMode) => void;
  ariaLabel: string;
  labels: Record<ExecMode, ReactNode>;
  order: ExecMode[];
  subs?: Partial<Record<ExecMode, ReactNode>>;
  fill?: boolean;
  className?: string;
}) {
  return (
    <SegmentedToggle<ExecMode>
      ariaLabel={ariaLabel}
      fill={fill}
      className={className}
      value={value}
      onChange={onChange}
      options={order.map((mode) => ({ value: mode, label: labels[mode], sub: subs?.[mode] }))}
    />
  );
}
