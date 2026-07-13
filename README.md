# Jira Desktop

A fast desktop Jira client for Linux (Ubuntu). Browse projects, search with JQL,
view and edit issues, comment, transition statuses, drag issues across a kanban
board, and create new issues — authenticated with your own Jira API token.

Works with **Jira Cloud** (`*.atlassian.net`) and falls back to the v2 REST API
for **Jira Server / Data Center**.

Built with Electron; ships as a `.deb` package and a portable `.AppImage`.

## Install

Download the latest build from the
[Releases page](https://github.com/maarten-vansever/jira-linux-desktop-client/releases/latest):

**Debian/Ubuntu (.deb):**

```bash
sudo apt install ./jira-desktop_<version>_amd64.deb
```

Then launch **Jira Desktop** from the app grid, or run `jira-desktop`.

**Portable (.AppImage):**

```bash
chmod +x "Jira Desktop-<version>.AppImage"
./"Jira Desktop-<version>.AppImage"
```

No installation needed.

## First run

1. Enter your Jira site URL (e.g. `https://your-team.atlassian.net`)
2. Enter the email of your Atlassian account
3. Paste an API token — create one at
   https://id.atlassian.com/manage-profile/security/api-tokens

The token is encrypted with your system keyring (libsecret) and stored in
`~/.config/jira-desktop/settings.json`. Nothing ever leaves your machine
except requests to your own Jira instance.

## Features

- Sidebar filters: current sprint, backlog, my open issues, all my issues, reported by me, recently updated
- Browse by issue type (Epic, Story, Task, Bug, … built from your site's types)
- Dashboards list (opens the dashboard in your browser)
- Project browser
- Search bar: free text, an issue key (`PROJ-123`), or raw JQL
- Issue detail: rendered rich-text descriptions (ADF), fields, labels, subtasks
- Comments: read and add
- Status transitions and assignee changes from the detail pane
- Kanban board view: uses your project's real Jira board (columns, multi-status grouping, board switcher) with drag & drop to transition issues; falls back to a status-grouped quick board
- Create issue dialog (project, type, priority, labels, description)
- Keyboard: `/` search · `j`/`k` navigate · `r` refresh · `c` create · `Esc` close

## Development

```bash
npm install        # install Electron toolchain
npm start          # run the app in dev mode
npm run icon       # regenerate build/icon.png
npm run dist       # build .deb + .AppImage into dist/
```

## Releases

Every push to `main`/`master` runs the
[release workflow](.github/workflows/release.yml): it builds the `.deb` and
`.AppImage` and publishes them as a GitHub release tagged `v<version>` from
`package.json`. If that tag already exists, the workflow skips publishing —
so to cut a new release, bump the `version` in `package.json` and push.
