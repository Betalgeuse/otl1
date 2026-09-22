import { z } from "zod";
import { InputError, type Json, object } from "./input";
import type { NeonStore } from "./store";
import { NeonStore as Database } from "./store";
import { StoreError } from "./store-types";

type CapacityStatus = {
  readonly maximum: number;
  readonly used: number;
  readonly joined: number;
  readonly reserved: number;
  readonly remaining: number;
  readonly revision: number;
};

const targetSchema = z.string().regex(/^[UW][A-Z0-9]+$/);
const updateSchema = z
  .object({
    maximum: z.number().int().nonnegative(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .readonly();

function status(value: unknown): CapacityStatus {
  const row = object(value);
  const number = (entry: unknown): number => {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)
      throw new InputError("Invalid referral capacity response");
    return entry;
  };
  return {
    maximum: number(row.maximum),
    used: number(row.used),
    joined: number(row.joined),
    reserved: number(row.reserved),
    remaining: number(row.remaining),
    revision: number(row.revision),
  };
}

export class ReferralCapacityAdminStore {
  constructor(private readonly db: Pick<NeonStore, "queryJson">) {}

  async inspect(teamId: string, adminId: string, userId: string): Promise<CapacityStatus> {
    targetSchema.parse(userId);
    return status(
      await this.db.queryJson("SELECT otl.referral_capacity_admin_execute('status',$1::jsonb)", [
        JSON.stringify({ teamId, adminId, userId }),
      ]),
    );
  }

  async inspectDefault(
    teamId: string,
    adminId: string,
  ): Promise<{ readonly maximum: number; readonly revision: number }> {
    const row = object(
      await this.db.queryJson(
        "SELECT otl.referral_capacity_admin_execute('status_default',$1::jsonb)",
        [JSON.stringify({ teamId, adminId })],
      ),
    );
    if (typeof row.maximum !== "number" || typeof row.revision !== "number")
      throw new InputError("Invalid referral capacity response");
    return { maximum: row.maximum, revision: row.revision };
  }

  async set(input: {
    readonly teamId: string;
    readonly adminId: string;
    readonly userId?: string;
    readonly maximum: number;
    readonly expectedRevision: number;
    readonly key: string;
    readonly now: string;
  }): Promise<CapacityStatus | { readonly maximum: number; readonly revision: number }> {
    updateSchema.parse(input);
    if (input.userId) targetSchema.parse(input.userId);
    let value: Json;
    try {
      value = await this.db.queryJson("SELECT otl.referral_capacity_admin_execute($1,$2::jsonb)", [
        input.userId ? "set_member" : "set_default",
        JSON.stringify(input),
      ]);
    } catch (error) {
      if (error instanceof StoreError && error.code === "unavailable") {
        const latest = input.userId
          ? await this.inspect(input.teamId, input.adminId, input.userId)
          : await this.inspectDefault(input.teamId, input.adminId);
        if (latest.revision !== input.expectedRevision)
          throw new InputError("stale capacity revision");
      }
      throw error;
    }
    if (input.userId) return status(value);
    const row = object(value);
    if (typeof row.maximum !== "number" || typeof row.revision !== "number")
      throw new InputError("Invalid referral capacity response");
    return { maximum: row.maximum, revision: row.revision };
  }
}

export function referralCapacityAdminStore(
  connectionString: string | undefined,
): ReferralCapacityAdminStore {
  if (!connectionString) throw new InputError("Referral admin database unavailable");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch (error) {
    if (error instanceof TypeError) throw new InputError("Referral admin database unavailable");
    throw error;
  }
  if (url.username !== "otl_referral_admin_login")
    throw new InputError("Referral admin database unavailable");
  return new ReferralCapacityAdminStore(new Database(connectionString));
}

type AdminMessage = {
  readonly teamId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly text: string;
  readonly key: string;
  readonly now: string;
};

export async function handleReferralCapacityAdminMessage(
  message: AdminMessage,
  env: {
    readonly SLACK_TEAM_ID: string;
    readonly COMMUNITY_CHANNEL_ID?: string;
    readonly COMMUNITY_PUBLIC_CHANNEL_ID?: string;
    readonly COMMUNITY_ADMIN_ID?: string;
  },
  store: ReferralCapacityAdminStore,
  reply: (text: string) => Promise<void>,
): Promise<boolean> {
  if (!message.text.startsWith("초대 한도 ") && !message.text.startsWith("초대 기본 한도 "))
    return false;
  if (
    !env.COMMUNITY_CHANNEL_ID ||
    env.COMMUNITY_CHANNEL_ID === env.COMMUNITY_PUBLIC_CHANNEL_ID ||
    message.teamId !== env.SLACK_TEAM_ID ||
    message.channelId !== env.COMMUNITY_CHANNEL_ID ||
    message.userId !== env.COMMUNITY_ADMIN_ID
  )
    throw new InputError("운영자 전용 기능입니다.");
  const defaultView = message.text === "초대 한도 보기";
  const memberView = /^초대 한도 <@([UW][A-Z0-9]+)> 보기$/.exec(message.text);
  const memberSet = /^초대 한도 <@([UW][A-Z0-9]+)> (\d{1,9})$/.exec(message.text);
  const defaultSet = /^초대 기본 한도 (\d{1,9})$/.exec(message.text);
  if (defaultView) {
    const global = await store.inspectDefault(message.teamId, message.userId);
    const own = await store.inspect(message.teamId, message.userId, message.userId);
    await reply(
      `전체 기본 초대 한도 ${global.maximum}명 · 내 남은 소개 가능 인원 ${own.remaining}명`,
    );
    return true;
  }
  const target = memberView?.[1] ?? memberSet?.[1];
  if (target && !memberSet) {
    const result = await store.inspect(message.teamId, message.userId, target);
    await reply(
      `초대 한도 · <@${target}> · 최대 ${result.maximum}명 · 가입 ${result.joined}명 · 승인 대기 ${result.reserved}명 · 남음 ${result.remaining}명`,
    );
    return true;
  }
  if (!memberSet && !defaultSet) throw new InputError("초대 한도 명령 형식이 올바르지 않습니다.");
  const maximum = Number(memberSet?.[2] ?? defaultSet?.[1]);
  const current = target
    ? await store.inspect(message.teamId, message.userId, target)
    : await store.inspectDefault(message.teamId, message.userId);
  try {
    const result = await store.set({
      teamId: message.teamId,
      adminId: message.userId,
      ...(target ? { userId: target } : {}),
      maximum,
      expectedRevision: current.revision,
      key: `slack:${message.key}`,
      now: message.now,
    });
    await reply(`초대 한도를 ${result.maximum}명으로 기록했습니다.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("stale capacity revision")) {
      await reply("초대 한도가 동시에 변경됐습니다. 다시 확인한 뒤 명령을 보내 주세요.");
      return true;
    }
    throw error;
  }
  return true;
}
