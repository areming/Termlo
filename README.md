# Termlo

[简体中文](README.zh-CN.md) · English

![Termlo logo](assets/termlo.png)

**Termlo makes server management easier.** It combines a familiar SSH/SFTP desktop client with an agent that can inspect hosts, plan work, run commands, and verify results.

Termlo is a local-first desktop app for Windows and macOS. The desktop client uses Electron, xterm.js, and ssh2. It does not require an account for local SSH use. The optional account API is a separate service.

## Download

Get installers from [GitHub Releases](https://github.com/areming/Termlo/releases). Version **1.0.0** targets Windows x64, macOS Intel, and macOS Apple Silicon.

| Platform | File | Status |
| --- | --- | --- |
| Windows x64 | `Termlo-Setup-1.0.0-x64.exe` | Built and checked on Windows; full install/uninstall still needs an isolated-machine check |
| macOS Intel | `Termlo-1.0.0-x64.dmg` | Mac CI build configured; check the release run and test on a real Mac before relying on it |
| macOS Apple Silicon | `Termlo-1.0.0-arm64.dmg` | Mac CI build configured; check the release run and test on a real Mac before relying on it |

The installers are currently unsigned. Windows may show an unknown-publisher warning. macOS may block an unsigned app through Gatekeeper; signing and notarization are required for a smooth public macOS install. See [release and compatibility notes](RELEASING.md).

## What it does

- **SSH terminals:** multiple tabs, jump hosts, host-key verification, saved host groups, command highlighting, light/dark themes, and convenient clipboard handling.
- **Independent SFTP:** open a file connection without opening a terminal; browse, upload, download, and monitor transfers.
- **Host overview:** identify the OS when possible, show CPU/memory/disk details and live resource metrics after connecting.
- **Agent workbench:** connect an OpenAI-compatible model endpoint of your choice, discuss a plan, select one or more hosts, and then let the agent execute and verify work. Its commands appear in execution terminals; you can also open a separate interactive terminal.
- **Files and deployments:** attach files or a project ZIP to a task. The agent can inspect the provided material, plan a deployment, transfer files through SSH, and report concise results.
- **Reviewable state:** host-level change tracking and a task ledger provide compact context across conversations and model switches. Controlled file changes may be reversible; Alibaba Cloud ECS disk snapshots can be configured separately when appropriate.
- **Projects and accounts:** organize hosts into project spaces, move or copy a host between known spaces, and optionally connect to the standalone email/password account API.

The agent is a tool with real SSH permissions, not a sandbox around the remote machine. Host tracking is a limited observation, not a full snapshot. Arbitrary shell commands, package installs, databases, and multi-host changes are not automatically atomic or reversible. Check the target hosts and use suitable backups before high-impact work.

## First run

1. Install Termlo and add a host with its address, SSH user, and password or private key. Review the server fingerprint on first connection.
2. Open an SSH tab or the independent SFTP view. A saved jump host can be selected while editing a target host.
3. To use the agent, open **Assistant**, configure an OpenAI-compatible API URL, model, and key, then select the hosts it may access.
4. Use **Plan** to refine a proposal before execution, or select the execution mode for an autonomous task. Inspect the live command terminals and the final checks.

SSH passwords and model API keys can be stored using the operating system's encryption facilities. Task text, selected host details, and relevant command output are sent to the model provider you configure. The app's local task records are not a fully encrypted database.

## Build from source

Use Node.js **24.13+** and npm:

```sh
npm ci
npm test
npm run start
```

Build an installer on its target operating system:

```sh
npm run dist:win   # Windows x64
npm run dist:mac   # macOS, host architecture
```

The [GitHub Actions workflow](.github/workflows/build-installers.yml) tests and builds Windows, Intel Mac, and Apple Silicon Mac packages for `v*` tags, then publishes the successful artifacts to a GitHub Release. The [standalone account API](services/user-api/README.md) has its own setup and Swagger documentation; it is not bundled as a running server in the desktop installer.

## Data and compatibility

The display name is Termlo, while the existing Termus data directory and a few internal identifiers remain in place so previous local hosts and tasks remain visible:

- Windows: `%APPDATA%/Termus/`
- macOS: `~/Library/Application Support/Termus/`
- Source checkout: `data/`

Encrypted credentials cannot be copied reliably between operating systems. Back up data before an upgrade. For implemented details and limits, see [feature gaps](FEATURE-GAPS.md), [changelog](CHANGELOG.md), and [release notes](RELEASING.md).

No open-source license has been selected for this repository yet. The availability of its source and installers does not itself grant reuse or redistribution rights.
