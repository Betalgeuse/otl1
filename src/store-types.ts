import type { Palette, Snapshot } from "./board";

export type StoreCommand = {
  readonly teamId: string;
  readonly userId: string;
  readonly today: string;
  readonly action: "get" | "write" | "complete" | "reopen" | "palette";
  readonly date: string;
  readonly text: string;
  readonly palette: Palette;
  readonly eventTime: number;
};

export interface Store {
  execute(input: StoreCommand): Promise<Snapshot>;
}

export class StoreError extends Error {
  constructor(readonly code: "configuration" | "unavailable" | "response" | "access") {
    super(`Database ${code}`);
    this.name = "StoreError";
  }
}
