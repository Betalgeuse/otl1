import type { Snapshot } from "./board";
import type { Json } from "./input";
import { type Store, type StoreCommand, StoreError } from "./store-types";

export { type Store, type StoreCommand, StoreError } from "./store-types";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown): Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (record(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  throw new StoreError("response");
}

function parseJson(value: string): Json {
  try {
    return jsonValue(JSON.parse(value));
  } catch (error) {
    if (error instanceof SyntaxError) throw new StoreError("response");
    throw error;
  }
}

function snapshot(value: unknown): Snapshot {
  if (
    !record(value) ||
    typeof value.startDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.startDate) ||
    !Array.isArray(value.goals) ||
    !record(value.palette)
  ) {
    throw new StoreError("response");
  }
  const palette = value.palette;
  const empty = palette.empty;
  const written = palette.written;
  const complete = palette.complete;
  if (
    typeof empty !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(empty) ||
    typeof written !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(written) ||
    typeof complete !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(complete)
  ) {
    throw new StoreError("response");
  }
  const goals = value.goals.map((goal: unknown) => {
    if (
      !record(goal) ||
      typeof goal.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(goal.date) ||
      typeof goal.text !== "string" ||
      typeof goal.completed !== "boolean"
    ) {
      throw new StoreError("response");
    }
    return { date: goal.date, text: goal.text, completed: goal.completed };
  });
  return { startDate: value.startDate, goals, palette: { empty, written, complete } };
}

export class NeonStore implements Store {
  private readonly endpoint: string;

  constructor(private readonly connectionString: string) {
    let url: URL;
    try {
      url = new URL(connectionString);
    } catch (error) {
      if (error instanceof TypeError) throw new StoreError("configuration");
      throw error;
    }
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname.endsWith(".neon.tech") ||
      !url.username ||
      !url.password ||
      url.pathname.length < 2 ||
      url.port
    ) {
      throw new StoreError("configuration");
    }
    this.endpoint = `https://${url.hostname}/sql`;
  }

  async execute(input: StoreCommand): Promise<Snapshot> {
    return snapshot(
      await this.queryJson(
        "SELECT otl.execute($1,$2,$3::date,$4,$5::date,$6,$7::jsonb,$8::numeric)",
        [
          input.teamId,
          input.userId,
          input.today,
          input.action,
          input.date,
          input.text,
          JSON.stringify(input.palette),
          String(input.eventTime),
        ],
      ),
    );
  }

  async queryJson(query: string, params: readonly string[], timeoutMs = 10_000): Promise<Json> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": this.connectionString,
        "Neon-Raw-Text-Output": "true",
        "Neon-Array-Mode": "true",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ query, params }),
    });
    const body = parseJson(await response.text());
    if (!response.ok)
      throw new StoreError(record(body) && body.code === "42501" ? "access" : "unavailable");
    if (!record(body) || !Array.isArray(body.rows)) throw new StoreError("response");
    const row: unknown = body.rows[0];
    if (!Array.isArray(row) || typeof row[0] !== "string") throw new StoreError("response");
    return parseJson(row[0]);
  }
}
