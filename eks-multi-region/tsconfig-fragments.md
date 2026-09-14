# tsconfig / gitignore fragments (documented, NOT generated files)

These are the projen options folded into each `.projenrc.ts` that produce the
generated `tsconfig.json`, `tsconfig.dev.json`, `.gitignore`, and `.yarnrc.yml`.
They live here as documentation because **the real files are projen-generated** in
the scaffolded demo — never hand-author them (gotcha 9). Change them via the
`.projenrc.ts` options below, then `npx projen`.

## TypeScript (both providers, byte-identical)

```ts
typescriptVersion: '~5.6.3',          // pinned (gotcha 2 family — reproducibility)
tsconfig:    { compilerOptions: { isolatedModules: true } },  // gotcha 13
tsconfigDev: { compilerOptions: { isolatedModules: true } },  // gotcha 13
```

projen's `AwsCdkTypeScriptApp` emits `module: NodeNext` / `moduleResolution: nodenext`
into both tsconfigs. The demo's `package.json` has NO `"type": "module"`, so under
NodeNext `.ts` files are treated as CommonJS modules. This means BOTH import styles
resolve:

- extension-less relative imports (what `src/cdk/app.ts` uses, matching five-nines),
- explicit `.js` extension imports (what the vendored M1 construct sources use
  internally, e.g. `export * from './regional-network.js'`).

Both compile cleanly — no edits to the vendored constructs are required.

`tsconfig.dev.json`'s `include` carries `.projenrc.ts` + `projenrc/**/*.ts` so the
projen config and the task/workflow factories are type-checked (gotcha 4). This is
driven by `projenrcTs: true` + `eslintOptions.devdirs` including `'.projenrc.ts'`
and `'projenrc'`.

## ESLint (both providers, byte-identical)

```ts
eslintOptions: {
  dirs: ['src', 'test'],
  devdirs: ['src/cdk', 'test', 'build-tools', '.projenrc.ts', 'projenrc'],
  ignorePatterns: ['*.d.ts', '*.js', 'node_modules/', 'lib/'],
},
```

## Yarn Berry (both providers, byte-identical)

```ts
packageManager: NodePackageManager.YARN_BERRY,
yarnBerryOptions: {
  yarnRcOptions: { nodeLinker: javascript.YarnNodeLinker.NODE_MODULES },  // gotcha 1 — NOT PnP
},
```

Generates `.yarnrc.yml` with `nodeLinker: node-modules`. PnP (the Yarn Berry default)
breaks `cdk synth`; always set NODE_MODULES.

## gitignore (array in `.projenrc.ts`, gotcha 9 / OQ5)

`.agents/` MUST be ignored via the `gitignore: [...]` array — projen owns
`.gitignore`; a hand-written entry is clobbered on regen. Note `.kiro/` is **not**
fully ignored: the dev-loop and planning tooling (`.kiro/steering/git-workflow.md`,
`.kiro/skills/pdd/` on both providers, `.kiro/skills/gl-push/` on GitLab) plus the
`.claude/skills` → `../.kiro/skills` symlink is committed into the demo so it travels
with the repo — only `.kiro/specs/` is ignored (matches five-nines). The GitLab tree adds the
python dirs (lambda / locust):

```ts
gitignore: [
  '.agents/', '.kiro/specs/', 'idea/',
  '.DS_Store', '**/.DS_Store', 'tsconfig.tsbuildinfo',
  'coverage/', 'test-reports/',
  'cdk.out*/', 'dist/', 'assets/', 'tmp/', '/lib/', '*.d.ts', 'node_modules/',
  '__pycache__/', '*.pyc', '.venv/', 'venv/', '*.egg-info/',
],
```
