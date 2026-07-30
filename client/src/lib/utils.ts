import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Copy text to the clipboard.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost). The app is
 * served over plain http on the internal Windows box, so it is undefined there — fall back
 * to the deprecated execCommand path rather than throwing on click.
 *
 * ponytail: drop the fallback once the deployment is on HTTPS.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or blocked — fall through to the textarea path.
    }
  }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}
