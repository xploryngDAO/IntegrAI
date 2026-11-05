import type { AgentRecord, AgentLoad, AgentPresenceStatus } from '@sac/shared';

import type { IAgentSummary } from '@sac/shared';

export function toAgentSummary(agent: AgentRecord, activeTickets: number): IAgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    email: agent.email,
    role: agent.role,
    presence: agent.presence,
    avatarColor: agent.avatarColor,
    activeTickets,
  };
}

export function toAgentLoad(agent: AgentRecord, activeTickets: number): AgentLoad {
  return {
    agentId: agent.id,
    agentName: agent.name,
    presence: agent.presence,
    activeTickets,
    maxConcurrent: agent.maxConcurrent ?? 20,
  };
}

const PRESENCE_RANK: Record<AgentPresenceStatus, number> = {
  ONLINE: 0,
  PAUSED: 1,
  OFFLINE: 2,
};

/** Online first, then alphabetical - the order the assignment dropdown uses. */
export function compareAgentsByPresence(a: IAgentSummary, b: IAgentSummary): number {
  const rank = PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence];
  if (rank !== 0) return rank;
  return a.name.localeCompare(b.name, 'pt-BR');
}
