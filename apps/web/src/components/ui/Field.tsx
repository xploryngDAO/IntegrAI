import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import {
  SearchField as CvSearch,
  Select as CvSelect,
  Switch as CvSwitch,
  TextArea as CvTextArea,
  TextField as CvTextField,
} from '@xploryng/convergencia';

export interface FieldMeta {
  label: string;
  hint?: string;
  error?: string;
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, FieldMeta {}

/** Convergência text field: persistent label, hint and recovery-oriented error. */
export function Input({ label, hint, error, ...props }: InputProps) {
  return <CvTextField label={label} hint={hint} error={error} {...props} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldMeta {
  autoGrow?: boolean;
}

export function Textarea({ label, hint, error, autoGrow: _autoGrow, ...props }: TextareaProps) {
  return <CvTextArea label={label} hint={hint} error={error} {...props} />;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldMeta {
  options: SelectOption[];
}

export function Select({ label, hint, error, options, ...props }: SelectProps) {
  return <CvSelect label={label} hint={hint} error={error} options={options} {...props} />;
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <CvSwitch
      label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

export function SearchField({
  label = 'Buscar',
  value,
  onChange,
  placeholder,
  className,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <CvSearch
        label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>;
}
