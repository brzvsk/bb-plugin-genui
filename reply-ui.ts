// How much inline UI a session is told to write, behind the one `replyUi`
// setting. The modes share the same language and components; they differ in
// when a block is allowed:
// - Prefer visuals: today's behavior, byte for byte. UI replaces a table, a
//   pasted output or a flow and is the expected answer wherever it fits.
// - When it helps: a block must replace something worse in the same reply.
//   Prose is the default, and at most one block is allowed.
// Settings reads follow web/lookups.ts: a cached value for the synchronous
// configure callback, refreshed in the background and on change. A changed
// setting reaches sessions started afterwards, never a running one.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  AGENT_INSTRUCTIONS,
  AGENT_INSTRUCTIONS_BALANCED,
  AGENT_INSTRUCTIONS_BALANCED_WEB_OFF,
  AGENT_INSTRUCTIONS_WEB_OFF,
  CODE_WORK_INSTRUCTIONS,
  CODE_WORK_INSTRUCTIONS_BALANCED,
} from "./instructions";

export const REPLY_UI_MODES = ["Prefer visuals", "When it helps"] as const;
export type ReplyUiMode = (typeof REPLY_UI_MODES)[number];

/** The default keeps existing sessions on exactly today's injection. */
export const DEFAULT_REPLY_UI: ReplyUiMode = "Prefer visuals";

export const REPLY_UI_SETTINGS = {
  replyUi: {
    type: "select" as const,
    label: "UI in replies",
    description:
      "How agents use inline UI in their replies. Prefer visuals: UI replaces tables, pasted output, flows and series wherever it fits (the default). When it helps: one block only where it replaces something worse, and prose otherwise. Applies to sessions started after the change.",
    options: [...REPLY_UI_MODES] as string[],
    default: DEFAULT_REPLY_UI,
  },
} as const;

/** One session's injected UI sections and the tools that carry them. */
export interface ReplyUiConfiguration {
  readonly instructions: string;
  /** The code-work contribution, or null when this mode has no such section. */
  readonly codeWork: string | null;
  readonly tools: string[];
}

const UI_TOOLS = ["check_ui", "ui_examples"];

/**
 * Resolve one mode into the exact sections BB receives. Unknown values (an old
 * stored option, a hand-edited value) fall back to the default rather than
 * leaving a session without UI rules.
 */
export function replyUiConfiguration(mode: string, webOn: boolean): ReplyUiConfiguration {
  if (mode === "When it helps") {
    return {
      instructions: webOn ? AGENT_INSTRUCTIONS_BALANCED : AGENT_INSTRUCTIONS_BALANCED_WEB_OFF,
      codeWork: CODE_WORK_INSTRUCTIONS_BALANCED,
      tools: [...UI_TOOLS],
    };
  }
  return {
    instructions: webOn ? AGENT_INSTRUCTIONS : AGENT_INSTRUCTIONS_WEB_OFF,
    codeWork: CODE_WORK_INSTRUCTIONS,
    tools: [...UI_TOOLS],
  };
}

export interface ReplyUiSetting {
  /** The setting as last read, for the synchronous agent-configuration callback. */
  current(): string;
}

/** Declare the setting and keep its value readable without await. */
export function createReplyUiSetting(bb: BbPluginApi): ReplyUiSetting {
  const settings = bb.settings.define(REPLY_UI_SETTINGS);
  let current: string = DEFAULT_REPLY_UI;
  const remember = (value: unknown) => {
    if (typeof value === "string") current = value;
  };
  void settings.get().then((values) => remember(values.replyUi));
  settings.onChange((next) => remember(next.replyUi));
  return { current: () => current };
}
