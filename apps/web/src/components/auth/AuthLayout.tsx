import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';
import { Heading, Text } from '@xploryng/convergencia';
import { useTheme } from '../../lib/theme';
import { BrandMark } from '../layout/BrandMark';
import { Card, IconButton } from '../ui';

export interface AuthLayoutProps {
  title: string;
  /** Optional supporting line under the heading (the login gate omits it). */
  description?: string;
  /**
   * Short product anchor rendered above the heading, in the same micro-label
   * language as the rest of the ops shell. It tells the operator what the
   * product does before the credential form without becoming a hero.
   */
  eyebrow?: ReactNode;
  children: ReactNode;
}

/**
 * Shared chrome for the session-free screens (login, signup, e-mail
 * verification and password recovery): brand block, theme switch and the
 * Convergência paper card on the cool background.
 *
 * The block is deliberately left-aligned on phones (the card fills the
 * viewport, the brand sits on the same edge) instead of being centred like a
 * tutorial dialog; from `sm` up the card is centred on the page but its
 * contents keep the same left edge.
 *
 * Keeping it in one place means a link mailed by the API opens a screen that
 * looks like the same product as the workspace, without duplicating layout.
 */
export function AuthLayout({
  title,
  description,
  eyebrow,
  children,
}: AuthLayoutProps): JSX.Element {
  const { theme, toggle } = useTheme();

  return (
    <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-8 sm:py-10">
      <div className="absolute right-4 top-4 sm:right-5 sm:top-5">
        <IconButton
          className="sac-auth-theme"
          label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}
          icon={theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          onClick={toggle}
        />
      </div>

      {/* `m-auto` centres the card when there is room and, unlike
          `justify-center`, never clips the top on short viewports. */}
      <div className="m-auto w-full max-w-[430px]">
        <BrandMark className="mb-5 sm:mb-6" />

        <Card padded={false} className="gap-4 p-5 sm:p-6">
          <div className="flex flex-col gap-1">
            {eyebrow !== undefined ? (
              <p className="sac-label m-0 leading-snug">{eyebrow}</p>
            ) : null}
            <Heading level={2}>{title}</Heading>
            {description !== undefined ? <Text muted>{description}</Text> : null}
          </div>
          {children}
        </Card>

        <div className="mt-5 flex flex-col items-start gap-3 sm:mt-6">
          <Link
            to="/status"
            className="text-[var(--cv-font-micro)] uppercase tracking-[0.08em] text-[var(--cv-color-text-muted)] underline-offset-2 hover:text-[var(--cv-color-text)] hover:underline"
          >
            Status dos sistemas
          </Link>
        </div>
      </div>
    </main>
  );
}
