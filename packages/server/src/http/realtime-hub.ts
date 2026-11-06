import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import type { Socket } from 'socket.io';
import { verify as verifyJwt } from 'jsonwebtoken';
import {
  isAccessTokenDenied,
  isUserTokenRevoked,
} from '../application/auth/access-token-revocation';
import {
  MAINTENANCE_ERROR_CODE,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  MARKETPLACES,
  type ICache,
} from '@sac/shared';
import type {
  AgentPresenceEvent,
  AgentPresenceStatus,
  ChannelHealthSnapshot,
  IClock,
  ILogger,
  IRealtimePublisher,
  MaintenanceState,
  MessageRealtimeEvent,
  TicketRealtimeEvent,
} from '@sac/shared';
import { HUB_PATH, HUB_ROOM_ALL } from './constants';
import { isRecord } from './utils/guards';

/** Contract surface consumed by the server bootstrap (frozen). */
export interface RealtimeHub {
  publisher: IRealtimePublisher;
  attach(server: HttpServer): void;
  close(): Promise<void>;
}

export interface RealtimeHubOptions {
  logger: ILogger;
  cache?: ICache;
  clock: IClock;
  jwtSecret: string;
  webOrigin: string;
  /**
   * Controlled maintenance window (`MAINTENANCE_MODE`).
   *
   * While enabled the Engine.IO handshake is refused with HTTP 503
   * (`MAINTENANCE` + `Retry-After`), before any token verification, so clients
   * fail fast instead of polling an API that answers every request with 503.
   */
  maintenance?: MaintenanceState;
}

/* ----------------------------- Socket.IO typing ---------------------------- */

interface ClientToServerEvents {
  subscribe: (payload: unknown) => void;
  'presence:set': (payload: unknown) => void;
}

interface ServerToClientEvents {
  'ticket:updated': (event: TicketRealtimeEvent) => void;
  'message:created': (event: MessageRealtimeEvent) => void;
  'queue:changed': (payload: QueueChangedPayload) => void;
  'channel:health': (snapshot: ChannelHealthSnapshot) => void;
  'agent:presence': (event: AgentPresenceEvent) => void;
}

interface QueueChangedPayload {
  reason: string;
  ticketId?: string;
  at: string;
}

interface HubSocketData {
  agentId: string;
  agentName: string;
  agentEmail: string;
  agentRole: string;
  /** Per-socket dynamic subscriptions (rooms joined via `subscribe`). */
  rooms: string[];
}

type HubServer = SocketServer<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  HubSocketData
>;
type HubSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, HubSocketData>;

interface SocketClaims {
  agentId: string;
  agentName: string;
  agentEmail: string;
  agentRole: string;
}

/* ------------------------------- Room helpers ------------------------------ */

const marketplaceRoom = (marketplace: string): string => `marketplace:${marketplace}`;
const accountRoom = (accountId: string): string => `account:${accountId}`;

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isAgentPresence(value: unknown): value is AgentPresenceStatus {
  return value === 'ONLINE' || value === 'PAUSED' || value === 'OFFLINE';
}

function isMarketplaceValue(value: unknown): value is string {
  return typeof value === 'string' && (MARKETPLACES as readonly string[]).includes(value);
}

/**
 * Socket.IO hub implementing `IRealtimePublisher`.
 *
 * Rooms:
 *  - `all`                 every authenticated socket (queue-wide events)
 *  - `marketplace:<X>`     one of AMAZON | MERCADO_LIVRE | SHOPEE
 *  - `account:<id>`        a connected marketplace account (per-store dashboards)
 *
 * Events published before `attach()` are intentionally dropped (debug log): the
 * HTTP app is built before the server listens, and buffering stale state would
 * replay obsolete snapshots to the first client.
 *
 * Maintenance window (`options.maintenance.enabled`): new handshakes are refused
 * at the Engine.IO layer with HTTP 503 `MAINTENANCE` + `Retry-After` BEFORE the
 * token check. Decision: blocking the handshake is safer than accepting a socket
 * the API would never serve a request for - it stops the polling loop and gives
 * the SPA an explicit error to render. Sockets already connected when the window
 * opens are not force-disconnected (the process restarts with the new env).
 */
export function createRealtimeHub(options: RealtimeHubOptions): RealtimeHub {
  const log = options.logger.child({ component: 'realtime-hub' });
  let server: HubServer | null = null;

  const dropUnattached = (event: string): void => {
    log.debug('realtime.event_dropped', { event, reason: 'hub_not_attached' });
  };

  const publisher: IRealtimePublisher = {
    ticketUpdated(event: TicketRealtimeEvent): void {
      if (server === null) {
        dropUnattached('ticket:updated');
        return;
      }
      server.to([HUB_ROOM_ALL, marketplaceRoom(event.marketplace)]).emit('ticket:updated', event);
    },

    messageCreated(event: MessageRealtimeEvent): void {
      if (server === null) {
        dropUnattached('message:created');
        return;
      }
      server.to(HUB_ROOM_ALL).emit('message:created', event);
    },

    queueChanged(payload: QueueChangedPayload): void {
      if (server === null) {
        dropUnattached('queue:changed');
        return;
      }
      server.to(HUB_ROOM_ALL).emit('queue:changed', payload);
    },

    channelHealth(snapshot: ChannelHealthSnapshot): void {
      if (server === null) {
        dropUnattached('channel:health');
        return;
      }
      server
        .to([HUB_ROOM_ALL, marketplaceRoom(snapshot.marketplace), accountRoom(snapshot.accountId)])
        .emit('channel:health', snapshot);
    },

    agentPresence(event: AgentPresenceEvent): void {
      if (server === null) {
        dropUnattached('agent:presence');
        return;
      }
      server.to(HUB_ROOM_ALL).emit('agent:presence', event);
    },
  };

  const extractHandshakeToken = (socket: HubSocket): string | null => {
    const auth: unknown = socket.handshake.auth;
    if (isRecord(auth)) {
      const candidate = auth['token'];
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }

    const header = socket.handshake.headers.authorization;
    if (typeof header === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      const token = match?.[1]?.trim();
      if (token !== undefined && token.length > 0) return token;
    }

    const queryToken = socket.handshake.query['token'];
    if (typeof queryToken === 'string' && queryToken.length > 0) return queryToken;

    return null;
  };

  const verifyToken = async (token: string): Promise<SocketClaims | null> => {
    try {
      const decoded = verifyJwt(token, options.jwtSecret, { algorithms: ['HS256'] });
      if (typeof decoded === 'string') return null;

      const agentId: unknown = decoded.agentId ?? decoded.sub;
      if (typeof agentId !== 'string' || agentId.length === 0) return null;

      // Access tokens revoked by logout must not open realtime sessions.
      if (await isAccessTokenDenied({ jti: typeof decoded.jti === 'string' ? decoded.jti : undefined, cache: options.cache, logger: options.logger })) {
        return null;
      }

      // Same per-user watermark as `AgentService.verifyToken`: "logout
      // everywhere" and password reset also close realtime sessions opened with
      // an older access token, not just new HTTP requests.
      if (
        await isUserTokenRevoked({
          userId: agentId,
          issuedAt: typeof decoded.iat === 'number' ? decoded.iat : undefined,
          cache: options.cache,
          logger: options.logger,
        })
      ) {
        return null;
      }

      return {
        agentId,
        agentName: typeof decoded.name === 'string' ? decoded.name : '',
        agentEmail: typeof decoded.email === 'string' ? decoded.email : '',
        agentRole: typeof decoded.role === 'string' ? decoded.role : 'AGENT',
      };
    } catch {
      return null;
    }
  };

  const parseSubscription = (payload: unknown): string[] | null => {
    if (!isRecord(payload)) return null;

    const rooms: string[] = [];
    const marketplaces = payload['marketplaces'];
    if (Array.isArray(marketplaces)) {
      for (const candidate of marketplaces) {
        if (isMarketplaceValue(candidate)) rooms.push(marketplaceRoom(candidate));
      }
    }

    const accountId = payload['accountId'];
    if (typeof accountId === 'string' && ACCOUNT_ID_PATTERN.test(accountId)) {
      rooms.push(accountRoom(accountId));
    }

    return rooms;
  };

  const parsePresence = (payload: unknown): AgentPresenceStatus | null => {
    if (!isRecord(payload)) return null;
    const presence = payload['presence'];
    return isAgentPresence(presence) ? presence : null;
  };

  const attach = (httpServer: HttpServer): void => {
    if (server !== null) {
      log.warn('realtime.attach_ignored', { reason: 'already_attached' });
      return;
    }

    const io: HubServer = new SocketServer<
      ClientToServerEvents,
      ServerToClientEvents,
      Record<string, never>,
      HubSocketData
    >(httpServer, {
      path: HUB_PATH,
      serveClient: false,
      cors: {
        origin: options.webOrigin
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      pingInterval: 25_000,
      pingTimeout: 20_000,
      maxHttpBufferSize: 1_000_000,
    });

    // Controlled maintenance window: refuse the Engine.IO handshake at the HTTP
    // layer, before any Socket.IO namespace/token work. A client therefore gets
    // an immediate 503 with the same MAINTENANCE contract as the REST surface
    // (and a Retry-After hint) instead of holding a polling transport open
    // against an API that would answer every request with 503.
    const maintenance = options.maintenance;
    if (maintenance?.enabled === true) {
      io.engine.use((_request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'retry-after': String(MAINTENANCE_RETRY_AFTER_SECONDS),
        });
        response.end(
          JSON.stringify({
            error: {
              code: MAINTENANCE_ERROR_CODE,
              message: maintenance.message,
              details: { retryAfterSeconds: MAINTENANCE_RETRY_AFTER_SECONDS },
            },
          }),
        );
      });
      log.warn('realtime.maintenance_enabled', { message: maintenance.message });
    }

    io.use(async (socket, next) => {
      const token = extractHandshakeToken(socket);
      if (token === null) {
        next(new Error('AUTHENTICATION_ERROR: missing token'));
        return;
      }

      const claims = await verifyToken(token);
      if (claims === null) {
        next(new Error('AUTHENTICATION_ERROR: invalid or expired token'));
        return;
      }

      socket.data.agentId = claims.agentId;
      socket.data.agentName = claims.agentName;
      socket.data.agentEmail = claims.agentEmail;
      socket.data.agentRole = claims.agentRole;
      socket.data.rooms = [];
      next();
    });

    io.on('connection', (socket) => {
      socket.join(HUB_ROOM_ALL);
      log.info('realtime.connected', { socketId: socket.id, agentId: socket.data.agentId });

      socket.on('subscribe', (payload: unknown) => {
        const rooms = parseSubscription(payload);
        if (rooms === null) {
          log.warn('realtime.subscribe_invalid', { socketId: socket.id, agentId: socket.data.agentId });
          return;
        }

        for (const room of socket.data.rooms) socket.leave(room);
        socket.data.rooms = rooms;
        for (const room of rooms) socket.join(room);

        log.debug('realtime.subscribed', {
          socketId: socket.id,
          agentId: socket.data.agentId,
          rooms,
        });
      });

      socket.on('presence:set', (payload: unknown) => {
        const presence = parsePresence(payload);
        if (presence === null) {
          log.warn('realtime.presence_invalid', { socketId: socket.id, agentId: socket.data.agentId });
          return;
        }

        io.to(HUB_ROOM_ALL).emit('agent:presence', {
          agentId: socket.data.agentId,
          agentName: socket.data.agentName,
          presence,
          at: options.clock.now().toISOString(),
        });
      });

      socket.on('disconnect', (reason) => {
        log.info('realtime.disconnected', {
          socketId: socket.id,
          agentId: socket.data.agentId,
          reason,
        });
      });
    });

    io.on('connection_error', (error) => {
      log.warn('realtime.connection_error', { message: error.message, code: error.code });
    });

    server = io;
    log.info('realtime.attached', { path: HUB_PATH });
  };

  const close = async (): Promise<void> => {
    const current = server;
    server = null;
    if (current === null) return;

    current.removeAllListeners();
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
    });
    log.info('realtime.closed');
  };

  return { publisher, attach, close };
}
