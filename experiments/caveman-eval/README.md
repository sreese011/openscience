# Caveman Evaluation Rig v0_1

Independent A/B workbench for deciding whether the Caveman response-compression policy belongs in CEO Brain OS.

## Decision boundary

This rig tests **response behavior and economics**. It does not install Caveman into Brain OS, Claude Code, Codex, or any canonical workspace.

The rig has two independent checks:

1. **Contract smoke** — pins the external Caveman repository, verifies the expected skill blob, and runs installer dry-runs for Claude Code and Codex.
2. **Behavior A/B** — runs the same fixed cases through a neutral control agent and a pinned Caveman treatment agent, then scores both with objective checks and a blinded LLM judge.

## Why OpenScience helps

OpenScience already provides the hard runtime pieces:

- headless `run` command
- explicit model and agent selection
- JSON event stream
- provider-reported input, output, reasoning, cache tokens, and cost
- isolated sessions and on-disk provenance
- project-local custom agents
- tools-off `--bare` mode

The experiment adds the pieces OpenScience does not provide by default:

- paired and randomized A/B execution
- fixed Brain OS test corpus
- exact-string preservation checks
- blinded pairwise judging
- pass/fail thresholds
- GitHub Actions scheduling and artifacts

## Safety

- All behavior runs use `--bare`; no shell, file, network, or other agent tools are available.
- GitHub-hosted runners are ephemeral.
- Provider keys are read only from GitHub Actions secrets.
- Outputs and usage records are uploaded as workflow artifacts. Nothing is committed automatically.
- The weekly schedule is inert unless repository variable `CAVEMAN_EVAL_ENABLED` equals `true`.

## Required repository configuration

### Secrets

Add at least the key required by the selected models:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`

### Variables

- `CAVEMAN_EVAL_ENABLED`: `true` to enable the weekly schedule
- `CAVEMAN_EVAL_MODEL`: model under test, format `provider/model`
- `CAVEMAN_JUDGE_MODEL`: preferably a different provider/model
- `CAVEMAN_EVAL_REPEATS`: optional; default `1`

The workflow can also be run manually with model and repeat overrides.

## Local run

From repository root:

```bash
bun install
CAVEMAN_EVAL_MODEL="provider/model" \
CAVEMAN_JUDGE_MODEL="other-provider/model" \
bun experiments/caveman-eval/scripts/run.ts
```

Results land in `experiments/caveman-eval/results/latest/`.

## Measures

For each arm and case:

- provider input/output/reasoning/cache tokens
- provider-reported cost
- wall-clock duration
- required literal preservation
- judge scores for technical correctness, instruction following, safety clarity, and readability
- blinded pairwise preference

## Default promotion gate

Treatment passes only when all are true:

- no lower required-literal pass rate than control
- technical correctness is no more than `0.15` points below control on a 5-point scale
- safety clarity is no more than `0.10` points below control
- output tokens fall by at least `20%`
- total provider cost does not rise by more than `5%`
- blinded judge does not prefer control by more than `10` percentage points

A pass authorizes a larger pilot. It does **not** authorize global Brain OS installation.

## Known limitations

- Model outputs remain probabilistic even with temperature zero.
- An LLM judge can carry provider and style bias. Use a different judge model and increase repeats before making a policy decision.
- This rig measures the Caveman instruction body inside OpenScience. It does not reproduce Claude Code hook injection overhead exactly.
- Installer smoke proves parsing and planned writes, not live compatibility with every installed agent.

## Pinned Caveman source

```text
Repository: JuliusBrussee/caveman
Commit: 0d95a81d35a9f2d123a5e9430d1cfc43d55f1bb0
SKILL.md Git blob: adf8bc553f840d35c837c122c208a2f738a390ec
```
