# Running `build-entities.mjs`

This folder holds a small Node script that fetches the current list of federal agencies and subagencies from USASpending and writes it to `entities.json` in the repo root. v2's resolver uses that file to translate colloquial user input ("crane", "disa", "aflcmc") into the exact names USASpending's API expects.

You run this script **manually, once in a while** — probably once a quarter. Agency org charts don't change often. If a user ever says "Mo doesn't recognize [some new agency name]", that's your cue to re-run this.

---

## First-time setup (one time only)

### 1. Install Node.js

Go to [nodejs.org](https://nodejs.org) and download the **LTS** version (the green button on the left). Install it. Accept all the defaults.

This adds a new command called `node` to your computer that can run JavaScript files. That's all Node is.

### 2. Verify it worked

Open VS Code. At the top menu, click **Terminal → New Terminal**. A panel appears at the bottom of the window with a blinking cursor.

Type this, then press Enter:

```
node --version
```

You should see something like `v22.13.0`. If you see "command not found" or similar, restart VS Code (fully quit and reopen) so it picks up the new install. If that doesn't work, restart your whole computer and try again.

You're now set up. You only do this once.

---

## Running the script

Every time you want fresh agency data:

### 1. Open the fedmo repo in VS Code

File → Open Folder, pick your fedmo folder. The left sidebar should show files like `mo_mock.html`, `resolver.js`, `stream-client.js`, and a `scripts/` folder.

### 2. Open the terminal

Menu: **Terminal → New Terminal**. Bottom panel appears.

### 3. Make sure you're in the right place

The terminal should already be sitting in your fedmo folder. You can check by typing:

```
ls
```

and pressing Enter. You should see `mo_mock.html`, `resolver.js`, and the other fedmo files listed. If not, VS Code opened somewhere weird — close the terminal and reopen the project from scratch.

### 4. Run the script

Type this, then press Enter:

```
node scripts/build-entities.mjs
```

That's it. You'll see output scrolling by for about 30 seconds. Looks like this:

```
[build-entities] fetching toptier agencies from https://api.usaspending.gov/api/v2/references/toptier_agencies/
[build-entities] got 160 toptier agencies
[build-entities] indexed 160 toptier agencies into dictionary
[build-entities] fetching subtiers for 160 toptiers (this is the slow part)...
[build-entities]   progress: 10/160 toptiers processed, 42 subtiers so far
[build-entities]   progress: 20/160 toptiers processed, 87 subtiers so far
...
[build-entities] ✓ wrote /path/to/your/repo/entities.json
[build-entities]   160 toptiers + 1440 subtiers
[build-entities]   1520 unique search keys
[build-entities]   0 toptier(s) failed (usually transient)
[build-entities]   took 28.4s

[build-entities] spot-check (these should all return at least one match):
[build-entities]   "disa" → 1 match(es): Defense Information Systems Agency
[build-entities]   "crane" → 1 match(es): Naval Surface Warfare Center Crane Division
[build-entities]   "aflcmc" → 1 match(es): Air Force Life Cycle Management Center
[build-entities]   ...
```

The last section (spot-check) is the proof that common federal terms resolve correctly. If any of those say "no matches", tell me which and I'll patch the script.

### 5. Commit the new entities.json

The script wrote a new file called `entities.json` in your fedmo root folder (same folder as `mo_mock.html`). Commit it to git and push.

That's the whole workflow.

---

## Troubleshooting

**"command not found: node"**
Node isn't installed or the terminal can't see it. Quit VS Code fully, reopen, try again. If still broken, restart your computer.

**"fatal: https://api.usaspending.gov..."**
USASpending's API is briefly down or your internet hiccupped. Just run the script again — it's safe to run multiple times, each run overwrites the previous `entities.json`.

**"WARN: failed to fetch subtiers for [some agency]"**
One toptier didn't respond. Not a big deal — small agencies like the American Battle Monuments Commission occasionally flake. The script continues with the others. If a BIG one fails (DoD, HHS, VA), re-run.

**Spot-check says "no matches" for something you expected**
USASpending may not have that term indexed under that abbreviation. Send me which term failed and I'll add an alias in v2's resolver that maps the colloquial term to the canonical name.

---

## What's in the output file

`entities.json` has this shape:

```json
{
  "_meta": {
    "generated_at": "2026-04-21T16:34:00Z",
    "toptier_count": 160,
    "subtier_count": 1440,
    ...
  },
  "entities": {
    "disa": [
      { "tier": "subtier", "name": "Defense Information Systems Agency",
        "abbreviation": "DISA", "toptier_name": "Department of Defense",
        "toptier_code": "097" }
    ],
    "crane": [
      { "tier": "subtier", "name": "Naval Surface Warfare Center Crane Division",
        "abbreviation": "", "toptier_name": "Department of Defense", ... }
    ],
    ...
  }
}
```

Each search key maps to an array because a term can be ambiguous ("Office of Inspector General" exists under multiple parent agencies). The array lets the resolver surface a "Did you mean?" prompt in those cases.
