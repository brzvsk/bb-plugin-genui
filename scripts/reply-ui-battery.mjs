// Prompt battery for the replyUi modes (see the packet's battery.md). It runs
// the prompts headlessly through `claude -p` with exactly the text BB injects
// for each mode, counts ```ui/```app blocks, and checks them with the plugin's
// own compiler. Raw replies and the summary stay under $BB_THREAD_STORAGE; the
// prompts live in scripts/reply-ui-battery.prompts.json.
//
//   BB_THREAD_STORAGE=/path node scripts/reply-ui-battery.mjs
//   node scripts/reply-ui-battery.mjs --dry-run
//   node scripts/reply-ui-battery.mjs --modes when-it-helps --models claude-haiku-5-5 --runs 2
//
// Prefer visuals is the baseline: one run per model unless --runs is passed.
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PROMPTS_PATH = join(HERE, "reply-ui-battery.prompts.json");
const MODES = ["Prefer visuals", "When it helps", "Only when asked"];
const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];
const MAX_ATTEMPTS = 3;

function parseArgs(argv) {
  const out = { modes: MODES, models: MODELS, runs: null, concurrency: 6, tag: null, dryRun: false, out: null, ids: null, classes: null, resume: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--modes") out.modes = value().split(",").map((mode) => MODES.find((known) => known.toLowerCase().replaceAll(" ", "-") === mode) ?? mode);
    else if (arg === "--models") out.models = value().split(",");
    else if (arg === "--runs") out.runs = Number(value());
    else if (arg === "--ids") out.ids = new Set(value().split(","));
    else if (arg === "--classes") out.classes = new Set(value().split(","));
    else if (arg === "--concurrency") out.concurrency = Number(value());
    else if (arg === "--tag") out.tag = value();
    else if (arg === "--out") out.out = resolve(value());
    else if (arg === "--help") {
      console.log("Usage: node scripts/reply-ui-battery.mjs [--modes ...] [--models ...] [--runs N] [--concurrency N] [--tag name] [--out dir] [--dry-run]");
      process.exit(0);
    } else throw new Error(`unknown option ${arg}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const storage = process.env.BB_THREAD_STORAGE ?? join(homedir(), ".bb", "thread-storage", "thr_iwj39fvign");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = args.out ?? join(storage, "reply-ui-battery", args.tag ?? stamp);

const prompts = JSON.parse(await readFile(PROMPTS_PATH, "utf8")).prompts.filter(
  (prompt) => (args.ids === null || args.ids.has(prompt.id)) && (args.classes === null || args.classes.has(prompt.class)),
);
const vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const instructions = await vite.ssrLoadModule("/instructions.ts");
const replyUi = await vite.ssrLoadModule("/reply-ui.ts");
const core = await vite.ssrLoadModule("/core/index.ts");
const appLint = await vite.ssrLoadModule("/core/appLint.ts");
await vite.close();

/** The text BB adds for one mode, in BB's order: tool sections, code work, configure. */
function systemPrompt(mode, webOn) {
  const configuration = replyUi.replyUiConfiguration(mode, webOn);
  if (mode === "Only when asked") return configuration.instructions;
  return `${instructions.UI_REFERENCE}\n\n${instructions.UI_REFERENCE_MORE}\n\n${configuration.codeWork}\n\n${configuration.instructions}`;
}

function findFences(text) {
  const lines = text.split("\n");
  const fences = [];
  for (let index = 0; index < lines.length; index++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/.exec(lines[index] ?? "");
    if (open === null) continue;
    const marker = open[1];
    const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    let close = index + 1;
    while (close < lines.length && !closing.test(lines[close] ?? "")) close++;
    fences.push({ language: (open[2] ?? "").toLowerCase(), body: lines.slice(index + 1, close).join("\n") });
    index = close;
  }
  return fences;
}

function hasMarkdownTable(text) {
  const lines = text.split("\n");
  for (let index = 0; index + 1 < lines.length; index++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[index] ?? "")) continue;
    if (/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1] ?? "")) return true;
  }
  return false;
}

function inspect(mode, text) {
  const fences = findFences(text).filter((fence) => fence.language === "ui" || fence.language === "app");
  const blocks = fences.map((fence) => {
    if (fence.language === "app") {
      const result = appLint.checkApp(fence.body);
      return { language: "app", ok: result.ok, report: result.report.slice(0, 2000) };
    }
    const compiled = core.compile(fence.body);
    return {
      language: "ui",
      ok: compiled.program !== null && compiled.diagnostics.length === 0,
      report: core.formatDiagnostics(compiled.diagnostics).slice(0, 2000),
    };
  });
  return { blockCount: blocks.length, blocks, hasTable: hasMarkdownTable(text) };
}

function runClaude(mode, model, prompt, workdir) {
  const webOn = true;
  const system = systemPrompt(mode, webOn);
  const common = ["-p", prompt, "--model", model, "--system-prompt", system, "--no-session-persistence", "--output-format", "json", "--setting-sources", "project"];
  const tools = mode === "Only when asked" ? ["--tools", "Skill", "--allowedTools", "Skill", "--permission-mode", "dontAsk"] : ["--tools", ""];
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("claude", [...common, ...tools], { cwd: workdir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 180_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, error: error.message, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // A provider or auth failure often prints diagnostics instead of JSON.
      }
      const result = typeof parsed?.result === "string" ? parsed.result : "";
      const ok = !timedOut && code === 0 && parsed !== null && parsed.is_error !== true;
      done({
        ok,
        code,
        error: ok ? null : (timedOut ? "claude timed out after 180s" : (parsed?.result ?? stderr.trim() ?? `claude exited ${code}`)).slice(0, 2000),
        result,
        durationMs: Date.now() - started,
        costUsd: parsed?.total_cost_usd ?? null,
        usage: parsed?.usage ?? null,
        model: parsed?.modelUsage ? Object.keys(parsed.modelUsage)[0] ?? model : model,
      });
    });
  });
}

async function attempt(mode, model, prompt, workdir) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const run = await runClaude(mode, model, prompt, workdir);
    if (run.ok) return { ...run, attempt };
    last = { ...run, attempt };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500 * attempt));
  }
  return last;
}

function recordClass(record) {
  return record.class ?? record.promptId?.[0] ?? "?";
}

function rates(records) {
  const summary = [];
  for (const mode of args.modes) {
    for (const model of args.models) {
      for (const kind of ["V", "P", "A"]) {
        const rows = records.filter((record) => record.mode === mode && record.model === model && recordClass(record) === kind);
        if (rows.length === 0) continue;
        const withBlock = rows.filter((row) => row.blockCount > 0).length;
        summary.push({ mode, model, class: kind, replies: rows.length, withBlock, rate: withBlock / rows.length });
      }
      const rows = records.filter((record) => record.mode === mode && record.model === model);
      const blocks = rows.flatMap((row) => row.blocks);
      const multiOk = rows.filter((row) => row.blockCount <= 1).length;
      const vWithout = rows.filter((row) => recordClass(row) === "V" && row.blockCount === 0 && row.hasTable).length;
      summary.push({
        mode,
        model,
        class: "all",
        replies: rows.length,
        withBlock: rows.filter((row) => row.blockCount > 0).length,
        compileOk: blocks.filter((block) => block.ok).length,
        blocks: blocks.length,
        compileRate: blocks.length === 0 ? null : blocks.filter((block) => block.ok).length / blocks.length,
        multiOkRate: rows.length === 0 ? null : multiOk / rows.length,
        vWithoutTable: vWithout,
      });
    }
  }
  return summary;
}

function printSummary(summary) {
  const lines = ["| Mode | Model | Class | Replies | With block | Rate | Compile | ≤1 block | V no block + table |", "|---|---|---|---:|---:|---:|---:|---:|---:|"];
  for (const row of summary) {
    lines.push(
      `| ${row.mode} | ${row.model} | ${row.class} | ${row.replies} | ${row.withBlock} | ${row.rate === undefined ? "" : `${(row.rate * 100).toFixed(1)}%`} | ${
        row.compileRate === null || row.compileRate === undefined ? "" : `${(row.compileRate * 100).toFixed(1)}%`
      } | ${row.multiOkRate == null ? "" : `${(row.multiOkRate * 100).toFixed(1)}%`} | ${row.vWithoutTable ?? ""} |`,
    );
  }
  console.log(lines.join("\n"));
}

if (args.dryRun) {
  for (const mode of args.modes) {
    const system = systemPrompt(mode, true);
    const configuration = replyUi.replyUiConfiguration(mode, true);
    console.log(`${mode}: ${system.length} chars (${Math.round(system.length / 4)} tokens ~), tools=${JSON.stringify(configuration.tools)}, skills=${JSON.stringify(configuration.skills)}, codeWork=${configuration.codeWork ? configuration.codeWork.length : "none"}`);
  }
  console.log(`prompts=${prompts.length} models=${args.models.join(",")} calls=~${prompts.length * args.models.length * (args.runs ?? 2) * args.modes.length}`);
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
const workRoot = join(outDir, "work");
for (const mode of args.modes) {
  for (const model of args.models) {
    const workdir = join(workRoot, `${mode.replaceAll(" ", "-")}-${model}`);
    await mkdir(workdir, { recursive: true });
    if (mode === "Only when asked") {
      const skillDir = join(workdir, ".claude", "skills", "genui");
      await mkdir(dirname(join(skillDir, "SKILL.md")), { recursive: true });
      await cp(join(ROOT, "skills", "genui", "SKILL.md"), join(skillDir, "SKILL.md"));
    }
  }
}

const jobs = [];
for (const mode of args.modes) {
  for (const model of args.models) {
    const runs = args.runs ?? (mode === "Prefer visuals" ? 1 : 2);
    for (const prompt of prompts) {
      for (let run = 1; run <= runs; run++) jobs.push({ mode, model, prompt, run });
    }
  }
}
if (args.resume) {
  const kept = [];
  for (const job of jobs) {
    const file = join(outDir, `${job.mode.replaceAll(" ", "-")}-${job.model}-${job.prompt.id}-r${job.run}.json`);
    try {
      const existing = JSON.parse(await readFile(file, "utf8"));
      if (existing.ok && typeof existing.result === "string") continue;
    } catch {
      // absent or unreadable: rerun it
    }
    kept.push(job);
  }
  console.log(`Resuming: ${kept.length} of ${jobs.length} calls still to run`);
  jobs.length = 0;
  jobs.push(...kept);
}
console.log(`Running ${jobs.length} model calls into ${outDir}`);

const records = [];
let active = 0;
let next = 0;
let finished = 0;
await new Promise((done) => {
  const pump = () => {
    if (next >= jobs.length && active === 0) return done();
    while (active < args.concurrency && next < jobs.length) {
      const job = jobs[next++];
      active++;
      const workdir = join(workRoot, `${job.mode.replaceAll(" ", "-")}-${job.model}`);
      attempt(job.mode, job.model, job.prompt.text, workdir).then(async (run) => {
        const inspected = run.ok ? inspect(job.mode, run.result) : { blockCount: 0, blocks: [], hasTable: false };
        const record = { ...job, class: job.prompt.class, promptId: job.prompt.id, prompt: job.prompt.text, ...run, ...inspected };
        const file = join(outDir, `${job.mode.replaceAll(" ", "-")}-${job.model}-${job.prompt.id}-r${job.run}.json`);
        await writeFile(file, JSON.stringify(record, null, 2));
        records.push(record);
        active--;
        finished++;
        if (finished % 10 === 0 || finished === jobs.length) console.log(`  ${finished}/${jobs.length}`);
        pump();
      });
    }
  };
  pump();
});

const summary = rates(records);
await writeFile(join(outDir, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), args, prompts: prompts.length, summary, records: records.map((record) => ({ ...record, result: undefined, usage: record.usage })) }, null, 2));
printSummary(summary);
console.log(`\nRaw replies and summary.json: ${outDir}`);
