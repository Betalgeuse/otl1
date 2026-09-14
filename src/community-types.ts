import type { Json } from "./input";

export type CommunityScope = {
  readonly teamId: string;
  readonly channelId: string;
  readonly userId: string;
};
export type DayScope = CommunityScope & { readonly date: string };
export type Outcome = "pending" | "complete" | "partial" | "not_done";
export type CommunityDay = DayScope & {
  readonly goal: string;
  readonly outcome: Outcome;
  readonly reflection: string;
  readonly resting: boolean;
  readonly revision: number;
};
export type DayChange = DayScope & {
  readonly syncLegacy?: boolean;
  readonly preserveOutcome?: boolean;
  readonly key: string;
  readonly action: "goal" | "complete" | "partial" | "not_done" | "reflection" | "rest" | "undo";
  readonly text?: string;
  readonly outcome?: Outcome;
  readonly expectedRevision?: number;
  readonly undoKey?: string;
};
export type ChangeResult = {
  readonly day: CommunityDay;
  readonly changed: boolean;
  readonly conflict: boolean;
  readonly firstGoal: boolean;
  readonly firstRegistration?: boolean;
  readonly firstReflection: boolean;
  readonly undoKey: string;
};
export type SupportPreferences = CommunityScope & {
  readonly enabled: boolean;
  readonly goalTime: string;
  readonly reviewTime: string;
  readonly timezone: "Asia/Seoul";
};
export type PreferencePatch = {
  readonly enabled?: boolean;
  readonly goalTime?: string;
  readonly reviewTime?: string;
};
export type GroupSchedule = {
  readonly enabled: boolean;
  readonly goalTime: string;
  readonly reviewTime: string;
};
export type CommunityRecord = CommunityScope & {
  readonly key: string;
  readonly kind: string;
  readonly body: Json;
  readonly status: string;
};
export type RecordKey = CommunityScope & { readonly key: string };
export type ReminderJob = RecordKey & { readonly date: string; readonly kind: "goal" | "review" };
