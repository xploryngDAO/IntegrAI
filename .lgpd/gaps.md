# LGPD — gap analysis inicial (technical)

> Prioridades: **P0** bloqueia conformidade; **P1** risco relevante;
> **P2** melhoria. Cada item cita a norma aplicável. Revisão jurídica obrigatória.

## P0 — pendências de governança/legal

| ID | Gap | Norma | Ação |
|---|---|---|---|
| LG-01 | Encarregado (DPO) não designado nem publicado | Art. 41 LGPD; Res. CD/ANPD nº 18/2024 | designar, publicar identidade/contato, registrar |
| LG-02 | Política de privacidade não publicada/versionada | Art. 9 LGPD | redigir, revisar juridicamente, publicar e versionar |
| LG-03 | ROPA não consolidado | Art. 37 LGPD | validar `.lgpd/data-map.md` e gerar ROPA oficial |
| LG-04 | Canal do titular não publicado formalmente | Art. 18 LGPD | e-mail/formulário público + prazo de resposta documentado |
| LG-05 | DPAs com operadores não formalizados (marketplaces, S3, e-mail, gateway) | Art. 39 LGPD | contratos/anexos de tratamento por fornecedor |
| LG-06 | Avaliação de transferência internacional ausente | Arts. 33–36 LGPD; Res. CD/ANPD nº 19/2024 | mapear regiões de S3/e-mail/gateway e cláusulas-padrão |

## P1 — técnico/operacional

| ID | Gap | Referência | Ação |
|---|---|---|---|
| LG-07 | Base legal por atividade apenas proposta no mapa (não aprovada) | Art. 7/11 LGPD | validar com encarregado; registrar no ROPA |
| LG-08 | RIPD não avaliado (perfilamento/volume de mensagens) | Art. 38 LGPD; Res. CD/ANPD nº 2/2022 | triagem de alto risco; RIPD se aplicável |
| LG-09 | PII de comprador em mensagens/anexos sem prazo de expurgo por tipo | Art. 15/16 LGPD | definir retenção por categoria e job de expurgo |
| LG-10 | Operadores não classificados por risco; sem auditoria de fornecedores | Art. 39 LGPD | vendor audit + DPAs |
| LG-11 | Registro de incidentes (5 anos) ainda não iniciado | Art. 48 LGPD; Res. CD/ANPD nº 15/2024, Art. 10 | manter `.lgpd/incidents/log.md` a partir do primeiro evento |
| LG-12 | Sem teste tabletop de resposta a incidente | Res. CD/ANPD nº 15/2024 | simular vazamento e medir 3 dias úteis |
| LG-13 | Consentimento não se aplica como base principal, mas marketing/analytics não avaliados | Art. 7, I e Art. 8 | confirmar ausência de finalidades que exijam consentimento |

## Controles já implementados (evidências)

| Controle | Onde |
|---|---|
| Cifra AES-256-GCM de tokens/segredos | `docs/SECURITY.md`, `infra` |
| JWT curto + refresh rotativo + revogação (jti/watermark) | `auth`, `/auth/logout`, sessões |
| 2FA + política obrigatória + reset administrativo | `/settings`, `/admin/users` |
| RBAC + isolamento multi-tenant testado | `scripts/isolation-test.mjs` (14/14) |
| Auditoria de ações e exportações | `audit_events`, `/admin/audit-logs` |
| Retenção de auditoria (5 anos) e de backups | config + `TenantBackupService.purgeExpired` |
| Purga física do tenant (soft delete + retenção 30d) | `TenantPurgeService` |
| Redação de PII em logs | `redactPiiForLogs` |
| Alertas de novo dispositivo / mudança de conta | e-mails + auditoria |
| Exportação do workspace (portabilidade) | `/tenants/me/export` |

## Próximos checkpoints (exigem aprovação humana)

1. ROPA consolidado (Art. 37) — pausa para revisão.
2. Política de privacidade v1 (Art. 9) — pausa para revisão jurídica.
3. RIPD, se a triagem classificar como alto risco (Art. 38).
4. Designação e publicação do encarregado (Art. 41).

> A plataforma está tecnicamente preparada para os controles acima; a conformidade
> formal depende dos artefatos legais e da governança do controlador.

## Atualizações 2026-11-06

| ID | Status | Evidência |
|---|---|---|
| LG-09 | **Mitigado tecnicamente** | `PII_RETENTION_DAYS` + `PII_PURGE_CRON`; retenção por backup/auditoria e purga do tenant |
| LG-11 | **Parcial** | registro 5 anos inicializado em `.lgpd/incidents/log.md` (sem incidentes até a data) |
| LG-12 | **Concluído por drill técnico** | tabletop `docs/TABLETOP_2026-11.md` executado em 2026-11-06; repetir a cada release maior |
| LG-13 | **Confirmado não aplicável** | produto não usa marketing/analytics de terceiros; base legal operacional é execução de contrato/legítimo interesse |

Controles técnicos de DSAR, isolamento, cifra, retenção e detecção foram validados
no go-live (ver `docs/LIVE_VALIDATIONS.md`). Os P0 (governança/legal) seguem
pendentes de encarregado e revisão jurídica.
