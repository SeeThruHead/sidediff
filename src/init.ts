import { Config, Console, Effect, FileSystem, Path, Schema } from 'effect';
import { Prompt } from 'effect/cli';
import { fileURLToPath } from 'node:url';

export const agents = [
  { id: 'claude', title: 'Claude Code', home: ['.claude'], skills: ['.claude', 'skills'] },
  { id: 'codex', title: 'Codex', home: ['.codex'], skills: ['.codex', 'skills'] },
  { id: 'opencode', title: 'OpenCode', home: ['.config', 'opencode'], skills: ['.config', 'opencode', 'skills'] },
  { id: 'pi', title: 'Pi', home: ['.pi', 'agent'], skills: ['.pi', 'agent', 'skills'] },
  { id: 'agents', title: 'Shared agents folder', home: ['.agents'], skills: ['.agents', 'skills'] },
] as const;

export type AgentId = (typeof agents)[number]['id'];

export const agentIds = agents.map((agent) => agent.id);

export class SkillMissing extends Schema.TaggedError<SkillMissing>()('SkillMissing', { path: Schema.String }) {
  override get message() {
    return `the packaged skill is missing at ${this.path}; reinstall sidediff`;
  }
}

export class NothingChosen extends Schema.TaggedError<NothingChosen>()('NothingChosen', {}) {
  override get message() {
    return 'no skills folder chosen; pass --agent <name> or --dir <folder>';
  }
}

type Target = { readonly label: string; readonly folder: string };

type Outcome = 'installed' | 'updated' | 'unchanged';

const skillSource = Effect.map(Path.Path, (path) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'sidediff', 'SKILL.md'),
);

const homeDirectory = Effect.orDie(Config.String('HOME'));

const agentTarget = Effect.fnUntraced(function* (id: AgentId) {
  const path = yield* Path.Path;
  const home = yield* homeDirectory;
  const agent = agents.find((candidate) => candidate.id === id) ?? agents[0];

  return { label: agent.title, folder: path.join(home, ...agent.skills) };
});

const installed = Effect.fnUntraced(function* (id: AgentId) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* homeDirectory;
  const agent = agents.find((candidate) => candidate.id === id) ?? agents[0];

  return yield* fs.exists(path.join(home, ...agent.home)).pipe(Effect.orElseSucceed(() => false));
});

const askForAgents = Effect.gen(function* () {
  const path = yield* Path.Path;
  const present = yield* Effect.forEach(agentIds, installed);

  return yield* Prompt.MultiSelect({
    message: 'Install the sidediff skill for which agents? (space to toggle, enter to confirm)',
    choices: agents.map((agent, index) => ({
      title: agent.title,
      value: agent.id,
      description: path.join('~', ...agent.skills),
      selected: present[index] === true,
    })),
    min: 1,
  });
});

const chosenTargets = Effect.fnUntraced(function* (requested: readonly AgentId[], folders: readonly string[]) {
  const path = yield* Path.Path;
  const ids = requested.length === 0 && folders.length === 0 ? yield* askForAgents : requested;
  const fromAgents = yield* Effect.forEach(ids, agentTarget);
  const fromFolders = folders.map((folder): Target => ({ label: folder, folder: path.resolve(folder) }));
  const all = [...fromAgents, ...fromFolders];

  if (all.length === 0) return yield* new NothingChosen();

  return all;
});

const realFolder = (folder: string) =>
  FileSystem.FileSystem.use((fs) => fs.realPath(folder)).pipe(Effect.orElseSucceed(() => folder));

const outcomeOf = (existing: string | undefined, skill: string): Outcome => {
  if (existing === undefined) return 'installed';
  if (existing === skill) return 'unchanged';

  return 'updated';
};

const installInto = Effect.fnUntraced(function* (folder: string, skill: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(folder, 'sidediff');
  const file = path.join(directory, 'SKILL.md');
  const existing = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
  const outcome = outcomeOf(existing, skill);

  if (outcome !== 'unchanged') {
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(file, skill);
  }

  return { file, outcome };
});

const uniqueByFolder = (targets: ReadonlyArray<Target & { readonly real: string }>) =>
  targets.filter((target, index) => targets.findIndex((other) => other.real === target.real) === index);

export const initSkill = Effect.fnUntraced(function* (requested: readonly AgentId[], folders: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* skillSource;
  const skill = yield* fs.readFileString(source).pipe(Effect.mapError(() => new SkillMissing({ path: source })));
  const targets = yield* chosenTargets(requested, folders);
  const resolved = yield* Effect.forEach(targets, (target) =>
    Effect.map(realFolder(target.folder), (real) => ({ ...target, real })),
  );
  const shared = resolved.filter((target) => !uniqueByFolder(resolved).includes(target));

  const results = yield* Effect.forEach(uniqueByFolder(resolved), (target) =>
    Effect.map(installInto(target.real, skill), (result) => ({ ...result, label: target.label })),
  );

  yield* Effect.forEach(results, ({ label, file, outcome }) => Console.log(`${outcome.padEnd(9)}  ${label}  ${file}`), {
    discard: true,
  });
  yield* Effect.forEach(
    shared,
    (target) => Console.log(`${'shared'.padEnd(9)}  ${target.label}  ${target.folder} is the same folder as above`),
    { discard: true },
  );
});
