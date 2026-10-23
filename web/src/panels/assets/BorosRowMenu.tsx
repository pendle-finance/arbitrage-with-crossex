import { MoreHorizontal } from 'lucide-react';
import { useRef } from 'react';
import { HoverCard } from '../../components/HoverCard';

export function BorosRowMenu({ label, onExclude }: { label: string; onExclude: () => void }) {
  const pressed = useRef(false);
  return (
    <HoverCard
      wrapsControl
      openOn="click"
      widthPx={160}
      label={
        <button
          type="button"
          aria-label="More actions"
          aria-haspopup="dialog"
          className="btn-ghost-xs !px-1.5"
          onClick={() => {
            pressed.current = false;
          }}
        >
          <MoreHorizontal size={12} aria-hidden />
        </button>
      }
    >
      <button
        type="button"
        data-close-card
        className="btn-link whitespace-nowrap text-left text-xs font-semibold"
        onClick={() => {
          if (pressed.current) return;
          pressed.current = true;
          onExclude();
        }}
      >
        {label}
      </button>
    </HoverCard>
  );
}
