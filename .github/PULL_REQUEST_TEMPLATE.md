## Resumo

<!-- O que muda e por quê (1-3 linhas). -->

## Tipo

- [ ] Correção de bug
- [ ] Nova funcionalidade
- [ ] Segurança/privacidade
- [ ] Performance/acessibilidade
- [ ] Documentação/infra

## Verificação

- [ ] `npm test` (vitest) verde
- [ ] `npm run build:shared && npm run build:server` e build web verdes
- [ ] Testei o fluxo na UI (quando aplicável)
- [ ] `a11y-audit` (light/dark) sem violações quando altera UI
- [ ] Sem segredos/PII no diff e logs

## Impacto

- Multi-tenant/LGPD: <!-- como o isolamento e a privacidade são preservados -->
- Migração/dados: <!-- schema, backfill, rollback -->
- Deploy: <!-- env nova, runtime-config, imagem, nada além do push -->

## Evidências

<!-- x-request-id, screenshots, saída de testes, link de run do CI. -->

Closes #
