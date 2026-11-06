# Mapa de dados pessoais — IntegrAI

> Levantamento técnico a partir do schema Prisma, rotas e serviços (v1, 06/11/2026).
> Base para o ROPA (LGPD Art. 37). Não substitui validação jurídica.

## 1. Titulares e categorias

| Titular | Categorias | Origem |
|---|---|---|
| Operadores do cliente (ADMIN/SUPERVISOR/AGENT) | nome, e-mail, senha (bcrypt), papel, status, TOTP secret cifrado, códigos de recuperação (hash), sessões (IP, user-agent), convites | cadastro/convite/SSO |
| Compradores dos marketplaces | nome/username, mensagens, pedidos, endereço/e-mail quando fornecido pelo marketplace, anexos | webhooks/APIs Amazon, Mercado Livre, Shopee |
| Contatos do tenant | e-mail/nome em convites e alertas | operação |

Dados sensíveis (Art. 11): **não há tratamento intencional** de dados sensíveis; anexos e mensagens podem conter conteúdo enviado pelo comprador (minimização e acesso restrito).

## 2. Atividades de tratamento

| # | Atividade | Dados | Finalidade | Base legal (proposta) | Retenção | Destinatários/operadores |
|---|---|---|---|---|---|---|
| A1 | Autenticação e sessão | nome, e-mail, senha, IP, UA, TOTP | acesso seguro | Art. 7, II (execução de contrato) | sessões até expiração/revogação; tokens 1h/30d | infraestrutura própria |
| A2 | SSO corporativo (Entra/Google/Okta) | e-mail, nome, grupos/claims | login federado | contrato + legítimo interesse (Art. 7, II e IX) | conexão até exclusão | IdP do cliente |
| A3 | Atendimento omnichannel | mensagens, pedidos, PII do comprador | prestação do serviço | Art. 7, II | conforme SLA/contrato; tickets e mensagens no tenant | Amazon, Mercado Livre, Shopee |
| A4 | Anexos (S3) | arquivos enviados/recebidos | suporte à conversa | Art. 7, II | junto ao ticket; purga no encerramento do tenant | provedor S3 |
| A5 | Auditoria e segurança | ator, IP, UA, ação, metadados | accountability | Art. 7, II e IX; Art. 46 | 5 anos (Res. CD/ANPD nº 15/2024, Art. 10) | — |
| A6 | Convites e e-mails transacionais | e-mail, nome | gestão de equipe | Art. 7, II | enquanto pendente + histórico | provedor de e-mail |
| A7 | Billing | dados do tenant/plano, IDs externos | cobrança | Art. 7, II e V | obrigação fiscal | gateway de pagamento |
| A8 | Backups | snapshot do workspace | recuperação | Art. 7, II; Art. 46 | `BACKUP_RETENTION_DAYS` (90d padrão) | S3 |
| A9 | Alertas de segurança | e-mail, IP, dispositivo | prevenção a fraude | Art. 7, IX | não persistido além do envio | provedor de e-mail |

## 3. Fluxos e armazenamento

- **PostgreSQL**: tenants, agentes, contas de marketplace (tokens cifrados AES-256-GCM), tickets, mensagens, anexos (metadados), pedidos, eventos de webhook, auditoria, convites, sessões, backups (índice), SSO (client secret cifrado).
- **Redis**: cache, rate limit, refresh sessions, denylist/watermark de tokens, estado OAuth/SSO (sem PII além de IDs).
- **S3**: anexos e backups JSON.
- **Logs**: estruturados, PII redigida (`redactPiiForLogs`), sem tokens/segredos.
- **Transferência internacional**: S3/e-mail/gateway podem processar fora do Brasil — exige avaliação (Res. CD/ANPD nº 19/2024) e DPA.

## 4. Direitos do titular (Art. 18) — cobertura atual

| Direito | Implementação |
|---|---|
| Confirmação/acesso | `GET /auth/me`, área do perfil, export do tenant |
| Correção | `PATCH /auth/me`, gestão de usuários |
| Portabilidade | exportação do workspace (JSON) |
| Eliminação | soft delete + purga física (`TenantPurgeService`, retenção 30d configurável) |
| Informação sobre compartilhamento | docs/DPA a formalizar; operadores listados acima |
| Revogação de consentimento | não aplicável como base principal (contrato) |

## 5. Segurança (Art. 46) — resumo

Cifra de tokens, JWT curto + refresh rotativo, 2FA, RBAC, isolamento multi-tenant testado, rate limits, headers/CSP, auditoria, alertas de novo dispositivo/mudança de conta, retenção e purga. Detalhes em `docs/SECURITY.md`.
