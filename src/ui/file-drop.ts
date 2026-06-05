import { inputTooLargeMessage, maxInputSize } from '../core/constants'

export { inputTooLargeMessage, maxInputSize }
export const inputNotTextMessage =
  'Dropped file does not look like text. Paste license text or drop a text file.'
export const droppedFileEmptyMessage = 'Dropped file is empty.'
export const multipleFilesDroppedMessage = 'Drop one license file at a time.'
export const unableToReadDroppedFileMessage = 'Unable to read the dropped file.'

function hasDraggedFiles(event: DragEvent): boolean {
  const transfer = event.dataTransfer
  return Boolean(
    transfer &&
    (Array.from(transfer.types || []).includes('Files') ||
      (transfer.files && transfer.files.length > 0)),
  )
}

function looksLikeText(text: string): boolean {
  const replacementCharacter = String.fromCharCode(65533)

  let characterCount = 0
  let replacementCount = 0
  for (const character of text) {
    const codeUnit = character.charCodeAt(0)
    if (
      codeUnit < 32 &&
      character !== '\t' &&
      character !== '\n' &&
      character !== '\r' &&
      character !== '\f' &&
      character !== '\v'
    ) {
      return false
    }
    characterCount += 1
    if (character === replacementCharacter) replacementCount += 1
  }
  if (characterCount === 0) return true
  return replacementCount / characterCount <= 0.01
}

function utf16EncodingFromBytes(
  bytes: Uint8Array,
): 'utf-16le' | 'utf-16be' | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'

  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 128)
  if (sampleLength < 4) return undefined

  let evenNulls = 0
  let oddNulls = 0
  const pairs = sampleLength / 2
  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) evenNulls += 1
    if (bytes[index + 1] === 0) oddNulls += 1
  }

  if (oddNulls / pairs > 0.6 && evenNulls / pairs < 0.2) return 'utf-16le'
  if (evenNulls / pairs > 0.6 && oddNulls / pairs < 0.2) return 'utf-16be'
  return undefined
}

function decodeDroppedText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const encoding = utf16EncodingFromBytes(bytes)
  const hasUtf16Bom =
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  const hasUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const offset = encoding && hasUtf16Bom ? 2 : hasUtf8Bom ? 3 : 0

  return new TextDecoder(encoding || 'utf-8').decode(bytes.subarray(offset))
}

export function bindFileDrop(
  target: HTMLElement,
  onText: (text: string) => void,
  onError: (message: string) => void,
  onDropStart?: () => number | undefined,
  isDropCurrent?: (requestId: number) => boolean,
  isTextTooLarge?: (text: string) => boolean,
): () => void {
  const preventFileNavigation = (event: DragEvent): void => {
    if (hasDraggedFiles(event)) event.preventDefault()
  }
  const handleDragOver = (event: DragEvent): void => {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    target.classList.add('border-blue-500', 'bg-blue-50')
  }
  const handleDragLeave = (event: DragEvent): void => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && target.contains(nextTarget)) return
    target.classList.remove('border-blue-500', 'bg-blue-50')
  }
  const handleDrop = async (event: DragEvent): Promise<void> => {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    target.classList.remove('border-blue-500', 'bg-blue-50')
    const files = event.dataTransfer?.files
    if (files && files.length > 1) {
      onDropStart?.()
      onError(multipleFilesDroppedMessage)
      return
    }
    const file = files?.[0]
    if (!file) return
    const requestId = onDropStart?.()
    if (file.size > maxInputSize) {
      onError(inputTooLargeMessage)
      return
    }
    try {
      const text = decodeDroppedText(await file.arrayBuffer())
      if (requestId !== undefined && isDropCurrent && !isDropCurrent(requestId))
        return
      if (!text.trim()) {
        onError(droppedFileEmptyMessage)
        return
      }
      if (!looksLikeText(text)) {
        onError(inputNotTextMessage)
        return
      }
      if (isTextTooLarge?.(text)) {
        onError(inputTooLargeMessage)
        return
      }
      onText(text)
    } catch {
      if (requestId !== undefined && isDropCurrent && !isDropCurrent(requestId))
        return
      onError(unableToReadDroppedFileMessage)
    }
  }

  window.addEventListener('dragover', preventFileNavigation)
  window.addEventListener('drop', preventFileNavigation)
  target.addEventListener('dragover', handleDragOver)
  target.addEventListener('dragleave', handleDragLeave)
  target.addEventListener('drop', handleDrop)

  return () => {
    window.removeEventListener('dragover', preventFileNavigation)
    window.removeEventListener('drop', preventFileNavigation)
    target.removeEventListener('dragover', handleDragOver)
    target.removeEventListener('dragleave', handleDragLeave)
    target.removeEventListener('drop', handleDrop)
  }
}
