import type { Palette } from "./board";
import { color, DEFAULT_PALETTE, InputError, type Json, object, string } from "./input";

const ROLES = ["empty", "written", "complete"] as const;
const LABELS = { empty: "미작성", written: "작성", complete: "완료" } as const;
const CHOICES = [
  ["회색", "#EBEDF0"],
  ["연두색", "#9BE9A8"],
  ["초록색", "#216E39"],
  ["하늘색", "#A5D8FF"],
  ["파란색", "#1971C2"],
  ["보라색", "#845EF7"],
  ["분홍색", "#F783AC"],
  ["주황색", "#FF922B"],
] as const;

function option(hex: string, label = hex): Json {
  return { text: { type: "plain_text", text: label }, value: hex };
}

export type PaletteMetadata = {
  readonly ownerId: string;
  readonly responseUrl: string;
  readonly shared: boolean;
  readonly date: string;
};

export function paletteModal(current: Palette, metadata: PaletteMetadata): Json {
  const blocks: Json[] = [
    {
      type: "section",
      text: {
        type: "plain_text",
        text: "각 상태의 색을 선택하세요. 직접 입력한 색상 코드가 있으면 우선 적용됩니다.",
      },
    },
  ];
  for (const role of ROLES) {
    const choices = CHOICES.map(([label, hex]) => option(hex, `${label} ${hex}`));
    const initial = CHOICES.find(([, hex]) => hex === current[role]);
    if (!initial) choices.push(option(current[role], `현재 색 ${current[role]}`));
    blocks.push({
      type: "input",
      block_id: role,
      label: { type: "plain_text", text: `${LABELS[role]} 색상` },
      element: {
        type: "static_select",
        action_id: "select",
        options: choices,
        initial_option: initial
          ? option(initial[1], `${initial[0]} ${initial[1]}`)
          : option(current[role], `현재 색 ${current[role]}`),
      },
    });
    blocks.push({
      type: "input",
      block_id: `${role}_custom`,
      optional: true,
      label: { type: "plain_text", text: `${LABELS[role]} 직접 지정` },
      element: {
        type: "plain_text_input",
        action_id: "hex",
        max_length: 7,
        placeholder: { type: "plain_text", text: "#12AB34" },
      },
    });
  }
  blocks.push({
    type: "input",
    block_id: "reset",
    optional: true,
    label: { type: "plain_text", text: "기본색" },
    element: {
      type: "checkboxes",
      action_id: "reset",
      options: [option("reset", "모든 색상을 기본색으로 복원")],
    },
  });
  return {
    type: "modal",
    callback_id: "palette",
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: "잔디 색상 설정" },
    submit: { type: "plain_text", text: "저장" },
    close: { type: "plain_text", text: "취소" },
    blocks,
  };
}

export function modalPalette(
  values: unknown,
): Palette | { readonly errors: { readonly [key: string]: string } } {
  const state = object(values);
  const reset = object(object(state.reset).reset).selected_options;
  if (Array.isArray(reset) && reset.some((item: unknown) => object(item).value === "reset"))
    return DEFAULT_PALETTE;
  const errors: Record<string, string> = {};
  const result = { ...DEFAULT_PALETTE };
  for (const role of ROLES) {
    const custom = object(object(state[`${role}_custom`]).hex).value;
    const selected = object(object(object(state[role]).select).selected_option).value;
    try {
      result[role] = color(typeof custom === "string" && custom.trim() ? custom : string(selected));
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      errors[`${role}_custom`] = "#12AB34처럼 여섯 자리 색상 코드를 입력해 주세요.";
    }
  }
  return Object.keys(errors).length ? { errors } : result;
}
