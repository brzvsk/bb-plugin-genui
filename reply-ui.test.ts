import { describe, expect, it } from "vitest";
import {
  AGENT_INSTRUCTIONS,
  AGENT_INSTRUCTIONS_BALANCED,
  AGENT_INSTRUCTIONS_BALANCED_WEB_OFF,
  AGENT_INSTRUCTIONS_WEB_OFF,
  CODE_WORK_INSTRUCTIONS,
  CODE_WORK_INSTRUCTIONS_BALANCED,
  ON_REQUEST_INSTRUCTIONS,
} from "./instructions";
import { DEFAULT_REPLY_UI, REPLY_UI_MODES, REPLY_UI_SETTINGS, replyUiConfiguration } from "./reply-ui";

describe("replyUi setting", () => {
  it("is a select with the three modes and Prefer visuals as the default", () => {
    expect(REPLY_UI_SETTINGS.replyUi.type).toBe("select");
    expect(REPLY_UI_SETTINGS.replyUi.label).toBe("UI in replies");
    expect(REPLY_UI_SETTINGS.replyUi.options).toEqual([...REPLY_UI_MODES]);
    expect(REPLY_UI_SETTINGS.replyUi.default).toBe(DEFAULT_REPLY_UI);
    expect(DEFAULT_REPLY_UI).toBe("Prefer visuals");
  });

  // The default is the compatibility promise: same sections, tools and skills
  // byte for byte as before the setting existed.
  it("keeps today's injection byte-identical in the default mode", () => {
    expect(replyUiConfiguration("Prefer visuals", true)).toEqual({
      instructions: AGENT_INSTRUCTIONS,
      codeWork: CODE_WORK_INSTRUCTIONS,
      tools: ["check_ui", "ui_examples"],
      skills: [],
    });
    expect(replyUiConfiguration("Prefer visuals", false)).toEqual({
      instructions: AGENT_INSTRUCTIONS_WEB_OFF,
      codeWork: CODE_WORK_INSTRUCTIONS,
      tools: ["check_ui", "ui_examples"],
      skills: [],
    });
  });

  it("keeps the references and reduced code-work section in When it helps", () => {
    expect(replyUiConfiguration("When it helps", true)).toEqual({
      instructions: AGENT_INSTRUCTIONS_BALANCED,
      codeWork: CODE_WORK_INSTRUCTIONS_BALANCED,
      tools: ["check_ui", "ui_examples"],
      skills: [],
    });
    expect(replyUiConfiguration("When it helps", false).instructions).toBe(AGENT_INSTRUCTIONS_BALANCED_WEB_OFF);
  });

  // On-request pays only for the stub: the skill carries the reference, so the
  // tools whose instructions carry it stay off until the skill is loaded.
  it("injects only the stub and the genui skill in Only when asked", () => {
    expect(replyUiConfiguration("Only when asked", true)).toEqual({
      instructions: ON_REQUEST_INSTRUCTIONS,
      codeWork: null,
      tools: [],
      skills: ["genui"],
    });
    expect(replyUiConfiguration("Only when asked", false)).toEqual(replyUiConfiguration("Only when asked", true));
  });

  it("falls back to the default for an unknown stored value", () => {
    expect(replyUiConfiguration("something older", true).instructions).toBe(AGENT_INSTRUCTIONS);
  });
});
