export type IncomingMessageInput = {
  readonly date: string;
  readonly thread: string;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly editTs: string | null;
};

export type BugIntakeRecord = {
  readonly messageType: "bug_intake";
  readonly contentDigest: string;
};

type IncomingMessageBody =
  | IncomingMessageInput
  | (Pick<IncomingMessageInput, "date" | "thread" | "editTs"> & BugIntakeRecord);

export function incomingMessageBody(
  input: IncomingMessageInput,
  bugIntake: BugIntakeRecord | null = null,
): IncomingMessageBody {
  if (bugIntake)
    return {
      date: input.date,
      thread: input.thread,
      editTs: input.editTs,
      messageType: bugIntake.messageType,
      contentDigest: bugIntake.contentDigest,
    };
  return {
    date: input.date,
    thread: input.thread,
    rawText: input.rawText,
    normalizedText: input.normalizedText,
    editTs: input.editTs,
  };
}
