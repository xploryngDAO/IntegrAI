import { describe, expect, it } from 'vitest';
import {
  claimHasMediator,
  claimPlayersMetadata,
  directionFromClaimUserIds,
  extractAvailableActionNames,
  extractClaimOrderId,
  extractRespondentActions,
  findClaimPlayer,
  normalizeActionGuide,
  normalizeAttachments,
} from '../mappers';
import type { MeliClaim } from '../types';

/**
 * Fixture shaped like `GET /post-purchase/v1/claims/{claim_id}` (players carry
 * the seller's available actions under `role = respondent`).
 */
const claimFixture: MeliClaim = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  resource: 'order',
  resource_id: 2000012345678901,
  status: 'opened',
  stage: 'claim',
  type: 'mediations',
  date_created: '2026-02-01T10:00:00.000Z',
  last_updated: '2026-02-02T11:30:00.000Z',
  due_date: '2026-02-05T18:00:00.000Z',
  players: [
    {
      role: 'complainant',
      user_id: 111111111,
      available_actions: [{ action: 'send_message' }],
    },
    {
      role: 'respondent',
      user_id: 222222222,
      available_actions: [
        { action: 'allow_return', due_date: '2026-02-04T12:00:00.000Z' },
        { action: 'refund', status: 'available' },
        { action: 'open_dispute' },
      ],
    },
    {
      role: 'mediator',
      user_id: 333333333,
      available_actions: [],
    },
  ],
  resolution: null,
  claim_window: { due_date: '2026-02-05T18:00:00.000Z' },
};

const claimWithoutMediator: MeliClaim = {
  ...claimFixture,
  players: (claimFixture.players ?? []).filter((player) => player.role !== 'mediator'),
};

describe('claim available_actions extraction', () => {
  it('reads the seller actions from players[role=respondent] only', () => {
    const actions = extractRespondentActions(claimFixture);
    expect(actions).toHaveLength(3);
    expect(extractAvailableActionNames(actions)).toEqual([
      'allow_return',
      'refund',
      'open_dispute',
    ]);

    const complainant = findClaimPlayer(claimFixture, 'complainant');
    expect(complainant?.user_id).toBe(111111111);
    expect(
      extractAvailableActionNames(extractRespondentActions(claimFixture)),
    ).not.toContain('send_message');
  });

  it('returns an empty list when the respondent is absent', () => {
    const actions = extractRespondentActions({ ...claimFixture, players: [] });
    expect(actions).toEqual([]);
  });

  it('keeps due_date / status of each available action', () => {
    const actions = extractRespondentActions(claimFixture);
    const allowReturn = actions.find((action) => action.action === 'allow_return');
    expect(allowReturn?.due_date).toBe('2026-02-04T12:00:00.000Z');
    const refund = actions.find((action) => action.action === 'refund');
    expect(refund?.status).toBe('available');
  });

  it('derives the claim order id and mediator presence', () => {
    expect(extractClaimOrderId(claimFixture)).toBe('2000012345678901');
    expect(claimHasMediator(claimFixture)).toBe(true);
    expect(claimHasMediator(claimWithoutMediator)).toBe(false);
    expect(
      extractClaimOrderId({ id: 'c1', resource: '2000099999999999', players: [] }),
    ).toBe('2000099999999999');
  });

  it('maps claim players to serializable channel_metadata', () => {
    const players = claimPlayersMetadata(claimFixture);
    expect(players).toHaveLength(3);
    const respondent = players.find((player) => player.role === 'respondent');
    expect(respondent?.user_id).toBe('222222222');
    expect(
      (respondent?.available_actions as Array<{ action: string | null }>).map(
        (action) => action.action,
      ),
    ).toEqual(['allow_return', 'refund', 'open_dispute']);
  });

  it('classifies claim message senders (buyer, seller panel, mediator)', () => {
    expect(directionFromClaimUserIds('111111111', '111111111', '222222222', '333333333')).toBe(
      'INBOUND_BUYER',
    );
    expect(directionFromClaimUserIds('222222222', '111111111', '222222222', '333333333')).toBe(
      'EXTERNAL_SELLER_PANEL',
    );
    expect(directionFromClaimUserIds('333333333', '111111111', '222222222', '333333333')).toBe(
      'MEDIATOR',
    );
  });
});

describe('claim action guide + attachments mapping', () => {
  it('normalizes the blocked-chat action guide options', () => {
    const guide = normalizeActionGuide({
      options: [
        { option_id: 10, description: 'Produto com defeito' },
        { id: 11, title: 'Não recebi o produto' },
      ],
      pack_id: 200001,
    });
    expect(guide?.blocked).toBe(true);
    expect(guide?.pack_id).toBe('200001');
    expect(guide?.options).toEqual([
      { option_id: '10', description: 'Produto com defeito', action: null },
      { option_id: '11', description: 'Não recebi o produto', action: null },
    ]);
  });

  it('normalizes claim message attachments into inbound descriptors', () => {
    const attachments = normalizeAttachments([
      {
        id: 'att-1',
        filename: 'comprovante.pdf',
        type: 'application/pdf',
        size: 2048,
        url: 'https://http2.mlstatic.com/comprovante.pdf',
      },
    ]);
    expect(attachments).toEqual([
      {
        fileName: 'comprovante.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        sourceUrl: 'https://http2.mlstatic.com/comprovante.pdf',
        externalUploadId: 'att-1',
      },
    ]);
  });
});
