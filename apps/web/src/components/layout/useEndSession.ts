import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useWorkspace } from '../../lib/store';
import { endSession, type LogoutScope } from '../../lib/session';

export interface EndSessionHandle {
  /** Ends the session and always lands on `/login`, even if the API failed. */
  end: () => Promise<void>;
  /** True while the logout request is in flight. */
  pending: boolean;
}

/**
 * Shared sign-out behaviour for the user menu, the rail button and the profile
 * page: `POST /auth/logout` first, local cleanup regardless of the answer, then
 * a soft navigation to `/login`.
 *
 * The local session is never kept alive by an API failure: the user asked to
 * leave, so leaving is the guaranteed outcome and the toast only reports that
 * the server could not confirm the revocation.
 */
export function useEndSession(scope: LogoutScope = 'current'): EndSessionHandle {
  const navigate = useNavigate();
  const pushToast = useWorkspace((state) => state.pushToast);
  const [pending, setPending] = useState(false);

  const end = useCallback(async (): Promise<void> => {
    if (pending) return;
    setPending(true);

    const result = await endSession({ scope });
    if (!result.serverOk) {
      // Pushed after the store reset so the toast survives on the login screen.
      pushToast({
        tone: 'warn',
        title: 'Sessão encerrada neste navegador',
        description:
          result.error ??
          'A API não confirmou a revogação. Entre novamente para abrir uma nova sessão.',
      });
    }

    navigate('/login', { replace: true });
  }, [navigate, pending, pushToast, scope]);

  return { end, pending };
}
