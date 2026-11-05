import { describe, expect, it } from 'vitest';
import {
  extractOrderId,
  extractOrderIdFromText,
  locateOrderId,
  normalizeBodyText,
  normalizeMessageId,
  splitReferences,
} from '../inbound/EmailThreading';

const ORDER_ID = '123-4567890-1234567';

describe('Amazon order-id extraction', () => {
  it('extracts a valid 3-7-7 order id from free text', () => {
    expect(extractOrderIdFromText(`Seu pedido ${ORDER_ID} foi enviado.`)).toBe(ORDER_ID);
  });

  it('rejects invalid formats (wrong digit groups)', () => {
    expect(extractOrderIdFromText('pedido 12-345678-1234567')).toBeNull();
    expect(extractOrderIdFromText('pedido 123-4567890')).toBeNull();
    expect(extractOrderIdFromText(null)).toBeNull();
  });

  it('prioriza header X-Amazon-Order-Id, depois assunto, depois corpo', () => {
    expect(
      extractOrderId({
        header: ORDER_ID,
        subject: '222-3333333-4444444',
        body: '333-4444444-5555555',
      }),
    ).toBe(ORDER_ID);

    expect(
      locateOrderId({
        header: null,
        subject: `Re: Pedido ${ORDER_ID}`,
        body: 'outro id 999-8888888-7777777',
      }),
    ).toEqual({ orderId: ORDER_ID, source: 'subject' });

    expect(
      locateOrderId({
        header: null,
        subject: 'sem id',
        body: `Mensagem original\n${ORDER_ID}`,
      }),
    ).toEqual({ orderId: ORDER_ID, source: 'body' });
  });

  it('ignora rodapé/quoted history e normaliza espaços', () => {
    const raw = [
      '  Olá,   preciso de ajuda   ',
      '',
      '',
      '------------- Mensagem original -------------',
      'De: Amazon <no-reply@amazon.com.br>',
      'Enviado em: hoje',
    ].join('\n');
    expect(normalizeBodyText(raw)).toBe('Olá, preciso de ajuda');
  });

  it('normaliza Message-ID e References para threading', () => {
    expect(normalizeMessageId('<abc@mail.amazon.com>')).toBe('abc@mail.amazon.com');
    expect(normalizeMessageId('abc@mail.amazon.com')).toBe('abc@mail.amazon.com');
    expect(splitReferences('<a@x> <b@y>')).toEqual(['a@x', 'b@y']);
  });
});
