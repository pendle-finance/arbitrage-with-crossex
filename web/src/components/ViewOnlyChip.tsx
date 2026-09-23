import { Chip } from './Chip';
import { Eye } from 'lucide-react';

export function ViewOnlyChip() {
  return (
    <Chip sm tone="neutral" className="inline-flex items-center gap-1">
      <Eye size={12} aria-hidden />
      View only
    </Chip>
  );
}
