> pi can help you create pi packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Pi Packages

Pi packages bundle extensions, skills, prompt templates, and themes from already-present local paths. A package can declare resources in `package.json` under the `pi` key, or use conventional directories.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a Pi Package](#creating-a-pi-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Pi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
pi install /absolute/path/to/package
pi install ./relative/path/to/package
pi remove ./relative/path/to/package
pi list                     # show configured package paths
pi update --models          # refresh model catalogs
```

By default, `install` and `remove` write to global settings (`~/.pi/agent/settings.json`). Use `-l` to write to project settings (`.pi/settings.json`) instead. Project settings can be shared with your team. Missing configured packages are never installed automatically.

The package commands manage local resources, not the pi CLI installation. Remote package updates and self-update do not exist. `pi update --models` is a separate, explicit provider-catalog refresh operation. To uninstall pi itself, see [Quickstart](quickstart.md#uninstall).

To try a package without adding it to settings, use `--extension` or `-e` with an already-present local path:

```bash
pi -e ./local-package
```

## Package Sources

Pi accepts local paths in settings and `pi install`. Registry, Git, and URL sources are disabled: pi does not fetch, clone, hydrate, or install remote package code. Existing legacy entries are inert and can be removed with `pi remove`.

### Legacy Remote Sources

```
npm:@scope/pkg@1.2.3
npm:pkg
git:github.com/example/package
https://github.com/example/package
```

Registry and Git sources are retained only for recognizing and removing old settings entries. New package sources must be local paths.

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, pi loads resources using package rules.

## Creating a Pi Package

Add a `pi` manifest to `package.json` or use conventional directories. Include the `pi-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`. Positive manifest globs discover visible paths in lexical order. List dot-prefixed paths directly. If a glob would need to continue through a symlink, list the symlinked resource root directly.

### Gallery Metadata

The [package gallery](https://pi.dev/packages) displays packages tagged with `pi-package`. Add `video` or `image` fields to show a preview:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no `pi` manifest is present, pi auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Pi never resolves, fetches, or installs package dependencies at runtime. A package may declare runtime dependencies in `package.json` for its own build process, but a package loaded by pi must already vendor or bundle every module it needs.

Pi bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.

Other pi packages must be bundled with the package, then referenced through vendored `node_modules/` paths. Pi loads packages with separate module roots, so separate packages do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "pi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "./packages/simple-pkg",
    {
      "source": "./packages/my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `pi config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. `pi config` starts in global settings (`~/.pi/agent/settings.json`); press Tab to switch between global and project-local modes. Use `pi config -l` to start in project overrides (`.pi/settings.json`) with inherited global resources dimmed.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins unless the project entry has `autoload: false`, in which case it is applied as a delta over the global entry. Identity is determined by:

- legacy npm: package name (only for identifying and removing old settings entries)
- local: resolved absolute path
