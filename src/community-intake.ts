export type IncomingMessageInput = {
  readonly date: string;
  readonly thread: string;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly editTs: string | null;
};

export function incomingMessageBody(input: IncomingMessageInput): IncomingMessageInput {
  return {
    date: input.date,
    thread: input.thread,
    rawText: input.rawText,
    normalizedText: input.normalizedText,
    editTs: input.editTs,
  };
}
