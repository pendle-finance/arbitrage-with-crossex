/** Friendly dead-ends for a missing/broken/newer-schema `?d=` — the raw param
 * is never echoed back (it's attacker-controlled text). */
import { EmptyState } from '../components/EmptyState';

export function InvalidLink({ reason }: { reason: 'missing' | 'malformed' | 'version' }) {
  const copy =
    reason === 'version'
      ? {
          title: 'This link was made by a newer terminal',
          hint: 'The position data uses a format this site does not know yet — try again after the site updates, or ask the sender to re-share.',
        }
      : reason === 'missing'
        ? {
            title: 'No position in this link',
            hint: 'A shared position link carries the position data after ?d= — this one has none.',
          }
        : {
            title: 'This share link looks malformed',
            hint: "The position data in the link couldn't be read — it may have been truncated when copied. Ask the sender to share it again.",
          };

  return (
    <EmptyState
      icon="⚠"
      title={copy.title}
      hint={copy.hint}
      action={
        <a href="/" className="btn btn-primary">
          See live opportunities instead →
        </a>
      }
    />
  );
}
