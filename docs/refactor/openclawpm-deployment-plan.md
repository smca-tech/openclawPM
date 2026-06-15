# openclawPM deployment plan

## Current machine status

As of 2026-06-15, the live `openclaw` command on this machine resolves to the globally installed package under:

- `/home/smca-tech/.nvm/versions/node/v24.14.0/bin/openclaw`
- package root: `/home/smca-tech/.nvm/versions/node/v24.14.0/lib/node_modules/openclaw`
- installed version: `2026.4.5`

The local openclawPM project checkout is:

- `/home/smca-tech/.openclaw/workspace/projects/openclawPM`
- current repo commit: `fdedca895304356acd9862d28d22b9794ea2d3bb`
- local package version: `2026.5.19`

Conclusion: the current machine is **not yet running** the new openclawPM project build.

## Goal

Deploy the openclawPM build in a way that is repeatable on:

- this machine
- another agent/machine called `Capy`

## Deployment strategy

Use a staged approach:

1. build and validate openclawPM from the repo checkout
2. install or link that build so the `openclaw` CLI resolves to the project version
3. restart the running gateway/runtime
4. verify the live process is actually using the new build
5. document exact steps for Capy

## Recommended implementation path

### Option A: global npm/pnpm install from local repo

From the project checkout:

```bash
cd /home/smca-tech/.openclaw/workspace/projects/openclawPM
pnpm install
pnpm build
npm install -g .
```

Pros:

- simple mental model
- resulting `openclaw` command should point at the project build
- easiest to reproduce on Capy

Cons:

- overwrites the currently installed global OpenClaw package
- requires a careful verification and rollback path

### Option B: npm link / symlink style development install

From the project checkout:

```bash
cd /home/smca-tech/.openclaw/workspace/projects/openclawPM
pnpm install
pnpm build
npm link
```

Pros:

- convenient for active development
- fast iteration

Cons:

- more implicit
- easier to forget what the live runtime is actually using
- less ideal if Capy should have a stable install story

### Recommendation

Prefer **Option A** for Capy and likely for this machine too, unless you specifically want a development-linked runtime.

## Pre-deployment checklist

Before switching a machine:

- confirm repo working tree is clean or intentionally committed
- confirm target branch/commit
- confirm `pnpm install` succeeds
- confirm `pnpm build` succeeds
- capture current installed version with:

```bash
node -p "require(require.resolve('openclaw/package.json')).version"
```

- capture current CLI path with:

```bash
which openclaw
readlink -f "$(which openclaw)"
```

## Post-install validation

After install/restart, verify:

### 1. CLI resolution

```bash
which openclaw
readlink -f "$(which openclaw)"
```

### 2. Installed package version

```bash
node -p "require(require.resolve('openclaw/package.json')).version"
```

Expected: should match the project build, not the older global version.

### 3. Gateway/runtime restart

```bash
openclaw gateway restart
```

If that hangs or is unreliable, restart via the machine’s actual service wrapper/process manager.

### 4. Live behavior validation

- confirm the agent comes back up cleanly
- confirm no startup regressions
- confirm memory-related behavior expected from openclawPM is present
- confirm logs are sane

## Rollback plan

If deployment misbehaves:

### If installed from repo with npm install -g .

Reinstall the known-good version/package source.

Possible rollback patterns:

```bash
npm install -g openclaw@<known-good-version>
```

or reinstall from a known-good local checkout/tarball.

### If installed via npm link

```bash
npm unlink -g openclaw
```

then reinstall the stable global package.

## Capy implementation plan

For Capy, use the same flow:

1. install prerequisites
   - Node version compatible with current openclawPM
   - pnpm
   - git
2. clone repo

```bash
git clone git@github.com:smca-tech/openclawPM.git
cd openclawPM
git checkout working
```

3. install and build

```bash
pnpm install
pnpm build
```

4. install globally from repo

```bash
npm install -g .
```

5. point runtime/service at the installed CLI
6. restart gateway/runtime
7. run post-install validation

## Capy-specific notes to capture later

Before actual Capy deployment, document:

- OS / distro
- Node version
- service manager (`systemd`, `pm2`, manual, etc.)
- current OpenClaw install path
- config path
- rollback package/version source

## Next recommended action

On this machine, the next concrete step is:

- run install/build validation in the openclawPM checkout
- then decide whether to do a global repo install or a link-based development install
