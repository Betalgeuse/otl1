import { mock } from "bun:test";
import { canonicalGuideContent, parseGuideFileIds } from "../../src/community-guide-content.ts";
import { WELCOME_GUIDE_RELEASE } from "../../src/community-guide-release.ts";

mock.module("../../src/store.ts", () => ({
  NeonStore: class {
    async queryJson(_sql, params) {
      const operation = params[0];
      const payload = JSON.parse(params[1]);
      if (operation === "publish") return payload.hash;
      if (operation === "repair_latest") {
        const guide = await canonicalGuideContent(
          WELCOME_GUIDE_RELEASE.body,
          parseGuideFileIds(process.env.COMMUNITY_GUIDE_FILE_IDS),
        );
        return { version: WELCOME_GUIDE_RELEASE.version, ...guide };
      }
      return true;
    }
  },
}));

globalThis.fetch = async (url) => {
  const parsed = new URL(url);
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
  if (
    parsed.pathname.endsWith("canvases.edit") ||
    parsed.pathname.endsWith("chat.update") ||
    parsed.pathname.endsWith("pins.add")
  )
    return Response.json({ ok: true });
  throw new Error("unexpected endpoint");
};
