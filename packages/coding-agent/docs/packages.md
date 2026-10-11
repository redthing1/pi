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

Every runtime dependency must already be bundled or vendored. Pi provides these host modules to extensions:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Declare these modules as peer dependencies and do not bundle duplicate copies. Other modules, including other Pi packages, remain the package author's responsibility. Separate packages load with separate module roots; do not rely on another package's undeclared dependencies.
