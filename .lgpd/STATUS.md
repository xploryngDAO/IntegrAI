# LGPD — estado da auditoria (IntegrAI)

**Projeto**: IntegrAI (SAC Hub)
**Cenário assumido**: **C — Híbrido** (base em produção + features novas em desenvolvimento)
**Início**: 06/11/2026
**Última atualização**: 06/11/2026
**Encarregado (DPO)**: pendente de designação formal (Art. 41 LGPD; Res. CD/ANPD nº 18/2024)

> **Aviso:** este é um levantamento técnico de conformidade, não parecer jurídico.
> Artefatos legais (política de privacidade, ROPA final, RIPD, comunicação à ANPD)
> exigem revisão de advogado/encarregado antes de publicação (checkpoint do pipeline).

## Pipeline (recorte executado)

- [x] Setup `.lgpd/`
- [x] Data mapping (inventário a partir do código)
- [x] Gap analysis inicial (`gaps.md`)
- [ ] Legal basis por atividade
- [ ] ROPA consolidado (Art. 37)
- [ ] Política de privacidade publicada (Art. 9)
- [ ] Designação e publicação do encarregado
- [ ] RIPD (se atividade de alto risco)
- [ ] DPAs com operadores (marketplaces, AWS/S3, e-mail, gateway)

## Artefatos

- `.lgpd/data-map.md` — inventário de tratamentos (v1)
- `.lgpd/gaps.md` — não conformidades e prioridades
- `docs/SECURITY.md` — controles técnicos, incidente e LGPD (referência)

## Próximo passo sugerido

1. Validar o inventário com o encarregado/legal.
2. Definir base legal por atividade e gerar o ROPA (checkpoint humano).
3. Publicar política de privacidade versionada e canal do titular.
4. Formalizar DPAs e transferências internacionais (Res. CD/ANPD nº 19/2024).

## Atualização 2026-11-06 — controles técnicos validados no go-live

- **DSAR/portabilidade**: `GET /tenants/me/export` (sem credenciais) e
  `DELETE /tenants/me` (ADMIN, dupla confirmação) validados ao vivo (26/26).
- **Isolamento multi-tenant**: 14/14 (IDOR/BOLA) e sonda de segurança 18/18.
- **Retenção/expurgo**: `PII_PURGE_CRON` + `PII_RETENTION_DAYS`, retenção de
  auditoria/backups e purga física do tenant (soft delete 30d) implementados.
- **Cifra**: AES-256-GCM de tokens/segredos; segredos nunca saem no export.
- **Incidentes**: runbook + registro inicializado em `.lgpd/incidents/log.md`
  (retenção 5 anos — Res. 15/2024, Art. 10); tabletop ainda pendente.
- **Detecção**: monitor de uptime, auditoria administrativa, alertas de novo
  dispositivo, CodeQL/semgrep/gitleaks/OSV/trivy/ZAP e GitHub security alerts.
- **Checkpoints legais pendentes** (exigem encarregado/advogado): DPO (Art. 41),
  política de privacidade (Art. 9), ROPA final (Art. 37), base legal aprovada
  (Art. 7/11), DPAs/transferências (Arts. 33–39) e RIPD se aplicável (Art. 38).
