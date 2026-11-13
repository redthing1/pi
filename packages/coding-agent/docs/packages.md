# Local Packages

Pi loads already-present local files and directories. It does not download package code or install dependencies at runtime.

```bash
pi install ./local-package
pi install -l ./project-package
pi remove ./local-package
pi list
pi -e ./local-package
```

`install` records a path in global settings; `-l` uses project settings. It does not copy or modify the package. Relative paths resolve against the settings file containing them. `-e` loads a package for one invocation without changing settings. A missing configured package is an error.

Registry, Git, and URL package sources are disabled. Updating the CLI uses the reviewed source installation workflow described in [Quickstart](quickstart.md). `pi update --models` explicitly refreshes provider model catalogs; it does not acquire package code.

A package can use conventional `extensions`, `skills`, `prompts`, and `themes` directories, or declare resource paths in `package.json`:

```json
{
  "name": "local-package",
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"],
    "themes": ["./resources/themes/*.json"]
  }
}
```

Paths resolve against the package root. Resource arrays support glob patterns and exclusions. List dot-prefixed or symlinked roots directly when glob traversal would miss them.

## Show a changelog

After a package update, Pi can show what changed. On the next fresh launch, Pi reads the package changelog and shows entries newer than the last seen version under "Extension Updates", the same way it shows its own changelog. The first time Pi sees a package, it records the version without showing anything.

This applies to packages that load at least one extension. Packages that only provide skills, prompt templates, or themes do not show a changelog.

By default Pi reads `CHANGELOG.md` from the package root. Point `pi.changelogPath` at another file inside the package, or set it to `""` to disable the changelog:

```json
{
  "name": "my-pi-package",
  "version": "1.2.0",
  "pi": {
    "changelogPath": "./docs/CHANGELOG.md"
  }
}
```

Use version headings in the same format as Pi's changelog, such as `## [1.2.0]` or `## 1.2.0 - 2026-01-01`. Entries are matched against the `version` field in `package.json`, so a git package only shows a changelog when that field increases. The `collapseChangelog` setting condenses the section to one line per package, such as `Updated my-pi-package to v1.2.0.` Unlike Pi's own changelog, `/changelog` does not show package changelogs, so read the package's changelog file or repository for details.

Every runtime dependency must already be bundled or vendored. Pi provides these host modules to extensions:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Declare these modules as peer dependencies and do not bundle duplicate copies. Other modules, including other Pi packages, remain the package author's responsibility. Separate packages load with separate module roots; do not rely on another package's undeclared dependencies.
