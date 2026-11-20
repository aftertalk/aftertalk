import { toast } from 'sonner';

export const copyToClipboard = (text: string, successMessage?: string) => {
  navigator.clipboard.writeText(text);
  toast.success(successMessage ?? 'Copied to clipboard');
};

export const maskText = (text: string) => {
  if (text.length <= 8) return text;
  return text.substring(0, 8) + '•'.repeat(text.length - 12) + text.substring(text.length - 4);
};
