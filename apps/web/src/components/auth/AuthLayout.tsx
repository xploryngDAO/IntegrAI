import type { ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Heading, Text } from '@xploryng/convergencia';
import { useTheme } from '../../lib/theme';
import { Avatar, Card, IconButton } from '../ui';

export interface AuthLayoutProps {
  title: string;
  description: string;
  children: ReactNode;
}

/**
 * Shared chrome for the session-free screens (login, signup, e-mail
 * verification and password recovery): brand block, theme switch and the
 * Convergência paper card on the cool background.
 *
 * Keeping it in one place means a link mailed by the API opens a screen that
 * looks like the same product as the workspace, without duplicating layout.
 */
export function AuthLayout({ title, description, children }: AuthLayoutProps): JSX.Element {
  const { theme, toggle } = useTheme();

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-10">
      <div className="absolute right-5 top-5">
        <IconButton
          label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}
          icon={theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          onClick={toggle}
        />
      </div>

      {/* `m-auto` centres the card when there is room and, unlike
          `justify-center`, never clips the top on short viewports. */}
      <div className="m-auto w-full max-w-[430px]">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-[var(--cv-radius-control)] bg-[var(--cv-color-accent)] font-mono text-[13px] font-semibold tracking-[0.06em] text-[var(--cv-color-on-accent)]">
            SH
          </span>
          <div>
            <div className="font-mono text-[15px] font-semibold tracking-[0.16em] text-[var(--cv-color-text)]">
              SAC HUB
            </div>
            <div className="text-[var(--cv-font-micro)] uppercase tracking-[0.1em] text-[var(--cv-color-text-muted)]">
              Central de atendimento omnichannel
            </div>
          </div>
        </div>

        <Card className="gap-4 p-6">
          <div className="flex flex-col gap-1">
            <Heading level={2}>{title}</Heading>
            <Text muted>{description}</Text>
          </div>
          {children}
        </Card>

        <div className="mt-6 flex items-center justify-center gap-2 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
          <Avatar name="SAC Hub" size="sm" />
          Amazon SP-API · Mercado Livre · Shopee Open Platform v2
        </div>
      </div>
    </div>
  );
}
