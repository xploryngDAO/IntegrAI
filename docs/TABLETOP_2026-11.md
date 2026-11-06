# Tabletop de resposta a incidente — TT-20251106-01

> Exercício técnico (não é um incidente real). Cenário hipotético executado em
> 2026-11-06 contra a produção para medir contenção, auditoria e decisão de
> notificação. LGPD Art. 48; Res. CD/ANPD nº 15/2024, Art. 10.

## Cenário

Um operador envia ao suporte uma captura de tela em que o token de acesso
(`Authorization: Bearer ...`) aparece legível no DevTools. A captura circula em
um grupo interno. A conta é ADMIN de um workspace com dados de compradores.

## Detecção

Alertas/configuração avaliados:

1. `/profile` → **Sessões ativas** mostra dispositivos e permite revogar.
2. `new device` alerta por e-mail (implementado).
3. Trilha de auditoria (`/admin/audit-logs`) já registra logins, logout e agora
   **`auth.sessions.revoked_others`**.
4. Monitor de uptime não cobre vazamento de credencial (é disponibilidade).

## Contenção executada no drill (medições reais)

| Passo | Comando | Resultado |
|---|---|---|
| Abertura de sessão A | `POST /auth/login` | token A válido |
| Abertura de sessão B | `POST /auth/login` | token B (dispositivo “seguro”) |
| Revogar os demais | `POST /auth/sessions/revoke-others` (B) | **208 sessões revogadas em 68 ms** |
| Refresh do token roubado | `POST /auth/refresh` | **401** (refresh morto) |
| Acesso do token roubado | `GET /auth/me` | **ainda 200 até expirar (≤1 h)** — ver achado |
| Contenção total | `POST /auth/logout` (sem refresh) em B | watermark → `/auth/me` do token A **401** |
| Auditoria | `GET /admin/audit-logs?action=auth.sessions.revoked_others` | 1 evento, ator `admin@integr-ai.local`, `metadata.revoked=208` |

## Achados

1. **P1 — `revoke-others` não invalida access tokens já emitidos.** O refresh é
   revogado (imediatamente) e o JWT de acesso continua válido até expirar
   (`JWT_EXPIRES_IN=1h`). É o trade-off stateless clássico, mas **a resposta a
   incidente deve usar “encerrar todas as sessões” (`POST /auth/logout` sem
   refreshToken)**, que estampa o watermark e derruba o JWT na hora (validado:
   401 em <1 s).
2. **P2 — auditoria de contenção.** Não havia evento de auditoria para
   `revoke-others`; agora existe (`auth.sessions.revoked_others`) com ator/IP/UA
   e contagem — necessário para o registro de 5 anos (Res. 15/2024).
3. **P2 — comunicação.** O texto de ajuda deve orientar: “se você desconfia do
   token, use Sair de todos os dispositivos; revogar outros dispositivos troca
   apenas o refresh”.

## Decisão de notificação (hipotética)

- **Há dados pessoais no escopo?** Sim (mensagens/CPF/pedido de compradores).
- **Houve acesso por terceiro?** No drill, não; em caso real, a decisão depende
  de evidência de uso.
- **Notificável à ANPD?** Se confirmado acesso/exfiltração com risco relevante:
  **sim**, em até **3 dias úteis** (Res. 15/2024), com registro dos 12 itens
  obrigatórios; titulares afetados notificados conforme Art. 48 §1º.
- Registro deste exercício: `.lgpd/incidents/log.md` (entrada TT, não incidente).

## Ações de follow-up

| # | Ação | Onde |
|---|---|---|
| 1 | Runbook diferencia revogar-others × logout-all | `docs/RUNBOOK.md` §7 |
| 2 | Evento de auditoria da contenção | implementado + este doc |
| 3 | Texto de ajuda no `/profile` (recomendação) | backlog UX |
| 4 | Repetir o drill a cada release maior (tabletop) | calendário do DPO |

**Tempo total de contenção no drill:** < 1 s após a decisão de encerrar todas as
sessões; refresh do atacante invalidado em 68 ms com `revoke-others`.
