import { Chip } from './Chip';
import { Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function ViewOnlyChip() {
  const { t } = useTranslation();
  return (
    <Chip sm tone="neutral" className="inline-flex items-center gap-1">
      <Eye size={12} aria-hidden />
      {t('common.viewOnly')}
    </Chip>
  );
}
