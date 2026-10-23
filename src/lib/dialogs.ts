// Native Yes/No and message boxes. window.confirm/alert are not shown by the macOS webview,
// so a "confirm" there silently returns without asking; these work on Windows and Mac.
import { ask, message } from '@tauri-apps/plugin-dialog';

export async function askYesNo(text: string, okLabel = 'Yes'): Promise<boolean> {
  try {
    return await ask(text, { title: 'SRJ Billing', kind: 'warning', okLabel, cancelLabel: 'No' });
  } catch {
    return window.confirm(text);
  }
}

export async function showError(text: string): Promise<void> {
  try {
    await message(text, { title: 'SRJ Billing', kind: 'error' });
  } catch {
    window.alert(text);
  }
}
