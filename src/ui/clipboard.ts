export async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('Clipboard write is unavailable in this browser.')
  }
  await navigator.clipboard.writeText(text)
}
