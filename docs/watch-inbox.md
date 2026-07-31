# Watch inbox: spoken ideas → GitHub issues → the board

Speak an idea on your Apple Watch; it lands as an issue in a private inbox repo;
the next sweep shows it in the board's Inbox tab. Free, no extra apps. Known
limit: no offline queue — capture needs the phone nearby or watch connectivity.

## 1. The inbox repo

Create a **private** repo, e.g. `you/ideas-inbox`, and set it as `inboxRepo` in
`config.json`.

## 2. Mint a token (2 min)

GitHub → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens** → Generate new token:

- Expiration: 1 year
- Repository access: **Only select repositories** → your inbox repo
- Permissions → Repository permissions → **Issues: Read and write** (nothing else)

Scoped this tightly, a leaked token can do nothing but write issues to one
private inbox repo.

## 3. The Shortcut (2 actions, on the iPhone)

Shortcuts app → + → name it **Idea** (short name = easy "Hey Siri, Idea").

1. **Ask for Input** — Input Type: Text, Prompt: "Idea?"
   (Not Dictate Text: it is unreliable inside watchOS Shortcuts and often dies
   before the network step. Ask for Input opens the watch's standard input
   sheet, where the mic button gives the same speak-it flow.)
2. **Get Contents of URL** (expand the arrow)
   - URL: `https://api.github.com/repos/<you>/<inbox-repo>/issues`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer <token>`, `Accept` = `application/vnd.github+json`
   - Request Body: **JSON**, one field: `title` = the *Provided Input* magic
     variable chip from action 1 — the blue chip, not typed words, and exactly
     **once** (a duplicated chip posts doubled titles like "12341234").

Then in the Shortcut's info sheet, toggle **Show on Apple Watch**. Launch via
"Hey Siri, Idea", a watch-face complication, or the Ultra Action Button.

## Troubleshooting

- **Edits not reaching the watch**: toggle "Show on Apple Watch" off/on, reopen
  the watch Shortcuts app; stubborn cases, restart the watch.
- **"This action can't be run on Apple Watch"**: you used Dictate Text — swap
  to Ask for Input as above.
- **Doubled titles**: the JSON title field holds the input chip twice — delete
  one.
- **Silent failure after saying nothing**: GitHub rejects an empty title (422).
- Every attempt that reached GitHub is visible in seconds:
  `gh issue list --repo <you>/<inbox-repo> --state all`

## The loop after capture

Ideas show in the board's **Inbox** tab after the next sweep. Weekly, file each
into a project's backlog and close the issue (the card's ✓ copies the close
command). If dictation quality hurts or you need offline capture, the planned
replacement is [voice inbox v2](voice-inbox-v2.md): record audio on the watch,
transcribe locally on your Mac, file into this same repo.
