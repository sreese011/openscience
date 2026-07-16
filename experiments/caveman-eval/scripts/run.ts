import { createHash } from "node:crypto"
import path from "node:path"
import { mkdir, rm } from "node:fs/promises"

const ROOT = path.resolve(import.meta.dir, "../../..")
const EXPERIMENT = path.resolve(import.meta.dir, "..")
const RESULTS = path.join(EXPERIMENT, "results", "latest")
const CONFIG = path.join(EXPERIMENT, ".openscience")

const CONTROL_AGENT = "caveman-eval-control"
const TREATMENT_AGENT = "caveman-eval-treatment"
const JUDGE_AGENT = "caveman-eval-judge"

type TestCase = {
  id: string
  category: string
  prompt: string
  required: string[]
  forbidden: string[]
}

type Usage = {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

type Arm = "control" | "treatment"

type ArmRun = {
  arm: Arm
  text: string
  cost: number
  durationMs: number
  usage: Usage
  requiredPass: boolean
  missing: string[]
  forbiddenPass: boolean
  presentForbidden: string[]
}

type JudgeResult = {
  technical: { A: number; B: number }
  instruction: { A: number; B: number }
  safety: { A: number; B: number }
  readability: { A: number; B: number }
  preference: "A" | "B" | "tie"
  rationale: string
}

type PairResult = {
  caseID: string
  category: string
  repeat: number
  executionOrder: Arm[]
  labelMap: { A: Arm; B: Arm }
  control: ArmRun
  treatment: ArmRun
  judge: JudgeResult
  preferredArm: Arm | "tie"
}

type RawRun = {
  text: string
  cost: number
  durationMs: number
  usage: Usage
}

function env(name: string, fallback?: string) {
  const value = process.env[name]?.trim() || fallback
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function integer(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]
  const value = raw ? Number.parseInt(raw, 10) : fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function deterministicBit(key: string, seed: string) {
  return createHash("sha256").update(`${seed}:${key}`).digest()[0] % 2
}

function containsLiteral(text: string, literal: string) {
  if (literal === literal.toLowerCase()) return text.toLowerCase().includes(literal)
  return text.includes(literal)
}

async function cases() {
  const source = await Bun.file(path.join(EXPERIMENT, "cases.jsonl")).text()
  const parsed = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const value = JSON.parse(line) as TestCase
      if (!value.id || !value.prompt || !Array.isArray(value.required) || !Array.isArray(value.forbidden)) {
        throw new Error(`Invalid case at line ${index + 1}`)
      }
      return value
    })
  const limit = integer("CAVEMAN_EVAL_CASE_LIMIT", parsed.length, 1, parsed.length)
  return parsed.slice(0, limit)
}

function cleanProcessEnv() {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") result[key] = value
  }
  result.OPENSCIENCE_CONFIG_DIR = CONFIG
  result.OPENSCIENCE_DISABLE_BUNDLED_SKILLS = "1"
  result.OPENSCIENCE_DISABLE_CLAUDE_CODE_SKILLS = "1"
  return result
}

async function runOpenScience(input: {
  agent: string
  model: string
  prompt: string
  title: string
  rawPath: string
}) {
  const command = [
    "bun",
    "run",
    "--cwd",
    path.join(ROOT, "backend", "cli"),
    "--conditions=browser",
    "src/index.ts",
    "run",
    input.prompt,
    "--format",
    "json",
    "--bare",
    "--model",
    input.model,
    "--agent",
    input.agent,
    "--title",
    input.title,
  ]

  const variant = process.env.CAVEMAN_EVAL_VARIANT?.trim()
  if (variant) command.push("--variant", variant)

  const started = performance.now()
  const proc = Bun.spawn(command, {
    cwd: ROOT,
    env: cleanProcessEnv(),
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const durationMs = Math.round(performance.now() - started)

  await mkdir(path.dirname(input.rawPath), { recursive: true })
  await Bun.write(input.rawPath, stdout)
  if (stderr.trim()) await Bun.write(`${input.rawPath}.stderr.txt`, stderr)

  if (exitCode !== 0) {
    const decisive = stderr.trim().split(/\r?\n/).slice(-8).join("\n")
    throw new Error(`${input.title} failed with exit ${exitCode}:\n${decisive}`)
  }

  const texts: string[] = []
  const usage: Usage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  let cost = 0

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const event = JSON.parse(line) as unknown
    if (!record(event) || !record(event.part)) continue
    const part = event.part

    if (event.type === "text" && part.type === "text" && typeof part.text === "string") {
      texts.push(part.text)
    }

    if (event.type === "step_finish" && part.type === "step-finish") {
      cost += number(part.cost)
      if (!record(part.tokens)) continue
      usage.input += number(part.tokens.input)
      usage.output += number(part.tokens.output)
      usage.reasoning += number(part.tokens.reasoning)
      if (!record(part.tokens.cache)) continue
      usage.cache.read += number(part.tokens.cache.read)
      usage.cache.write += number(part.tokens.cache.write)
    }
  }

  const text = texts.join("\n").trim()
  if (!text) throw new Error(`${input.title} produced no text output`)

  return { text, cost, durationMs, usage } satisfies RawRun
}

function scoreArm(arm: Arm, run: RawRun, test: TestCase): ArmRun {
  const missing = test.required.filter((literal) => !containsLiteral(run.text, literal))
  const presentForbidden = test.forbidden.filter((literal) => containsLiteral(run.text, literal))
  return {
    arm,
    ...run,
    requiredPass: missing.length === 0,
    missing,
    forbiddenPass: presentForbidden.length === 0,
    presentForbidden,
  }
}

function parseJudge(text: string): JudgeResult {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error(`Judge returned no JSON object: ${text.slice(0, 300)}`)
  const value = JSON.parse(text.slice(start, end + 1)) as JudgeResult
  const dimensions = [value.technical, value.instruction, value.safety, value.readability]
  for (const dimension of dimensions) {
    if (!dimension || !Number.isFinite(dimension.A) || !Number.isFinite(dimension.B)) {
      throw new Error(`Judge returned invalid score object: ${text.slice(0, 500)}`)
    }
    if (dimension.A < 0 || dimension.A > 5 || dimension.B < 0 || dimension.B > 5) {
      throw new Error(`Judge score outside 0-5: ${text.slice(0, 500)}`)
    }
  }
  if (!(["A", "B", "tie"] as const).includes(value.preference)) {
    throw new Error(`Judge returned invalid preference: ${text.slice(0, 500)}`)
  }
  return value
}

function mean(values: number[]) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentDelta(treatment: number, control: number) {
  if (control === 0) return treatment === 0 ? 0 : Number.POSITIVE_INFINITY
  return ((treatment - control) / control) * 100
}

function fixed(value: number, places = 2) {
  if (!Number.isFinite(value)) return "n/a"
  return value.toFixed(places)
}

function metricForArm(pair: PairResult, dimension: keyof Pick<JudgeResult, "technical" | "instruction" | "safety" | "readability">, arm: Arm) {
  const label = pair.labelMap.A === arm ? "A" : "B"
  return pair.judge[dimension][label]
}

function buildSummary(input: {
  pairs: PairResult[]
  model: string
  judgeModel: string
  repeats: number
  seed: string
}) {
  const control = input.pairs.map((pair) => pair.control)
  const treatment = input.pairs.map((pair) => pair.treatment)

  const aggregate = (runs: ArmRun[]) => ({
    requiredPassRate: mean(runs.map((run) => (run.requiredPass ? 1 : 0))),
    forbiddenPassRate: mean(runs.map((run) => (run.forbiddenPass ? 1 : 0))),
    input: mean(runs.map((run) => run.usage.input)),
    output: mean(runs.map((run) => run.usage.output)),
    reasoning: mean(runs.map((run) => run.usage.reasoning)),
    cacheRead: mean(runs.map((run) => run.usage.cache.read)),
    cacheWrite: mean(runs.map((run) => run.usage.cache.write)),
    cost: mean(runs.map((run) => run.cost)),
    durationMs: mean(runs.map((run) => run.durationMs)),
  })

  const controlStats = aggregate(control)
  const treatmentStats = aggregate(treatment)
  const scores = {
    control: {
      technical: mean(input.pairs.map((pair) => metricForArm(pair, "technical", "control"))),
      instruction: mean(input.pairs.map((pair) => metricForArm(pair, "instruction", "control"))),
      safety: mean(input.pairs.map((pair) => metricForArm(pair, "safety", "control"))),
      readability: mean(input.pairs.map((pair) => metricForArm(pair, "readability", "control"))),
    },
    treatment: {
      technical: mean(input.pairs.map((pair) => metricForArm(pair, "technical", "treatment"))),
      instruction: mean(input.pairs.map((pair) => metricForArm(pair, "instruction", "treatment"))),
      safety: mean(input.pairs.map((pair) => metricForArm(pair, "safety", "treatment"))),
      readability: mean(input.pairs.map((pair) => metricForArm(pair, "readability", "treatment"))),
    },
  }

  const preferences = {
    control: input.pairs.filter((pair) => pair.preferredArm === "control").length,
    treatment: input.pairs.filter((pair) => pair.preferredArm === "treatment").length,
    tie: input.pairs.filter((pair) => pair.preferredArm === "tie").length,
  }
  const totalPreferences = input.pairs.length
  const controlAdvantage = ((preferences.control - preferences.treatment) / totalPreferences) * 100
  const outputDelta = percentDelta(treatmentStats.output, controlStats.output)
  const costDelta = percentDelta(treatmentStats.cost, controlStats.cost)

  const gates = {
    requiredPreservation: treatmentStats.requiredPassRate >= controlStats.requiredPassRate,
    technical: scores.treatment.technical >= scores.control.technical - 0.15,
    safety: scores.treatment.safety >= scores.control.safety - 0.1,
    outputReduction: outputDelta <= -20,
    cost: costDelta <= 5,
    preference: controlAdvantage <= 10,
  }
  const passed = Object.values(gates).every(Boolean)
  const judgeIndependent = input.model !== input.judgeModel
  const verdict = passed ? (judgeIndependent ? "PASS" : "PROVISIONAL PASS") : "FAIL"

  const summary = {
    verdict,
    judgeIndependent,
    model: input.model,
    judgeModel: input.judgeModel,
    repeats: input.repeats,
    seed: input.seed,
    cases: input.pairs.length / input.repeats,
    pairs: input.pairs.length,
    control: controlStats,
    treatment: treatmentStats,
    scores,
    preferences,
    deltas: {
      outputPercent: outputDelta,
      costPercent: costDelta,
      controlPreferenceAdvantagePoints: controlAdvantage,
    },
    gates,
  }

  const rows = [
    ["Required literals", fixed(controlStats.requiredPassRate * 100, 1) + "%", fixed(treatmentStats.requiredPassRate * 100, 1) + "%"],
    ["Avg input tokens", fixed(controlStats.input, 0), fixed(treatmentStats.input, 0)],
    ["Avg output tokens", fixed(controlStats.output, 0), fixed(treatmentStats.output, 0)],
    ["Avg reasoning tokens", fixed(controlStats.reasoning, 0), fixed(treatmentStats.reasoning, 0)],
    ["Avg cost", "$" + fixed(controlStats.cost, 4), "$" + fixed(treatmentStats.cost, 4)],
    ["Avg duration", fixed(controlStats.durationMs / 1000, 2) + "s", fixed(treatmentStats.durationMs / 1000, 2) + "s"],
    ["Judge technical", fixed(scores.control.technical), fixed(scores.treatment.technical)],
    ["Judge instruction", fixed(scores.control.instruction), fixed(scores.treatment.instruction)],
    ["Judge safety", fixed(scores.control.safety), fixed(scores.treatment.safety)],
    ["Judge readability", fixed(scores.control.readability), fixed(scores.treatment.readability)],
  ]

  const markdown = `# Caveman Evaluation — ${verdict}\n\n` +
    `- Model: \`${input.model}\`\n` +
    `- Judge: \`${input.judgeModel}\`\n` +
    `- Cases: ${summary.cases}; repeats: ${input.repeats}; paired runs: ${input.pairs.length}\n` +
    `- Judge independence: ${judgeIndependent ? "different model" : "same model — provisional only"}\n\n` +
    `| Measure | Control | Caveman |\n|---|---:|---:|\n` +
    rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} |`).join("\n") +
    `\n\n## Deltas\n\n` +
    `- Output tokens: ${fixed(outputDelta, 1)}%\n` +
    `- Provider cost: ${fixed(costDelta, 1)}%\n` +
    `- Blind preference: control ${preferences.control}, Caveman ${preferences.treatment}, tie ${preferences.tie}\n\n` +
    `## Gates\n\n` +
    Object.entries(gates).map(([name, pass]) => `- ${pass ? "PASS" : "FAIL"}: ${name}`).join("\n") +
    `\n\nA pass authorizes a larger pilot only. It does not authorize global Brain OS installation.\n`

  return { summary, markdown }
}

async function main() {
  const model = env("CAVEMAN_EVAL_MODEL")
  const judgeModel = env("CAVEMAN_JUDGE_MODEL", model)
  const repeats = integer("CAVEMAN_EVAL_REPEATS", 1, 1, 10)
  const seed = process.env.CAVEMAN_EVAL_SEED?.trim() || "2026-07-16"
  const testCases = await cases()

  await rm(RESULTS, { recursive: true, force: true })
  await mkdir(path.join(RESULTS, "raw"), { recursive: true })

  const pairs: PairResult[] = []

  for (const test of testCases) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const order: Arm[] = deterministicBit(`run:${test.id}:${repeat}`, seed)
        ? ["treatment", "control"]
        : ["control", "treatment"]
      const runs = new Map<Arm, ArmRun>()

      for (const arm of order) {
        const agent = arm === "control" ? CONTROL_AGENT : TREATMENT_AGENT
        const raw = await runOpenScience({
          agent,
          model,
          prompt: test.prompt,
          title: `caveman-eval-${test.id}-${repeat}-${arm}`,
          rawPath: path.join(RESULTS, "raw", test.id, String(repeat), `${arm}.jsonl`),
        })
        runs.set(arm, scoreArm(arm, raw, test))
      }

      const control = runs.get("control")
      const treatment = runs.get("treatment")
      if (!control || !treatment) throw new Error(`Missing arm result for ${test.id}`)

      const treatmentIsA = deterministicBit(`judge:${test.id}:${repeat}`, seed) === 1
      const labelMap = treatmentIsA
        ? ({ A: "treatment", B: "control" } as const)
        : ({ A: "control", B: "treatment" } as const)
      const outputA = labelMap.A === "control" ? control.text : treatment.text
      const outputB = labelMap.B === "control" ? control.text : treatment.text
      const judgePrompt = [
        "ORIGINAL TASK",
        test.prompt,
        "",
        "OUTPUT A",
        outputA,
        "",
        "OUTPUT B",
        outputB,
      ].join("\n")

      const judgeRun = await runOpenScience({
        agent: JUDGE_AGENT,
        model: judgeModel,
        prompt: judgePrompt,
        title: `caveman-eval-${test.id}-${repeat}-judge`,
        rawPath: path.join(RESULTS, "raw", test.id, String(repeat), "judge.jsonl"),
      })
      const judge = parseJudge(judgeRun.text)
      const preferredArm = judge.preference === "tie" ? "tie" : labelMap[judge.preference]

      const pair: PairResult = {
        caseID: test.id,
        category: test.category,
        repeat,
        executionOrder: order,
        labelMap,
        control,
        treatment,
        judge,
        preferredArm,
      }
      pairs.push(pair)
      console.log(`${test.id} #${repeat}: control=${control.usage.output} treatment=${treatment.usage.output} preference=${preferredArm}`)
    }
  }

  await Bun.write(path.join(RESULTS, "pairs.jsonl"), pairs.map((pair) => JSON.stringify(pair)).join("\n") + "\n")
  const { summary, markdown } = buildSummary({ pairs, model, judgeModel, repeats, seed })
  await Bun.write(path.join(RESULTS, "summary.json"), JSON.stringify(summary, null, 2) + "\n")
  await Bun.write(path.join(RESULTS, "summary.md"), markdown)
  console.log(`\n${markdown}`)
}

await main()
