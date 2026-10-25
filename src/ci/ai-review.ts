// The verified AI review pipeline, run by GitHub Actions and bundled into
// .github/liftoff/ai-review.mjs. Coding agents only read files and print
// JSON; this script does everything else, including writing the diff they
// review, so the agents need no shell and never hold a token that can write
// to the pull request.
//
// The reviewed files are in LIFTOFF_REVIEW_TREE (default: the working
// directory). On pull requests that is a separate checkout of the head, so
// the working directory, with the scripts, skills and instructions the agents
// use, stays the base branch's.
//
//   prepare          decide whether to run and how deep; write the diff and prompts
//   verifier-prompt  merge finder candidates; write the verifier prompt
//   publish          vote, plan and post one review
//   eval-prepare     write the diff and finder prompts for an evaluation case
//   eval-score       score one case's review against its known defect
//   eval-report      summarise every case's score
import { GitHubClient } from "../adapters/github.ts";
import { GitHubReviewGateway } from "../adapters/github-review.ts";
import {
  collectCandidates,
  decideReview,
  MAX_ROUNDS,
  type PullRequestForReview,
  publishReview,
  publishStop,
} from "../application/ai-review/review-pull-request.ts";
import { type EvalScore, parseEvalCase, scoreEval } from "../domain/ai-review/evals.ts";
import { parseVerdicts, vote } from "../domain/ai-review/findings.ts";
import {
  FINDER_PASSES,
  finderPrompt,
  type ReviewSource,
  VERIFIER_RUNS,
  verifierPrompt,
} from "../domain/ai-review/prompts.ts";
import { POLICY_PATH } from "../domain/risk-policy/policy.ts";

/** What the pipeline needs from the runner. */
export interface PipelineEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, text: string) => void;
  readonly listFiles: (directory: string) => string[];
  readonly appendFile: (path: string, text: string) => void;
  readonly log: (text: string) => void;
  /** Runs git in the checkout; returns stdout, or undefined when git fails. */
  readonly git: (args: readonly string[]) => Promise<string | undefined>;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Where rendered skills and agents can live, in the order they are looked for. */
const SKILL_PATHS = [".claude/skills", ".agents/skills", ".github/skills"].map(
  (dir) => `${dir}/liftoff-code-review/SKILL.md`,
);
const VERIFIER_PATHS = [
  ".github/agents/liftoff-verifier.agent.md",
  ".claude/agents/liftoff-verifier.md",
  ".codex/agents/liftoff-verifier.toml",
];

interface PullRequestEvent {
  pull_request?: { number: number; head: { repo?: { full_name?: string } | null } };
}

export async function main(
  command: string | undefined,
  context: PipelineEnvironment,
): Promise<number> {
  const { env } = context;
  const output = (name: string, value: string | number | boolean) => {
    if (env.GITHUB_OUTPUT) context.appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  };
  const summary = (text: string) => {
    if (env.GITHUB_STEP_SUMMARY) context.appendFile(env.GITHUB_STEP_SUMMARY, `${text}\n`);
    context.log(`${text}\n`);
  };
  const work = env.LIFTOFF_REVIEW_DIR ?? "ai-review";

  try {
    switch (command) {
      case "prepare":
        return await prepare(context, output, summary, work);
      case "verifier-prompt":
        return await writeVerifierPrompt(context, output, summary, work);
      case "publish":
        return await publish(context, summary, work);
      case "eval-prepare":
        return await evalPrepare(context, output, summary, work);
      case "eval-score":
        return evalScore(context, summary, work);
      case "eval-report":
        return evalReport(context, summary);
      default:
        throw new Error(
          `unknown command "${command ?? ""}"; use prepare, verifier-prompt, publish, eval-prepare, eval-score or eval-report`,
        );
    }
  } catch (error) {
    summary(`## AI review: error\n\n${(error as Error).message}`);
    return 1;
  }
}

function gateway(context: PipelineEnvironment): {
  gateway: GitHubReviewGateway;
  repository: string;
} {
  const { env } = context;
  const repository = env.GITHUB_REPOSITORY;
  if (!repository || !env.GITHUB_TOKEN)
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set");
  const client = new GitHubClient({
    token: env.GITHUB_TOKEN,
    ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
    ...(context.fetch ? { fetch: context.fetch } : {}),
  });
  return { gateway: new GitHubReviewGateway(client, repository), repository };
}

async function fromBase(
  context: PipelineEnvironment,
  baseRef: string,
  paths: readonly string[],
): Promise<string> {
  for (const path of paths) {
    const text = await context.git(["show", `origin/${baseRef}:${path}`]);
    if (text !== undefined) return text;
  }
  throw new Error(`the base branch has none of ${paths.join(", ")}`);
}

const stripFrontmatter = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, "");

/**
 * The verifier agent's instructions from whichever host's copy the base
 * branch has: Markdown with frontmatter, or Codex's TOML, where they are the
 * literal string in developer_instructions.
 */
async function verifierInstructions(
  context: PipelineEnvironment,
  baseRef: string,
): Promise<string> {
  for (const path of VERIFIER_PATHS) {
    const text = await context.git(["show", `origin/${baseRef}:${path}`]);
    if (text === undefined) continue;
    if (!path.endsWith(".toml")) return stripFrontmatter(text);
    const instructions = /^developer_instructions = '''\n([\s\S]*?)'''$/m.exec(text)?.[1];
    if (instructions) return instructions;
  }
  throw new Error(`the base branch has none of ${VERIFIER_PATHS.join(", ")}`);
}

const reviewSource = (context: PipelineEnvironment, work: string): ReviewSource => ({
  diff: `${work}/diff.patch`,
  tree: context.env.LIFTOFF_REVIEW_TREE ?? ".",
});

/**
 * Writes the diff the agents review, trying each range in turn. A later
 * round's range starts at the last reviewed commit, which a force push can
 * remove; the whole change is the fallback.
 */
async function writeDiff(
  context: PipelineEnvironment,
  source: ReviewSource,
  ranges: readonly string[],
): Promise<string> {
  for (const range of ranges) {
    const text = await context.git(["-C", source.tree, "diff", range]);
    if (text !== undefined) {
      context.writeFile(source.diff, text);
      return range;
    }
  }
  throw new Error(`cannot compute the diff ${ranges.join(" or ")} in ${source.tree}`);
}

async function prepare(
  context: PipelineEnvironment,
  output: (name: string, value: string | number | boolean) => void,
  summary: (text: string) => void,
  work: string,
): Promise<number> {
  const { env } = context;
  const skip = (reason: string) => {
    output("run", false);
    output("stop", false);
    output("reason", reason);
    output("passes", "[]");
    summary(`AI review not run: ${reason}.`);
    return 0;
  };
  const event = JSON.parse(context.readFile(env.GITHUB_EVENT_PATH ?? "")) as PullRequestEvent;
  if (!event.pull_request) throw new Error("the event has no pull request");
  if (env.LIFTOFF_AGENT_CONFIGURED !== "true") {
    const secret = env.LIFTOFF_AGENT_SECRET ?? "review agent";
    return skip(`not configured; add a ${secret} repository secret to enable it`);
  }
  if (event.pull_request.head.repo?.full_name !== env.GITHUB_REPOSITORY) {
    return skip("the pull request comes from a fork, where repository secrets are unavailable");
  }

  const { gateway: github } = gateway(context);
  const pr = await github.load(event.pull_request.number);
  const decision = decideReview(pr, await fromBase(context, pr.baseRef, [POLICY_PATH]));
  context.writeFile(
    `${work}/pr.json`,
    JSON.stringify({
      ...pr,
      previous: { ...pr.previous, fingerprints: [...pr.previous.fingerprints] },
    }),
  );
  output("round", decision.round);
  output("tier", decision.classification.tier);
  if (!decision.run) {
    const stop = decision.round === MAX_ROUNDS + 1;
    output("run", false);
    output("stop", stop);
    output("reason", decision.reason);
    output("passes", "[]");
    summary(`AI review not run: ${decision.reason}.`);
    return 0;
  }

  const source = reviewSource(context, work);
  const range = await writeDiff(context, source, [
    ...new Set([decision.range, `origin/${pr.baseRef}...${pr.headSha}`]),
  ]);
  const skill = stripFrontmatter(await fromBase(context, pr.baseRef, SKILL_PATHS));
  const passes = Array.from({ length: decision.passes }, (_, pass) => pass);
  for (const pass of passes) {
    context.writeFile(
      `${work}/finder-${pass}.md`,
      finderPrompt({ ...source, skill, pass, title: pr.title, description: pr.body }),
    );
  }
  output("run", true);
  output("stop", false);
  output("reason", decision.reason);
  output("passes", JSON.stringify(passes));
  output("verifiers", JSON.stringify(Array.from({ length: VERIFIER_RUNS }, (_, run) => run)));
  summary(
    `AI review round ${decision.round}: ${decision.reason}, ${decision.passes} finder passes over \`${range}\`.`,
  );
  return 0;
}

function readOutputs(context: PipelineEnvironment, directory: string, prefix: string): string[] {
  return context
    .listFiles(directory)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => context.readFile(`${directory}/${name}`));
}

async function writeVerifierPrompt(
  context: PipelineEnvironment,
  output: (name: string, value: string | number | boolean) => void,
  summary: (text: string) => void,
  work: string,
): Promise<number> {
  const pr = JSON.parse(context.readFile(`${work}/pr.json`)) as PullRequestForReview;
  const { candidates, failed } = collectCandidates(
    readOutputs(context, `${work}/finders`, "finder-"),
  );
  output("has-candidates", candidates.length > 0);
  if (candidates.length === 0) {
    summary(
      `No candidate findings${failed > 0 ? ` (${failed} finder pass(es) returned no usable result)` : ""}.`,
    );
    return 0;
  }
  const instructions = await verifierInstructions(context, pr.baseRef);
  context.writeFile(
    `${work}/verifier.md`,
    verifierPrompt({ ...reviewSource(context, work), instructions, candidates }),
  );
  summary(`${candidates.length} candidate finding(s) to verify.`);
  return 0;
}

async function publish(
  context: PipelineEnvironment,
  summary: (text: string) => void,
  work: string,
): Promise<number> {
  const raw = JSON.parse(context.readFile(`${work}/pr.json`)) as PullRequestForReview & {
    previous: { fingerprints: string[] };
  };
  const pr: PullRequestForReview = {
    ...raw,
    previous: { ...raw.previous, fingerprints: new Set(raw.previous.fingerprints) },
  };
  const { gateway: github } = gateway(context);
  if (context.env.LIFTOFF_STOP === "true") {
    const plan = await publishStop(github, pr);
    summary(plan.summary);
    return 0;
  }
  const result = await publishReview(github, pr, {
    finderOutputs: readOutputs(context, `${work}/finders`, "finder-"),
    verifierOutputs: readOutputs(context, `${work}/verifiers`, "verifier-"),
  });
  summary(result.plan.summary);
  return 0;
}

const EVAL_RANGE = "HEAD~1..HEAD";

function evalCaseDirectory(context: PipelineEnvironment): string {
  const directory = context.env.LIFTOFF_EVAL_CASE;
  if (!directory) throw new Error("LIFTOFF_EVAL_CASE must name a case directory");
  return directory;
}

/** Writes finder prompts for one evaluation case, whose change is the last commit. */
async function evalPrepare(
  context: PipelineEnvironment,
  output: (name: string, value: string | number | boolean) => void,
  summary: (text: string) => void,
  work: string,
): Promise<number> {
  const directory = evalCaseDirectory(context);
  const evalCase = parseEvalCase(
    context.readFile(`${directory}/case.json`),
    `${directory}/case.json`,
  );
  const baseRef = context.env.LIFTOFF_BASE_REF ?? "develop";
  const source = reviewSource(context, work);
  await writeDiff(context, source, [EVAL_RANGE]);
  const skill = stripFrontmatter(await fromBase(context, baseRef, SKILL_PATHS));
  const passes = Array.from({ length: FINDER_PASSES.standard }, (_, pass) => pass);
  for (const pass of passes) {
    context.writeFile(
      `${work}/finder-${pass}.md`,
      finderPrompt({
        ...source,
        skill,
        pass,
        title: "Evaluation change",
        description: evalCase.description,
      }),
    );
  }
  const pr = { baseRef, headSha: "HEAD", previous: { rounds: 0, fingerprints: [] } };
  context.writeFile(`${work}/pr.json`, JSON.stringify(pr));
  output("passes", JSON.stringify(passes));
  summary(`Evaluating ${directory}: ${evalCase.summary}`);
  return 0;
}

function evalScore(
  context: PipelineEnvironment,
  summary: (text: string) => void,
  work: string,
): number {
  const directory = evalCaseDirectory(context);
  const evalCase = parseEvalCase(
    context.readFile(`${directory}/case.json`),
    `${directory}/case.json`,
  );
  const { candidates } = collectCandidates(readOutputs(context, `${work}/finders`, "finder-"));
  const runs = readOutputs(context, `${work}/verifiers`, "verifier-").flatMap((text) => {
    try {
      return [parseVerdicts(text)];
    } catch {
      return [];
    }
  });
  const score = scoreEval(evalCase, vote(candidates, runs));
  context.writeFile(`${work}/score.json`, JSON.stringify({ case: directory, ...score }));
  summary(describeScore(directory, score));
  return 0;
}

function describeScore(name: string, score: EvalScore): string {
  const caught = score.caught === undefined ? "n/a" : score.caught ? "caught" : "missed";
  return `| ${name} | ${score.kind} | ${caught} | ${score.falsePositives} | ${score.findings} |`;
}

function evalReport(context: PipelineEnvironment, summary: (text: string) => void): number {
  const directory = context.env.LIFTOFF_EVAL_RESULTS ?? "eval-results";
  const scores = context
    .listFiles(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(
      (name) =>
        JSON.parse(context.readFile(`${directory}/${name}`)) as EvalScore & { case: string },
    );
  const expected = Number(context.env.LIFTOFF_EVAL_EXPECTED ?? scores.length);
  const defects = scores.filter((score) => score.caught !== undefined);
  const caught = defects.filter((score) => score.caught).length;
  const falsePositives = scores.reduce((sum, score) => sum + score.falsePositives, 0);
  summary(
    [
      "## Review evals",
      "",
      `Caught ${caught} of ${defects.length} known defects; ${falsePositives} Important false positive(s) across ${scores.length} case(s).`,
      "",
      "| Case | Kind | Defect | False positives | Findings |",
      "| --- | --- | --- | --- | --- |",
      ...scores.map((score) => describeScore(score.case, score)),
    ].join("\n"),
  );
  if (scores.length < expected) {
    summary(
      `${expected - scores.length} case(s) did not produce a score (stale patch or failed run).`,
    );
    return 1;
  }
  return 0;
}
