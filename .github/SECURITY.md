# Política de segurança

## Como reportar uma vulnerabilidade

**Não abra issue pública para vulnerabilidades.** Use o canal privado do GitHub:

1. Acesse <https://github.com/xploryngDAO/IntegrAI/security/advisories/new> (Private vulnerability reporting está habilitado), ou
2. Se preferir e-mail, escreva para o encarregado de segurança indicado na issue [#3](https://github.com/xploryngDAO/IntegrAI/issues/3) — nunca inclua segredos de produção na mensagem.

Inclua: versão/commit, passo a passo de reprodução, impacto esperado, requisição/resposta relevante
e, se possível, uma prova de conceito mínima. **Não exfiltre dados pessoais** de terceiros; use apenas
contas de teste.

## Prazos de resposta (melhor esforço)

| Etapa | Prazo |
|---|---|
| Confirmação de recebimento | até 2 dias úteis |
| Triagem inicial + severidade (CVSS) | até 5 dias úteis |
| Correção para crítico/alto | priorizada no próximo ciclo de release |
| Crédito público | combinado com quem reportou, após correção |

## Escopo

- Aplicação (SPA + API), autenticação/2FA/SSO, multitenancy, webhooks, uploads, console de plataforma e LGPD.
- Documentação de referência: [`docs/SECURITY.md`](../docs/SECURITY.md), [`docs/PENTEST_BRIEF.md`](../docs/PENTEST_BRIEF.md).
- Automações já executadas: gitleaks, semgrep, CodeQL, `npm audit`/OSV, trivy, ZAP baseline, `security-probe` e `isolation-test`.

## Safe harbor

Pesquisa de segurança de boa-fé, limitada às contas de teste do projeto, não será alvo de ação legal.
Não são permitidos: engenharia social, dano a dados de terceiros, DoS volumétrico ou acesso a
credenciais reais de produção.
