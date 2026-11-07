# Brick Sorter style guide

The full illustrated version is kept as a shared document; this file is the working copy for developers. Change both together.

## Principles

- One job per screen. Overview is reached from Home and stays off the tab bar.
- Buttons name the action. Dialogs say what goes and what stays.
- Row-level changes offer Undo. Permanent removal shows **This cannot be undone.** in bold red.
- Status colour appears only when it carries meaning, and always comes with a word.

## Wording

| Use | Not |
| --- | --- |
| bricks | pieces, parts |
| Remove | Delete, Abandon, Discard |
| Log bricks / Describe your brick | Add pieces |
| Bricks in storage | Bricks to pick |
| Official LEGO colour names | Rebrickable or invented names |

Short sentences, answer first. Toasts end with a full stop. Use the typographic apostrophe (can’t). Dialog titles are questions: `Remove Bin 3 (Hogwarts)?`.

## Colour tokens (`:root`, with dark overrides)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | #faf8f5 | #141211 | Page, inputs |
| `--surface` | #ffffff | #1e1b19 | Panels, cards, dialogs, tab bar |
| `--text` | #1d1b1a | #f2eeea | Body |
| `--muted` | #6b6560 | #a8a099 | Hints, metadata |
| `--border` | #e6e0d9 | #36312d | Hairlines |
| `--accent` | #b3261e | #c93a30 | Header, primary and outlined buttons |
| `--accent-text` | accent | #f19089 | Accent as text, active tab |
| `--danger` | #b3261e | #ef7b72 | Remove, warnings, bad tags |
| `--ok` | #1f7a3d | #6fcf8b | Enough, complete |
| `--warn` | #8a5300 | #f0b45a | Some, caution |
| `--neutral` | #6b6560 | #a8a099 | Plain tags, selected chips, Undo pill |

Never hard-code a hex in a component. Exceptions: LEGO swatch RGB from data, and the Store bin chip slate `#5b6b7a`.

## Type and shape

- System font stack, 16px/1.45. Header title 1.2rem/700; panel heading 1.05–1.1rem/700; hints and meta 0.9rem muted; tags 0.75rem/600.
- Gutter 16px, column max 640px, panels 16px padding, 12px apart.
- Radius: panels and cards 12px, inputs 10px, dialogs 16px, buttons and chips 999px.
- Tab bar 56px plus safe-area inset.

## Components

| Component | Class | Rule |
| --- | --- | --- |
| Primary button | `.btn.primary` | One per view. |
| Outlined button | `.btn.redout` | Secondary actions. |
| Lozenge | `.btn.lozenge` (+ `.small`) | In rows and beside search. |
| Danger button | `.btn.danger` | Confirmations and Remove everything. |
| Icon button | `.iconbtn`, `.trash`, `.editbtn` | 44px, needs `aria-label`. Trash sits top right of what it removes. |
| Chip | `.chip`, `.pickchip` | Toggle with `aria-pressed`; selected is grey. Label includes a count. |
| Tag | `.tag` `.ok` `.warn` `.bad` `.sm` | Outlined, read-only, always a word. |
| Card | `.card` | Tappable row with chevron. |
| Panel | `.panel` | One topic each. |
| Stepper | `.stepper`, `.pickstep`, `.pqty` | Max is what the action can honour. |
| Search row | `.searchrow` | Search plus Filter lozenge. |
| Swatch / stud | `.swatch`, `.binsquare` | Colour squares carry a stud. |
| Bin chip | `.binchip.store.big` | Code on the bin colour; Store tiles show a stud ring. |
| Picture fallback | `.setimg.nopic`, `.thumb.nopic` | Tinted brick icon. |
| Dialog | `ask()`, `openDialog()`, `notify()` | Shared `#dlg`; Cancel left, action right. |
| Toast | `toast()` | One sentence, 3.5 s. |
| Undo pill | `offerUndo()` | Grey, centred above the toast, 9 s. |

Icons: inline SVG, 24px, 2px stroke, round caps and joins, `currentColor`.

## Patterns

- Brick rows (Missing, pick, found): thumbnail, name, swatch and colour, tags line, stepper and lozenge. No big quantity number. Missing shows `N required` and `In storage: N`; the pick list shows `N available · N required`.
- Pick lists group by storage bin with a `Take all N from …` lozenge.
- Every search can be filtered: Sets by theme (from Rebrickable `theme_id`), inventory by colour, Log bricks by type.
- Feedback: moves say `Moved 3 × Plate 2 x 4 to Bin 2.` (also when an edit changes the bin); other edits say `Saved changes to …`; reversible bulk changes add the Undo pill; permanent removals use a confirmation then a toast (`Removed Bin 3 and 120 bricks.`).
- Removing: trash icon, dialog titled `Remove X?`, body says what goes and stays, red warning when permanent. Removing a storage bin removes its bricks. Removing a set bin returns the set to the catalogue.
- Empty states: one muted sentence saying what to do next. No illustrations.

## Accessibility

- 44px minimum tap targets; steppers 44 × 52px.
- 4.5:1 contrast in light and dark; check any new colour in both.
- Colour never carries meaning alone.
- `:focus-visible` outline: 3px accent, 2px offset.
- Icon-only buttons have `aria-label`; chips use `aria-pressed`, tabs `aria-selected`, expanders `aria-expanded`.
- Honour `prefers-reduced-motion` and `env(safe-area-inset-*)`.
- Everything renders offline.
