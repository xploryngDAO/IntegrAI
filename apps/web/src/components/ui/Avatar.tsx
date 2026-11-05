import { Avatar as CvAvatar } from '@xploryng/convergencia';

export type AvatarSize = 'sm' | 'md' | 'lg';

/**
 * Initials avatar from Convergência. Product-owned imagery can be supplied via
 * `src`; without it the accessible initials fallback is used.
 */
export function Avatar({
  name,
  size = 'md',
  src,
}: {
  name: string;
  size?: AvatarSize;
  src?: string;
}) {
  return <CvAvatar name={name} size={size} src={src} />;
}
