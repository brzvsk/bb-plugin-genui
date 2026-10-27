import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIONS, COMPONENTS } from "./core/catalog";
import { collectLoads, compile, dataKey, evaluate, formatDiagnostics, initialState, type LoadedData } from "./core";
import {
  AGENT_INSTRUCTIONS,
  AGENT_INSTRUCTIONS_BALANCED,
  AGENT_INSTRUCTIONS_BALANCED_WEB_OFF,
  AGENT_INSTRUCTIONS_WEB_OFF,
  CODE_WORK_INSTRUCTIONS,
  CODE_WORK_INSTRUCTIONS_BALANCED,
  ON_REQUEST_INSTRUCTIONS,
  UI_REFERENCE,
  UI_REFERENCE_MORE,
  WEB_LOOKUPS_OFF,
} from "./instructions";

const skill = readFileSync(new URL("./skills/genui/SKILL.md", import.meta.url), "utf8");

describe("agent instructions", () => {
  // BB refuses a tool whose instructions pass 4096 characters (the plugin then
  // fails to load) and truncates the configure and contributed sections there.
  it("fit BB's 4096-character cap per section", () => {
    expect(AGENT_INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
    expect(AGENT_INSTRUCTIONS_WEB_OFF.length).toBeLessThanOrEqual(4096);
    expect(AGENT_INSTRUCTIONS_BALANCED.length).toBeLessThanOrEqual(4096);
    expect(AGENT_INSTRUCTIONS_BALANCED_WEB_OFF.length).toBeLessThanOrEqual(4096);
    expect(CODE_WORK_INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
    expect(CODE_WORK_INSTRUCTIONS_BALANCED.length).toBeLessThanOrEqual(4096);
    expect(UI_REFERENCE.length).toBeLessThanOrEqual(4096);
    expect(UI_REFERENCE_MORE.length).toBeLessThanOrEqual(4096);
    // The on-request stub is the whole plugin text a session pays for before
    // the skill is loaded; ~4 characters per token puts 300 tokens near 1200.
    expect(ON_REQUEST_INSTRUCTIONS.length).toBeLessThanOrEqual(1200);
  });

  // A replace that silently matches nothing would keep teaching Map while lookups are off.
  it("swap the Map example for the off note while web lookups are off", () => {
    expect(AGENT_INSTRUCTIONS_WEB_OFF).toContain(WEB_LOOKUPS_OFF);
    expect(AGENT_INSTRUCTIONS_WEB_OFF).not.toContain("Map(");
    expect(AGENT_INSTRUCTIONS_BALANCED_WEB_OFF).toContain(WEB_LOOKUPS_OFF);
    expect(AGENT_INSTRUCTIONS_BALANCED_WEB_OFF).not.toContain("Map(");
  });

  // The Evidence group's signatures ride on the code-work section, which every session that gets the references also gets.
  it("list every component and action the parser accepts", () => {
    for (const codeWork of [CODE_WORK_INSTRUCTIONS, CODE_WORK_INSTRUCTIONS_BALANCED]) {
      const reference = `${UI_REFERENCE}\n${UI_REFERENCE_MORE}\n${codeWork}`;
      for (const name of [...Object.keys(COMPONENTS), ...Object.keys(ACTIONS)]) {
        expect(reference, name).toContain(`${name}(`);
      }
    }
  });

  // The skill is the only reference an on-request session gets. It is checked
  // in, so this catches a stale copy after an instructions.ts change.
  it("ship the genui skill with the current full instructions and reference", () => {
    expect(skill.startsWith("---\nname: genui\n")).toBe(true);
    for (const section of [UI_REFERENCE, UI_REFERENCE_MORE, CODE_WORK_INSTRUCTIONS, AGENT_INSTRUCTIONS]) {
      expect(skill).toContain(section);
    }
  });

  it("carry examples that compile and render without errors", () => {
    const examples = [...`${AGENT_INSTRUCTIONS}\n${CODE_WORK_INSTRUCTIONS}`.matchAll(/```ui\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    expect(examples.length).toBeGreaterThan(3);
    for (const example of examples) {
      const compiled = compile(example);
      expect(formatDiagnostics(compiled.diagnostics), example).toBe("");
      const program = compiled.program!;
      // Example paths are illustrative: each Load reads as an empty report.
      const data = new Map<string, LoadedData>(collectLoads(program).map((request) => [dataKey(request), { ok: true, value: [] }]));
      const { diagnostics } = evaluate(program, initialState(program, data), data);
      expect(diagnostics, example).toEqual([]);
    }
  });

  it("carry balanced examples that compile and render without errors", () => {
    const examples = [...AGENT_INSTRUCTIONS_BALANCED.matchAll(/```ui\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const compiled = compile(example);
      expect(formatDiagnostics(compiled.diagnostics), example).toBe("");
      const { diagnostics } = evaluate(compiled.program!, initialState(compiled.program!, new Map()), new Map());
      expect(diagnostics, example).toEqual([]);
    }
  });
});
