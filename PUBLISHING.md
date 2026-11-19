# Releasing this repository

This package is published at
<https://github.com/ZJ929-max/tokeneconomizer-dsh>. This file records how a release is cut
and how the repository was first published.

## Cutting a release

1. Bump `version` in `package.json` when behaviour changes.
2. Run the checks:

   ```sh
   node test/smoke.mjs
   ```

   Expect `19 checks passed`. Add a case for any rule you change — those checks are the only
   thing standing between a threshold change and a silently wrong fact.

3. Commit with the disclosure trailer:

   ```sh
   git commit -m "What changed" -m "Assisted-by: <agent or model>"
   ```

4. Push:

   ```sh
   git push
   ```

5. Confirm GitHub still shows **MPL-2.0**, and that every source file still carries the
   Exhibit A notice. If the licence disappears from the sidebar, the `LICENSE` text was
   edited — restore it exactly.

## How this repository is installed

There is no npm publish step. DSH installs bundles from a directory:

```text
plugin_manager { action: "install_bundle", target: "<absolute path to a clone>" }
```

So the install instructions are: clone the repository, then add that directory through
**Plugins > Add plugin**. `install_bundle` also accepts a package spec if this is ever
published to npm.

## How it was first published

For the record, in case access has to be rebuilt:

- The repository was created through the GitHub web UI with no README, `.gitignore`, or
  licence (the repository supplies its own).
- It was pushed over SSH with a dedicated ed25519 key titled
  `tokeneconomizer-dsh 发布 … （2）`, using a forced update to replace the single
  web-created bootstrap commit with the real history.
- The first commit is authored by `zij109 <zij109@outlook.com>` and carries
  `Assisted-by: DeepSeek Harness (deepseek-flash)`.

If you no longer need the key, remove it at <https://github.com/settings/keys>; nothing
here depends on it staying.
