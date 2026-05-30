---
name: byterover-onboarding
description: "Use when the user asks for a tour, intro, or overview of ByteRover (canonical phrase: 'Show me how ByteRover works'; also matches 'walk me through ByteRover', 'give me a ByteRover tour', 'how does ByteRover work', 'intro me to ByteRover'). Runs a 3-message guided introduction by learning the user's persona, persisting it locally, and demonstrating how ByteRover will use it."
---

# ByteRover Onboarding Tour

A 90-second guided introduction. Three agent messages total: **learn → demonstrate → wrap**.

The tour teaches the user that ByteRover remembers facts about them and their work — and that this memory is local, private, and starts shaping the agent's behavior immediately.

## When To Invoke

Invoke this guide when the user message reads as a request for an introduction, tour, or overview of ByteRover. Match semantically, not by exact string:

- "Show me how ByteRover works" (canonical phrase from the install docs)
- "Walk me through ByteRover" / "Give me a ByteRover tour"
- "How does ByteRover work?"
- "Intro me to ByteRover" / "Show me ByteRover"

If the user already knows ByteRover and asks a specific question, do NOT run the tour — answer directly using the relevant detail file (@query.md, @curate.md, etc.).

## Budget

Three **agent** messages, with natural user turns in between. Roughly 90 seconds end-to-end. Do not exceed three agent messages. Do not feature-dump.

The agent does NOT auto-fire the next message. Each message ends and waits for the user to respond — even a one-word "ok" or "go" is enough. This gives the user space to look at the artifact (or the web UI URL) before the next step. If the user asks a clarifying question instead of acknowledging, answer it briefly and resume the tour at the next agent turn — the question doesn't burn a tour-message slot.

## Message 1 — Learn the user's persona, curate it locally

**Lead with trust.** The very first sentence must make the local-only guarantee explicit, before you ask anything. Frame it as **user control**, not as a command name. Avoid mentioning `brv vc push` (or any other command) in the trust opener — command names in the trust moment read like a CLI manual, not a promise.

Example opening line:

> "Quick intro to ByteRover. Everything you share with me here stays on your machine — nothing leaves without your say-so."

Acceptable variants:

> "Quick intro to ByteRover. What you share with me here lives only on your machine — you decide if anything ever syncs elsewhere."

**Then explain what ByteRover does in one sentence.** Right after the trust line, before asking the interview question, give the user a one-line concept primer. Without this, they're being asked about their work without knowing what they're engaging with. Trust first, then orient, then ask.

Example:

> "In short: I'll save useful things about you and your project locally, then pull them back next session so we don't start from scratch every time."

Keep it to **one sentence**. Don't enumerate features. Don't explain mechanics (the save/retrieve loop is named later in this message, after the demo). The primer answers "what is this thing?" — nothing more.

Then run a **quick interview** — one combined open question that asks both about their work **and** about the pain that brought them to ByteRover. Do not present a form, a list of options, or a multiple-choice menu. Let the user answer however feels natural.

Example phrasing:

> "Tell me about your work — and what drives you nuts about AI agents on this codebase. When do they lose the plot, or need you to re-explain everything from scratch?"

The user's brain naturally splits the answer into two halves: identity + pain. Capture both.

The agent's job is to capture as much of the following as the user volunteers (do NOT prompt for each one explicitly, do NOT push for what they don't share):

- **Identity half**: archetype (solo / fleet / agency), stack, team shape, current focus, preferences.
- **Pain half**: what frustrates them about AI agents on this codebase — context loss, re-explaining every session, agents missing project conventions, etc.

**If the user shares the identity half but skips the pain**, follow up with ONE tight nudge before saving:

> "One more — anything that frustrates you about AI agents on this codebase today? When do they get lost or need you to re-explain from scratch?"

Just one nudge. If they still don't share a pain, save what you have and continue; don't push twice.

If the user shares a short answer, accept it. Don't drill down. "Working on side project" with no pain shared is a fine seed. The tour still works — just with a thinner artifact.

**Pain scope guard**: only commit to fixing pains in the **context-memory family** (re-explaining, lost session context, missed project conventions, repeated lookups). If the user shares a pain ByteRover doesn't solve (e.g. "my agent hallucinates code", "the model is slow"), acknowledge it briefly but do NOT overpromise — say something like "ByteRover won't fix hallucinations, but it will end the re-explain tax around your project context." Then continue with what's in scope.

When you have enough to save, **react like a human first**, then name the action. Don't go straight from "user shared a pain" to "running `brv curate`" — that's robotic. The acknowledgment beat does three things in 1-2 sentences:

1. **React** to the pain as a person who's heard it before would. Show shared understanding.
2. **Validate** that it's a real, common problem (where true — don't fake recognition).
3. **Transition** to saving by naming *what* you're saving and *why* ByteRover will use it.

Example for a user who said "agents always need to re-read the codebase before they can plan":

> "Oh yeah — that's the worst part of working with agents right now. You burn the first 10 minutes of every session getting the agent up to speed on what you and your team already know cold. I see this all the time."
>
> "Let me save your context to ByteRover — that's how I'll skip the re-read tomorrow and start where we left off today."

The user feels *heard* before the agent acts. The curate then runs.

Then run **one** `brv curate` call that captures everything they shared — both identity and pain — in their own words where possible. Keep the saved string **concise and dense** — it's what retrieval will return, so it should read well as a recall result, not as a narrative:

```bash
brv curate "<one or two sentences covering identity (who/stack/focus) AND pain (what frustrates them about AI agents on this codebase)>"
```

After the save, close the message with a **visible artifact**, then **name the pain back and commit to ending it**. This is the life-saving moment — when the user sees that the frustration they just described is exactly what ByteRover exists to kill.

```
Saved:
• <identity bullet — e.g. "Go backend dev, billing service for a small startup">
• <pain bullet — e.g. "Pain: re-explaining internal event taxonomy + reliability constraints every session">
• <cost bullet, when applicable — e.g. "Cost: ~10 minutes per session">

<pain-naming + commitment paragraph — 2 short sentences>

Lives at .brv/context-tree/ — local-only.
See it in your browser: http://localhost:7700
Also version-controlled, cloud-syncable, and shareable across agents — more at the end.
```

**The pain-naming + commitment paragraph** is the wow. It should:

1. **Name the pain with a sticky label.** Use "re-explain tax" as the canonical label (vivid, short, user-friendly). For other context-memory pains, use plain language: "session amnesia", "starting from scratch", "context loss." Naming gives the user vocabulary they didn't have.
2. **Validate that it compounds.** One short sentence: "Every new conversation, every new file, every new bug starts from zero."
3. **Commit to ending it as behavior, not as a feature.** "From this moment on: I'll start every session knowing [their context]. You stop re-explaining. You start where you left off."

Example, full block, for the Go billing user who shared the re-explain pain:

```
Saved:
• Go backend dev, billing service for a small startup
• Pain: re-explaining internal event taxonomy + reliability constraints every session
• Cost: ~10 minutes per session, every session

The pattern you described — the re-explain tax — compounds. Every new
conversation, every new file, every new bug starts from zero. That's
the exact problem ByteRover exists to kill.

From this moment on: I'll start every future session knowing your event
model, your reliability stance, and the context you just shared. You
stop re-explaining. You start where you left off.

Lives at .brv/context-tree/ — local-only.
See it in your browser: http://localhost:7700
Also version-controlled, cloud-syncable, and shareable across agents — more at the end.
```

**If the user shared no pain** (after the one-nudge attempt), skip the pain-naming paragraph entirely. Don't manufacture one. Show the identity bullets, the location line, the URL, the pause invitation. The tour still works; just without the life-saving moment.

The browser URL is the **verifiable** trust proof — the user can click it in 2 seconds and see their memory in a real local dashboard. Stronger than any worded assurance.

Do NOT tell the user to "run `brv webui`" — the daemon auto-starts the web server on the persisted port (default 7700). The URL works as soon as the daemon is alive, which it already is.

Do NOT ask "is this right?" — that turns the artifact into a form. Users who want to correct it will; users who don't, won't be slowed down.

The closing teaser line ("Also version-controlled, cloud-syncable, and shareable across agents — more at the end") plants a seed for Msg 3 Part 1. Keep it to one line. Do NOT explain `brv vc` or connectors here — the point is to signal "you have more controls when you want them" without diluting the local-only trust climax. The frame is *opt-in additions to the local default*, not contradictions to it.

Before the pause invitation, give the user a **2-beat concept map** so they know where they are in the flow and what's coming. Without this, "I'll show you retrieval next" is meaningless — the user has no idea what retrieval is or why it matters.

**Render this block with clear visual separation from the artifact above** — insert an extra blank line (or a horizontal rule `---`) before it. The concept map is its own distinct beat, not a continuation of the artifact. If it blurs into the artifact, the user reads it as more "saved" output and skims past.

```
---

That's half of how ByteRover works — save knowledge in, then pull
it back when it's relevant. The save is what we just did. The
retrieve is how I remember you across sessions, files, and conversations.

Take a peek at the browser if you want — I'll show you the retrieve side next.
```

The concept map makes the flow **predictable**. Predictability builds trust faster than novelty. The user now knows: there are two beats (save + retrieve), they just saw beat one, beat two is next, and they know what it's for.

Then stop. Do not run `brv query` until the user responds.

## Message 2 — Retrieve, and let the persona shape your behavior

Immediately retrieve what you just saved. **Name the action before doing it**, same as Msg 1:

> "Pulling it back with `brv query` — that's how knowledge comes out."

```bash
brv query "what do I know about this user and their work?"
```

Show the result in **one short line** — a sentence summarizing what came back, not the raw output. The point of this message is what you do _with_ the result, not the retrieval mechanics.

**If the retrieval returns more than just the persona** (e.g. existing curated project conventions, codebase standards, prior decisions), explicitly call that out as bonus context. This is the moment to demonstrate that ByteRover isn't only about persona — it remembers *project knowledge* too.

> Example: "Also retrieved: your team already curated codebase conventions and TDD rules. So tomorrow I won't just know who you are — I'll know your project's patterns too. You've got a head start."

For first-time users with empty trees, this branch doesn't fire — skip it and move to the identity sentence below. Don't fabricate "bonus context" that wasn't actually retrieved.

Then, in **one sentence**, name the identity (and pain, if shared) back to them in their words. This is affirmation, not confirmation — do not ask them to verify it.

> Example (identity + pain): "Got it — Go backend dev on a billing service, allergic to silently dropped events, tired of re-explaining your event model every session."
>
> Example (identity only): "Got it — solo Rust dev, perf-focused. That's how I'll think about you going forward."

After the identity sentence, **demonstrate the pain ending**. This is the wow moment. The agent isn't just echoing a saved string — it's resolving the specific frustration the user named.

Frame the demonstration around the future-self: imagine the user starting a fresh session tomorrow. The thing they used to have to re-explain is already loaded.

Example (Go billing user with re-explain pain):

> "Now imagine you open this repo tomorrow morning. Fresh Claude Code session. You don't say a word about your event model or your reliability constraints. I already know. That's it. That's the re-explain tax, gone."

Examples for identity-only users (no pain shared):

- Coding / Rust / perf-focused → "Next time you're debugging a slow path, I'll surface what I know about your codebase first. For example, in a typical Rust perf issue, I'd start by checking [thing relevant to their stack] before profiling."
- Fleet / multi-agent → "Next time a planner agent runs, it'll pull this persona context first so it knows the team shape."
- Agency / 4 clients → "Next time you switch to one of those clients, I'll scope my retrieval to that client's context automatically."

One demonstration. One or two sentences. **If pain was shared, demonstrate the pain ending.** Otherwise, demonstrate persona-shaped tailoring. Either way, concrete to what they shared. Do NOT generic-ify.

Close the message with **two short lines** — first the loop name, then the cross-session promise:

> "That's the loop — `brv curate` to save, `brv query` to retrieve."
>
> "Next session — or in a different conversation tomorrow — this context comes back automatically. You don't have to re-explain yourself."

The loop-name line is what gives the user a sticky mental model. Without it, they remember "the agent did stuff" instead of "save with curate, retrieve with query."

## Message 3 — Wrap + activation: seed real project context

Msg 3 is **not** a passive close. After Msg 2, the user has saved their persona but no actual project facts. If the tour ends here, tomorrow's session still starts cold on the codebase itself. Msg 3 closes that gap.

**Two parts:**

### Part 1 — Where memory lives + the three controls

Start with the location line — still command-free, same reason as the trust opener (the user is being told *where* and *who controls it*, not how to run a command):

> "Your memory lives in `.brv/context-tree/` — all local, you control sync."

Then deliver on Msg 1's "more at the end" promise with **three short bullets**. The trust-opener constraint applies only to the location line above; command names are appropriate here because we're naming capabilities, not establishing trust.

> "Three controls you have when you're ready:
> • **Version control** — `brv vc status`, `diff`, `commit`, `branch`. Git-style, just for your memory.
> • **Cloud sync, on your terms** — `brv vc push` / `brv vc pull` when you want it. Never automatic.
> • **Cross-agent sharing** — connectors let Claude, Codex, Amp, OpenCode, and other agents share the same memory."

Three bullets max. Do NOT walk through sub-commands, flags, or auth setup. If the user asks for details, point them at `brv vc --help` or `brv connectors --help` — those aren't tour material. The job here is to name what's available so the user knows the surface area exists; they can explore on their own time.

### Part 2 — Activation: seed project context now

Before the tour ends, get **at least one piece of real project knowledge** into the context tree. Two paths:

**Path A — Detect a known docs file.** Check the project for any of: `CLAUDE.md`, `AGENTS.md`, `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`. If one exists, offer to curate it:

> "One more thing — your persona is saved, but I don't know your codebase yet. I see `CLAUDE.md` in your repo. Want me to curate it as starter project context? Takes about 30 seconds."

If the user says yes, read the file yourself and curate its content: `brv curate "<one-line description>: $(cat <path>)"` (or the tool-mode session form). Confirm with one line.

**Path B — No docs file detected.** Prompt for one rule:

> "One more thing — your persona is saved, but I don't know your codebase yet. Share one rule about your code I should always honor — a convention, a no-go, an architectural decision. One sentence is enough."

If the user shares one, `brv curate` it and confirm.

**If the user declines either path**, accept and close. Don't push. The persona is still saved; they can curate project context anytime later.

### Why this matters

Without Part 2, the tour leaves the user with **persona only**. Tomorrow they open the repo and the agent knows who they are but nothing about the code. The "no more re-read tax" promise from Msg 1 is half-broken — the agent still has to re-read the code.

With Part 2, the user ends the tour with **persona + at least one piece of real project knowledge** in the tree. That's the difference between "I know you" and "I know you AND your project."

### Part 3 — Close the tour, hand it back

End Msg 3 with an explicit **done signal** that tells the user the tour is over and gives them two clear paths. This is the final beat — after it, the agent returns to normal operating mode.

Two paths, both equal-weight, neither presented as the "right" choice:

> "That's the tour. From here, two options:
>
> - **Want me to remember more?** Just ask — anything worth knowing about your project, your team, or your work. No special command, just tell me to save it.
> - **Or jump back to what you were doing.** I'll pull from ByteRover automatically whenever it's relevant. You don't have to think about it.
>
> Either way, you're set."

Why both paths matter:
- **Curate-more path** removes the friction of "how do I save more later?" — the answer is "just ask the agent." Users who want to keep building context know how.
- **Resume-work path** is the **safe default**. Users who feel done can leave without guilt or homework. ByteRover working in the background is the long-term promise; this beat reinforces it.

"Either way, you're set" closes the loop. The tour is over. There is no homework. The user is not behind.

**Skip Part 3 if Msg 3 has already gotten heavy** (long activation curate, multiple back-and-forths). Even then, end with at least one sentence — "That's the tour — ask me to save more anytime, or get back to work and I'll surface context as it's relevant." Don't leave the user wondering if there's more.

## After The Tour

The tour ends after Message 3. Return to normal operating mode (Iron Law: query before thinking, curate after implementing).

The persona you saved becomes seed knowledge for every future session. From here on, query it before answering project-grounded questions; curate updates to it when the user's work or focus shifts.

If the user invokes the tour again later, run it again — there is no state tracking, no "you've already seen this." A second tour is a re-orientation, not an error. The new persona save replaces (or augments) the previous one through normal curate behavior.

## What NOT To Do

- Do NOT extend past 3 messages.
- Do NOT present a form, multiple-choice menu, or rigid field list. Ask one open question.
- Do NOT drill down if the user gives a short answer. Save what they shared.
- Do NOT skip the trust statement in Message 1. It is the foundation of the user's willingness to share.
- Do NOT explain the architecture, the daemon, connector types, or the full command list.
- Do NOT prompt for an LLM provider, login, or any configuration. The tour runs with zero setup.
- Do NOT skip the persona-shaped tailoring in Message 2 in favor of a generic "here's how retrieve works" explanation. The tailored example IS the value demo.
- Do NOT tailor with hollow phrases like "As a Rust developer, you'll love…" or "Since you work on a CLI, you might want to…" — these read as templated personalization and erode trust faster than no tailoring at all. The tailored example must reference something **specific** the user said, paired with a **specific** action the agent will take.
- Do NOT turn the visible artifact in Message 1 into a confirmation step. No "Does this look right?" prompts. The artifact is shown so the user *feels* what was captured, not so they validate it.
- Do NOT manufacture a pain if the user didn't share one. Skip the pain-naming paragraph and the pain-ending demonstration in that case. A thinner tour is better than a fake one.
- Do NOT overpromise on pains outside the context-memory family. If the user names a pain ByteRover doesn't solve (hallucinations, model speed, bad code generation), acknowledge briefly and redirect to the in-scope pain. Do NOT claim ByteRover fixes things it doesn't.
