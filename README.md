# Team Gantt

A shared, interactive Gantt chart for the team. One board, many workflow groups, five team members.

**In the app**
- Drag a bar to move it, drag either edge to resize, click it to edit (title, group, owner, dates, progress, status, notes).
- **Who are you?** On first visit each person picks their name (remembered in that browser; switch from the top bar). Your tasks get a gold outline and a star on the chart, and the **My tasks** panel lists what is delegated to you: overdue first, tick a box to mark done, change status, or "Take it" on an unassigned task. You get a notice when someone assigns you something. This is a name picker for convenience, not a security login; the shared password is what keeps outsiders out.
- **Dependencies:** each task shows READY (everything it depends on is done) or WAITS n. The "Ready now" chip filters to startable work.
- **Handoff notes:** when you finish a task, the board asks what changed from the plan. Notes (optionally marked as a warning) appear at the top of every task that depends on it, and a warning puts a red marker on those rows.
- Delegate from the dropdown on each row. Click a person chip at the top to see only their work.
- `+ Group` creates a workflow, `+ task` on a group row adds a task to it, the caret collapses a group.
- `Team` renames the five members and changes their colors. Zoom: Days / Weeks / Months.
- The board is shared: everyone sees changes within a few seconds.
- `Export` downloads a full backup. `Import` accepts a backup (replaces the board) or a task list (adds to the board, see below).

## Deploy on Render
1. Put this folder in a GitHub repo.
2. Render > New > **Web Service** > pick the repo. Build command `npm install`, start command `npm start`
   (or use **Blueprint** and `render.yaml`).
3. Add environment variable `TEAM_PASSWORD` (anyone with the link needs it; username can be anything).
4. Open the URL.

### Keeping the data (important)
Render's free web services have a temporary disk, so the board resets whenever the service restarts or redeploys.
Pick one:
- **Supabase (free, durable):** in the SQL editor run
  ```sql
  create table gantt_state (id int primary key, data jsonb not null, updated_at timestamptz default now());
  alter table gantt_state enable row level security;   -- no policies: only the server's service key can access it
  ```
  then set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (service_role key) in Render.
- **Render persistent disk** (paid plan): mount a disk at `/data` and set `DATA_DIR=/data`.
- Or use `Export` regularly as a manual backup.

## Filling the board from a file (for Claude or anyone)
Write a JSON file in this shape and click **Import** (see `tasks.example.json`):

```json
{ "groups": [ { "name": "Art Database", "tasks": [
  { "title": "Generate road tiles", "assignee": "Member 2", "start": "2026-11-09", "end": "2026-11-13",
    "status": "todo", "progress": 0, "notes": "optional" } ] } ] }
```
- Groups are matched by name (created if missing). Tasks are always added, never overwritten.
- `assignee` is a team member's name as shown in the app (or leave it out). `end` defaults to `start`.
- `status`: `todo`, `doing`, `done`, `blocked`. Dates are `YYYY-MM-DD`.
- If anything in the file is invalid, nothing is imported and the app tells you why.

The same JSON can be POSTed to `/api/bulk` by a script (`curl -u :PASSWORD -H 'Content-Type: application/json' -d @tasks.json https://YOUR-APP.onrender.com/api/bulk`).

## Run locally
`npm install && npm start`, then open http://localhost:3000 (data is saved in `./data`).
