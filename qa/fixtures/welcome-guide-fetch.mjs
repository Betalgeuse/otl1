globalThis.fetch = async (url) => {
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith("conversations.history")) throw new Error("unexpected endpoint");
  return Response.json({
    ok: true,
    messages: [{
      ts: "123.456",
      user: "UADMIN",
      text: "v0.0.55 안내 <#CDAILY> <!channel>",
      files: [{ id: "FLOGO1" }, { id: "FDAILY2" }],
      edited: { ts: "123.789" },
    }],
  });
};
