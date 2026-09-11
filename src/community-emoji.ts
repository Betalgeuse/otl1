import { callSlack } from "./community-social";
import { object } from "./input";

let cached: { token: string; until: number; names: readonly string[] } | undefined;

export async function randomCustomEmoji(token: string, count = 3): Promise<readonly string[]> {
  try {
    if (!cached || cached.token !== token || cached.until < Date.now()) {
      const data = object((await callSlack(token, "emoji.list", {})).emoji);
      const names = Object.entries(data)
        .filter(
          ([name, value]) =>
            /^[^:\s<>]+$/.test(name) && typeof value === "string" && !value.startsWith("alias:"),
        )
        .map(([name]) => name);
      cached = { token, until: Date.now() + 300_000, names };
    }
    const pool = [...cached.names];
    const picked: string[] = [];
    while (pool.length && picked.length < count) {
      const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
      const index = Math.floor((random / 4294967296) * pool.length);
      const name = pool.splice(index, 1)[0];
      if (name) picked.push(name);
    }
    return picked;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "community.emoji.unavailable",
        type: error instanceof Error ? error.name : "Unknown",
      }),
    );
    return [];
  }
}

export async function customBotEmoji(token: string, text: string): Promise<string> {
  const pattern =
    /:(?:seedling|muscle|memo|penguin):|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*/gu;
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return text;
  const names = await randomCustomEmoji(token, matches.length);
  if (!names.length) return text;
  let index = 0;
  return text.replace(pattern, () => `:${names[index++ % names.length]}:`);
}
