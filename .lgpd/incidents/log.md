# Registro de incidentes de segurança (LGPD Art. 48; Res. CD/ANPD nº 15/2024, Art. 10)

> Retenção mínima: **5 anos** (Res. 15/2024, Art. 10). Cada incidente recebe um ID,
> classificação de risco, decisão de notificação (ANPD em até 3 dias úteis e
> titulares) e evidências. Este arquivo é versionado no Git; não inclua segredos
> nem PII de titulares.

## Estrutura de um registro

```md
### INC-YYYYMMDD-01 — {título}
- **Detectado em**: YYYY-MM-DD HH:MM (America/Sao_Paulo)
- **Origem da detecção**: monitor de uptime / alerta / relato / auditoria
- **Dados afetados**: {categorias, volume aproximado, titulares}
- **Risco**: {baixo/médio/alto} — {justificativa}
- **Notificável à ANPD?**: sim/não — {fundamento, Art. 5 Res. 15/2024}
- **Notificado em**: YYYY-MM-DD (prazo: 3 dias úteis)
- **Titulares notificados**: sim/não/data
- **Contenção e correção**: {ações, commits, issue}
- **Lições aprendidas / follow-up**: {links}
- **Anexos**: links para runs, logs redigidos, issues
```

## Incidentes registrados

_Nenhum incidente de segurança registrado até 2026-11-06._

Controles de detecção ativos: monitor de uptime (issue automática), auditoria de
ações administrativas, alertas de novo dispositivo, `security-probe`/ZAP/semgrep/
CodeQL no CI e alertas de vulnerabilidade do GitHub.
