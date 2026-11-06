# SMTP transacional — configuração e teste

O mesmo relay `SMTP_*` é usado por dois caminhos:

1. **e-mails de conta** — verificação de cadastro, convite, reset de senha,
   alertas de novo dispositivo/papel e avisos de conta;
2. **mensagens ao comprador na Amazon** (Rota 1) — quando o canal Amazon estiver
   habilitado, a Amazon exige o relay aprovado no Seller Central. Enquanto a
   Amazon não estiver habilitada (hoje `AMAZON_LWA_*` vazio), use o provedor que
   preferir para os e-mails de conta.

## As 5 chaves

| Variável | Exemplo | Observação |
|---|---|---|
| `SMTP_HOST` | `smtp.resend.com` | sem `https://`, sem espaços |
| `SMTP_PORT` | `465` / `587` / `1025` | ver receita do provedor |
| `SMTP_SECURE` | `true` (465) · `false` (587) | 465 = TLS direto; 587 = STARTTLS |
| `SMTP_USER` | `resend`, `apikey`, login… | depende do provedor |
| `SMTP_PASSWORD` | `<API key / SMTP key>` | nunca vai para o Git |
| `SMTP_FROM` | `no-reply@seudominio.com` | remetente **verificado** no provedor |

## Receitas

| Provedor | Host | Porta / secure | Usuário | Senha |
|---|---|---|---|---|
| **Resend** | `smtp.resend.com` | `465` / `true` (ou `587` / `false`) | `resend` | API key |
| **Brevo** | `smtp-relay.brevo.com` | `587` / `false` | login da conta | SMTP key |
| **SendGrid** | `smtp.sendgrid.net` | `587` / `false` | `apikey` | API key |
| **Amazon SES** | `email-smtp.<região>.amazonaws.com` | `587` / `false` | SMTP user (IAM) | SMTP password |
| **Mailpit (local)** | `127.0.0.1` | `1025` / `false` | — | — |

> O `SMTP_FROM` precisa pertencer a um domínio/remetente verificado no provedor.
> Sem SPF/DKIM configurados, os e-mails caem em spam ou são recusados.

## Passo a passo

```bash
# 1. edite o .env (somente as 6 chaves SMTP_*)
# 2. valide conexão + credenciais (não envia nada)
npm run smtp:doctor -- --verify-only

# 3. envie um e-mail de teste para uma caixa real
npm run smtp:doctor -- --to voce@seudominio.com

# 4. reinicie a API para o novo env valer
#    (Ctrl+C no processo e suba de novo)
node --env-file=.env packages/server/dist/index.js

# 5. teste os fluxos reais na SPA publicada
#    /signup (verificação) · /forgot-password (reset) · convite em /admin
```

O `smtp:doctor` mostra o host/porta/usuário efetivos, **mascara a senha**
(apenas o tamanho) e explica o erro em português quando falha.

## Diagnóstico rápido

| Erro | Causa provável | Correção |
|---|---|---|
| `EAUTH` | senha = senha da conta em vez de API/SMTP key | use a chave do provedor; em SendGrid o usuário é `apikey` |
| `ESOCKET` | porta/TLS incompatíveis | 465 → `SMTP_SECURE=true`; 587 → `false` |
| `ETIMEDOUT` / `ECONNREFUSED` | host/porta errados ou saída bloqueada | confira `SMTP_HOST`; teste de outra rede |
| `ENOTFOUND` / `EDNS` | host inválido | remova `https://`, espaços ou barra final |
| `EENVELOPE` | remetente/destinatário não autorizado | verifique `SMTP_FROM` e o domínio no painel |
| verifica OK, mas não chega | spam/SPF/DKIM ou destinatário errado | confira caixa de spam e DNS do domínio |

## Limites dos planos gratuitos (confirme no provedor)

Resend ~100 e-mails/dia · Brevo ~300/dia · SendGrid ~100/dia · Amazon SES
sandbox só para destinatários verificados (peça produção depois). Para um MVP,
qualquer um dos três primeiros resolve cadastro/convite/reset.

## Segurança

- Credenciais só no `.env` (gitignored); nunca commite o arquivo.
- Rotacione a API key ao trocar de provedor e remova a antiga no painel.
- O sistema cifra credenciais de marketplace em repouso; as do SMTP ficam no
  ambiente do processo — restrinja o acesso ao host/arquivo `.env`.

## Situação atual deste ambiente

O `.env` local aponta para o **Mailpit** (`192.168.15.17:1025`): as mensagens
são capturadas em `http://127.0.0.1:8025`, **não** chegam a usuários reais.
Troque as 6 chaves acima quando as credenciais do provedor estiverem em mãos.

## Quando a Amazon for habilitada

O relay do Seller Central passa a ser obrigatório para as mensagens ao
comprador. Nesse momento, avalie separar os dois caminhos (conta × Amazon) —
hoje ambos compartilham `SMTP_*`, o que é adequado ao MVP sem Amazon.
