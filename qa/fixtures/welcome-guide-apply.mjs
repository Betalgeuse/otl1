import { mock } from "bun:test";

mock.module("../../src/store.ts", () => ({
  NeonStore: class {
    async queryJson(_sql, params) {
      const operation = params[0];
      const payload = JSON.parse(params[1]);
      if (operation === "publish") return payload.hash;
      if (operation === "repair_latest")
        return {
          version: "v0.0.55",
          hash: process.env.COMMUNITY_GUIDE_CONTENT_HASH,
          body: "v0.0.55 안내 <#CDAILY> @channel",
          orderedFileIds: ["FLOGO1", "FDAILY2"],
        };
      return true;
    }
  },
}));

globalThis.fetch = async (url) => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("conversations.history"))
    return Response.json({
      ok: true,
      messages: [
        {
          ts: "123.456",
          user: "UADMIN",
          text: "v0.0.55 안내 <#CDAILY> <!channel>",
          files: [{ id: "FLOGO1" }, { id: "FDAILY2" }],
          edited: { ts: "123.789" },
        },
      ],
    });
  if (parsed.pathname.endsWith("users.info"))
    return Response.json({
      ok: true,
      user: { id: parsed.searchParams.get("user"), is_bot: false, deleted: false },
    });
  if (parsed.pathname.endsWith("chat.postMessage"))
    return Response.json({
      ok: true,
      ts: "456.789",
      message: { user: "UBOTPROFILE", bot_id: "BGUIDE" },
    });
  throw new Error("unexpected endpoint");
};
