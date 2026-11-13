
export const REPLY_STYLES = ['concise', 'normal', 'detailed'] as const;
export type ReplyStyle = (typeof REPLY_STYLES)[number];
export const CONTEXT_SIZES = ['short', 'standard', 'long'] as const;
export type ContextSize = (typeof CONTEXT_SIZES)[number];
export const DEFAULT_REPLY_STYLE: ReplyStyle = 'concise';
export const DEFAULT_CONTEXT_SIZE: ContextSize = 'short';

export const LIMITS = {
  messageChars: 6000,
  taskIntentTotalChars: 12000,
  attachments: 32,
  imageBytes: 4 * 1024 * 1024,
  imageTotalBytes: 8 * 1024 * 1024,
  commandBodyBytes: 12 * 1024 * 1024,
  attachmentTotalChars: 120000,
  attachmentChars: 15000,
  attachmentNameChars: 120,
  memoryChars: 500,
  memoriesPerBot: 50,
  memoryTotalChars: 4000,
  botInstructionsChars: 1000,
  versionTitleChars: 200,
  versionBodyChars: 50000,
  bots: 20,
  requestBodyBytes: 256 * 1024,
} as const;
