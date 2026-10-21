# Operating manual

You are working with a memory vault: a folder of plain markdown notes that Deck
created for its user. Read this manual before your first tool call on any task,
and follow it in every project, not only inside this folder.

## 1. What this is

- The vault is the memory across sessions and across projects. Each session
  starts blank; the vault is how the next one knows what this one did.
- The user reads it too. Write for a person skimming: short lines, plain
  words, the newest state first.
- The vault beats chat history and your own recollection. When they disagree,
  trust the vault, or fix it (see 5).

## 2. Start

Before the first tool call on a task:

1. Read `Boards/Work.md`.
2. Read the project's note in `Projects/` (one note per project, named after
   it). No note yet: make one from `Templates/Project.md` and link it from
   `Home.md`.
3. Then start the task. When the board or the note changes your plan, say so.

## 3. Decisions

The moment a decision lands (the user picks an option, a design is settled, a
cause is found), write it into the note that owns it, then continue. Do not
batch decisions for the end of the session: a session can end at any moment.

A decision line: the date, what was decided, and why, in one or two sentences.

## 4. Done means the vault is updated

A task is done when, besides the work itself:

- its card is moved on `Boards/Work.md` (to Done, or to Waiting On with what
  it waits for);
- the project note's **As built** section says what now exists and where;
- today's daily note (`Daily/YYYY-MM-DD.md`, made from `Templates/Daily.md` on
  the first write of the day) has a line for it.

Your last message names the notes you updated.

## 5. Reconcile

When the code, the disk or the user contradicts a note, the note is wrong: fix
it in the same session, and say what you changed. Never leave two notes that
say different things about the same fact.

## 6. Folders and formats

| Folder | Holds |
|---|---|
| `Home.md` | The index: boards, projects, knowledge. Add a link for every new note. |
| `Boards/` | Kanban boards. `Work.md` has Backlog, This Week, In Progress, Waiting On, Done. |
| `Daily/` | One note per day, `YYYY-MM-DD.md`. |
| `Projects/` | One note per project: state, decisions, as built, open questions. |
| `Knowledge/` | Facts and how-tos that outlive a project. |
| `Templates/` | The shapes for new notes. Copy, never edit in place. |

**A card** is one checkbox line under a column heading, the project first:

```
- [ ] **Project**: what to do, in a few words [[Project note]]
```

Details go in the project note, not on the card. A finished card is ticked
(`- [x]`) and moved under `## Done`.

**A daily line** is one bullet with the time and what happened:

```
- 14:20 **Project**: what was done or decided [[Project note]]
```

**A project note** follows `Templates/Project.md`: State (one paragraph, kept
current), Decisions (dated, newest first), As built, Open questions.

**Links** use `[[Note name]]`. Every note carries `tags:` in its frontmatter.

## 7. Never

- Never put secrets in the vault: API keys, tokens, passwords, private keys,
  recovery codes. Write where a secret lives, never the secret itself.
- Never commit or push the vault yourself. Deck does that.
- Never delete a note without asking the user first. Merging two notes into
  one is fine when you keep everything both said.

## 8. Auto memory and notes

If Claude Code's auto memory points into `Memory/`, that folder is for how the
user wants you to work: preferences, corrections, habits. The rest of the vault
is for the state of the work. A preference goes in `Memory/`; a decision about
a project goes in its note.

## 9. What Deck writes itself

Deck appends to the vault on its own. Leave these lines as they are:

- capture lines, focus timer lines and session recaps in the daily note;
- `Tasks/Deck.md`, the checklist behind Deck's task list;
- `Health/Time Tracking.md`, the focus timer's log (the name is historical).

## 10. Generated maps

`Maps/Generated/`, when present, is written by the index app (Atlas). Read it,
never edit it. The `tags:` in each note's frontmatter are what it indexes, so
keep them accurate. When `Maps/Generated/Duplicates.md` lists a pair of notes,
merge the two the next time you touch either one, and link the survivor where
the other was linked.
