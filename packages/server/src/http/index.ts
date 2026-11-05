/**
 * HTTP + realtime layer entry point.
 *
 * Frozen integration surface consumed by `src/container.ts` / `src/index.ts`
 * (core-engine): `RealtimeHub`, `createRealtimeHub`, `HttpServerOptions` and
 * `buildHttpApp`.
 */
export { buildHttpApp } from './app';
export { createRealtimeHub } from './realtime-hub';
export type { RealtimeHub, RealtimeHubOptions } from './realtime-hub';
export type { HttpRouteContext, HttpServerOptions, RouteHandler } from './types';
export { API_PREFIX, HUB_PATH, HUB_ROOM_ALL } from './constants';
