import { Zap } from 'lucide-react';
import { Button } from '../ui';

interface MacroDefinition {
  key: string;
  description: string;
  template: string;
}

/**
 * Shopee quick replies. `{{buyer_name}}`, `{{order_sn}}` and
 * `{{tracking_number}}` are resolved from the open ticket before insertion.
 */
export const SHOPEE_MACROS: readonly MacroDefinition[] = [
  {
    key: '/rastreio',
    description: 'Rastreio do pedido',
    template:
      'Olá {{buyer_name}}, seu pedido {{order_sn}} está em trânsito. Rastreio: {{tracking_number}}.',
  },
  {
    key: '/nf',
    description: 'Nota fiscal em anexo',
    template:
      'Olá {{buyer_name}}, a nota fiscal do pedido {{order_sn}} segue em anexo. Qualquer dúvida, estou à disposição.',
  },
  {
    key: '/prazo',
    description: 'Prazo de entrega',
    template:
      'Olá {{buyer_name}}, seu pedido {{order_sn}} está dentro do prazo de entrega. Acompanhe pelo rastreio {{tracking_number}}.',
  },
  {
    key: '/enc',
    description: 'Encerramento do atendimento',
    template:
      'Olá {{buyer_name}}, encerro seu atendimento referente ao pedido {{order_sn}}. Se precisar de algo mais, é só me chamar por aqui.',
  },
];

export interface MacroTemplateValues {
  buyerName: string;
  orderSn: string;
  trackingNumber: string;
}

const PLACEHOLDER_PATTERN = /\{\{(buyer_name|order_sn|tracking_number)\}\}/g;

/** Replaces the macro placeholders; unknown/empty values keep a readable fallback. */
export function fillMacroTemplate(template: string, values: MacroTemplateValues): string {
  const fallback: Record<string, string> = {
    buyer_name: values.buyerName.trim() || 'cliente',
    order_sn: values.orderSn.trim() || 'seu pedido',
    tracking_number: values.trackingNumber.trim() || 'consulte o rastreio no app',
  };
  return template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => fallback[key] ?? '');
}

interface MacroBarProps {
  values: MacroTemplateValues;
  onInsert: (text: string) => void;
  disabled?: boolean;
}

/** Shopee macros on `.sac-macros`: one click inserts the resolved template. */
export function MacroBar({ values, onInsert, disabled }: MacroBarProps): JSX.Element {
  return (
    <div className="sac-macros" role="group" aria-label="Respostas rápidas">
      <span className="sac-label inline-flex items-center gap-1">
        <Zap size={12} aria-hidden="true" />
        Respostas rápidas
      </span>
      {SHOPEE_MACROS.map((macro) => (
        <Button
          key={macro.key}
          variant="ghost"
          size="sm"
          disabled={disabled}
          title={macro.description}
          onClick={() => onInsert(fillMacroTemplate(macro.template, values))}
        >
          {macro.key}
        </Button>
      ))}
    </div>
  );
}
