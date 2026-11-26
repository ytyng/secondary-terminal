---
description: Run a local release of the VSCode Extension
allowed-tools: Bash, Edit, Read
---

# Task

1. If there are uncommitted changes, commit them

2. Update the version
  - Run `npm run update-version`

3. Build
  - Run `npm run rebuild`

4. Commit the version bump
  - Run `git add .`
  - Run `git commit -am "Bump version to <new version>"`

5. Push
  - Run `git push`
