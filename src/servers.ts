import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Config, Context, Effect, FileSystem, Layer, Option, Path } from 'effect';

import { type LaunchSpec, fileUri } from './lsp.js';
import { Repo } from './repo.js';

const require = createRequire(import.meta.url);

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const bundled = (pkg: string, bin: string) => require.resolve(`${pkg}/${bin}`);

const UNTRUNCATED_HOVER_LENGTH = 1_000_000;

const JS_LANGUAGES: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
};

const OTHER_LANGUAGES: Readonly<Record<string, string>> = { '.rs': 'rust', '.go': 'go' };

const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  '.eslintrc',
];

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];

const eslintSettings = (root: string, flat: boolean) => ({
  validate: 'on',
  run: 'onType',
  useESLintClass: false,
  useFlatConfig: flat,
  experimental: { useFlatConfig: flat },
  nodePath: null,
  options: {},
  quiet: false,
  format: false,
  onIgnoredFiles: 'off',
  rulesCustomizations: [],
  problems: { shortenToSingleLine: false },
  workingDirectory: { mode: 'location' },
  workspaceFolder: { uri: fileUri(root), name: root },
  codeActionOnSave: { enable: false, mode: 'all' },
  codeAction: {
    disableRuleComment: { enable: false, location: 'separateLine' },
    showDocumentation: { enable: false },
  },
});

export class LanguageServerCatalog extends Context.Service<
  LanguageServerCatalog,
  {
    readonly languageOf: (file: string) => Option.Option<string>;
    readonly serversFor: (file: string) => Effect.Effect<readonly LaunchSpec[]>;
  }
>()('sidediff/LanguageServerCatalog') {
  static readonly layer = Layer.effect(
    LanguageServerCatalog,
    Effect.gen(function* () {
      const repo = yield* Repo;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logDirectory = yield* Effect.orDie(Config.option(Config.String('SIDEDIFF_LSP_LOG')));

      const tsserverLogging = Option.match(logDirectory, {
        onNone: () => ({}),
        onSome: (directory) => ({ logDirectory: directory, logVerbosity: 'verbose' }),
      });

      const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

      const isInsideRepo = (directory: string) => !path.relative(repo.root, directory).startsWith('..');

      const ancestors = (directory: string): readonly string[] => {
        if (!isInsideRepo(directory)) return [];
        if (directory === repo.root) return [directory];

        return [directory, ...ancestors(path.dirname(directory))];
      };

      const nearest = (from: string, candidates: readonly string[]) =>
        Effect.findFirst(
          ancestors(from).flatMap((directory) => candidates.map((candidate) => path.join(directory, candidate))),
          exists,
        );

      const directoryOf = (found: Option.Option<string>, depth: number) =>
        Option.map(found, (file) => path.resolve(file, ...Array.from({ length: depth }, () => '..')));

      const languageOf = (file: string) => {
        const extension = path.extname(file);
        return Option.fromNullishOr(JS_LANGUAGES[extension] ?? OTHER_LANGUAGES[extension]);
      };

      const typescript = Effect.fnUntraced(function* (from: string) {
        const tsserver = yield* nearest(from, ['node_modules/typescript/lib/tsserver.js']);

        return Option.map(tsserver, (tsserverPath): LaunchSpec => ({
          id: 'typescript',
          command: process.execPath,
          args: [bundled('typescript-language-server', 'lib/cli.mjs'), '--stdio'],
          root: path.resolve(tsserverPath, '..', '..', '..', '..'),
          initializationOptions: {
            hostInfo: 'sidediff',
            tsserver: { path: tsserverPath, useSyntaxServer: 'never', ...tsserverLogging },
            plugins: [{ name: '@effect/language-service', location: packageRoot }],
            preferences: { maximumHoverLength: UNTRUNCATED_HOVER_LENGTH },
          },
        }));
      });

      const eslint = Effect.fnUntraced(function* (from: string) {
        const library = directoryOf(yield* nearest(from, ['node_modules/eslint/package.json']), 3);
        const config = yield* nearest(from, ESLINT_CONFIGS);
        if (Option.isNone(library)) return Option.none<LaunchSpec>();
        if (Option.isNone(config)) return Option.none<LaunchSpec>();

        const flat = path.basename(config.value).startsWith('eslint.config.');

        return Option.some<LaunchSpec>({
          id: 'eslint',
          command: process.execPath,
          args: [bundled('vscode-langservers-extracted', 'bin/vscode-eslint-language-server'), '--stdio'],
          root: library.value,
          settings: eslintSettings(library.value, flat),
        });
      });

      const oxlint = Effect.fnUntraced(function* (from: string) {
        const binary = yield* nearest(from, ['node_modules/.bin/oxlint']);

        return Option.map(binary, (command): LaunchSpec => ({
          id: 'oxlint',
          command,
          args: ['--lsp'],
          root: path.resolve(command, '..', '..', '..'),
        }));
      });

      const biome = Effect.fnUntraced(function* (from: string) {
        const binary = yield* nearest(from, ['node_modules/.bin/biome']);
        const config = yield* nearest(from, BIOME_CONFIGS);
        if (Option.isNone(binary)) return Option.none<LaunchSpec>();
        if (Option.isNone(config)) return Option.none<LaunchSpec>();

        return Option.some<LaunchSpec>({
          id: 'biome',
          command: binary.value,
          args: ['lsp-proxy'],
          root: path.dirname(config.value),
        });
      });

      const projectServer = (id: string, command: string, marker: string) =>
        Effect.fnUntraced(function* (from: string) {
          const found = yield* nearest(from, [marker]);
          return Option.map(found, (file): LaunchSpec => ({ id, command, args: [], root: path.dirname(file) }));
        });

      const rust = projectServer('rust-analyzer', 'rust-analyzer', 'Cargo.toml');
      const go = projectServer('gopls', 'gopls', 'go.mod');

      const detectorsFor = (extension: string) => {
        if (JS_LANGUAGES[extension] !== undefined) return [typescript, eslint, oxlint, biome];
        if (extension === '.rs') return [rust];
        if (extension === '.go') return [go];

        return [];
      };

      const serversFor = Effect.fn('LanguageServerCatalog.serversFor')(function* (file: string) {
        const from = path.dirname(file);
        const found = yield* Effect.forEach(detectorsFor(path.extname(file)), (detect) => detect(from), {
          concurrency: 'unbounded',
        });

        return found.flatMap((spec) => Option.toArray(spec));
      });

      return LanguageServerCatalog.of({ languageOf, serversFor });
    }),
  );
}
