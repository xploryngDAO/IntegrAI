import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';
import { Heading, Text } from '@xploryng/convergencia';
import { useTheme } from '../../lib/theme';
import { BrandMark } from '../layout/BrandMark';
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
        <BrandMark className="mb-6" />

        <Card className="gap-4 p-6">
          <div className="flex flex-col gap-1">
            <Heading level={2}>{title}</Heading>
            <Text muted>{description}</Text>
          </div>
          {children}
        </Card>

        <div className="mt-6 flex flex-col items-center gap-3">
          <div className="flex items-center justify-center gap-2 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
            <Avatar name="SAC Hub" size="sm" />
            Amazon SP-API · Mercado Livre · Shopee Open Platform v2
          </div>
          <Link
            to="/status"
            className="text-[var(--cv-font-micro)] uppercase tracking-[0.08em] text-[var(--cv-color-text-muted)] underline-offset-2 hover:text-[var(--cv-color-text)] hover:underline"
          >
            Status dos sistemas
          </Link>
        </div>
      </div>
    </div>
  );
}
