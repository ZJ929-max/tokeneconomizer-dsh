# Publishing this repository

The package is ready to publish. What is still missing is yours to decide: the repository
URL and the copyright holder line.

## 1. Fill in the manifest fields

Edit `package.json` and add or replace:

```json
  "author": "YOUR NAME <you@example.com>",
  "repository": { "type": "git", "url": "https://github.com/OWNER/REPO.git" },
  "homepage": "https://github.com/OWNER/REPO#readme",
  "bugs": { "url": "https://github.com/OWNER/REPO/issues" },
```

Also consider the name. `dsh-tokeneconomizer` and the display title `TokenEconomizer` refer
to Microsoft's project. The README, `locale/*.json` and `AI-DISCLOSURE.md` already state that
this is unaffiliated, which is the usual mitigation. If you would rather not raise the
question at all, rename the package (for example `dsh-cost-saver`) and keep the upstream
reference in the prose.

## 2. Create the commit

```sh
git init -b main
git add .
git commit -m "Initial commit: TokenEconomizer mechanisms ported to DeepSeek Harness" \
           -m "Assisted-by: DeepSeek Harness (deepseek-flash)"
```

The `Assisted-by:` trailer is the disclosure convention; `AI-DISCLOSURE.md` carries the
details.

## 3. Create the remote and push

Create an empty repository in the browser — **no** README and **no** licence, both already
exist — then:

```sh
git remote add origin https://github.com/OWNER/REPO.git
git push -u origin main
```

With the GitHub CLI:

```sh
gh auth login
gh repo create OWNER/REPO --public --source . --remote origin --push \
  --description "TokenEconomizer's cost-control mechanisms ported to DeepSeek Harness (AI-generated, MPL-2.0)"
```

## 4. Repository settings worth setting

- **Description**: say "AI-generated" and "port of" in the first sentence, matching the two
  blockquotes at the top of the README.
- **Topics**: `deepseek-harness`, `dsh-plugin`, `token-optimization`, `ai-generated`, `mpl-2.0`.
- **Licence detection**: GitHub should show "MPL-2.0". If it shows "View licence", the file
  text was edited — restore the exact contents.
- Disable **Wikis** and **Projects** if you will not use them.

## 5. How users install it

There is no npm publish step. DSH installs bundles from a directory:

```text
plugin_manager { action: "install_bundle", target: "<absolute path to a clone>" }
```

So the install instructions are: clone the repository, then add that directory through
**Plugins > Add plugin**. `install_bundle` also accepts a package spec if you later publish
to npm.

## 6. Before you push, run the checks

```sh
node test/smoke.mjs
```

Expect `19 checks passed`. The file is plain ESM and needs no dependencies.

Confirm afterwards that GitHub shows MPL-2.0 and that the README's relative links
(`AI-DISCLOSURE.md`, `LICENSE`, `docs/DETAIL.md`) resolve.
