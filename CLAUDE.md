# Working in this repo

## Release workflow

Bundle changes. Do not ship one feature per release.

1. Branch off `dev`. Merge every change and fix back into `dev`.
2. Let work collect on `dev`. Never push a feature straight to `main`.
3. Once or twice a week, release the whole collected set as one version.

Why: users must not update the app often. A bundled release also gives a
feature launch more effect than a drip of small ones.

### To cut a release

1. Read the bundle: `git log main..dev --oneline`.
2. Write the `CHANGELOG.md` entry from that list.
3. Bump `version.json` and write its `highlights`. Users read `highlights`
   in the in-app update modal, so write them for a trader, not for a
   developer.
4. Merge `dev` into `main`.

`main` is what `install.sh` and the in-app update check read. The merge to
`main` is the moment every user sees the update.

There is no changeset tool, and the repo does not need one. The bundle list
is `git log main..dev`. `version.json` highlights stay hand-written.
