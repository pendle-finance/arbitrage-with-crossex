import { useEffect, useState } from 'react';

export function useSettledError(status: 'pending' | 'error' | 'success', error: Error | null): Error | null {
  const [settled, setSettled] = useState<Error | null>(null);
  useEffect(() => {
    if (status === 'success') setSettled(null);
    if (status === 'error') setSettled(error);
  }, [status, error]);
  return settled;
}
