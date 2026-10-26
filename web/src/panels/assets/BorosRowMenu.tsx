import { MoreHorizontal } from 'lucide-react';
import { DropdownMenu } from '../../components/DropdownMenu';

export function BorosRowMenu({ label, onExclude }: { label: string; onExclude: () => void }) {
  return (
    <DropdownMenu
      label="More actions"
      trigger={<MoreHorizontal size={12} aria-hidden />}
      triggerClassName="btn-ghost-xs !px-1.5"
      items={[{ label, onSelect: onExclude }]}
    />
  );
}
