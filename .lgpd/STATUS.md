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
