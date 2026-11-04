# Assisted rules: what the engine enforces

This file lists the rules that `core/rules/` enforces in **Assisted** mode, what it reminds you of, and what it
leaves to you. Manual mode ignores all of it.

**Source and section references.** The official Comprehensive Rules were the intended source
(`world.digimoncard.com/rule/pdf/general_rule.pdf`). The PDF could not be read while this was written (it came back
as compressed binary), so **no section numbers are given here**. Each rule is named, and the wording below is the
engine's interpretation. Check it against the rulebook and add section numbers before relying on it.

## Turn structure

| Phase | Who acts | What happens |
| --- | --- | --- |
| Unsuspend | automatic | The active player's stacks unsuspend. Stacks with `＜Reboot＞` that belong to the player whose turn just ended also unsuspend. |
| Draw | automatic | The active player draws 1. The first player skips the draw on turn 1. Drawing from an empty deck loses the game. |
| Breeding | player | One of: hatch the top Digi-Egg (breeding must be empty), move a Lv.3+ Digimon from breeding to battle, or do nothing. Hatch or move ends the phase. `nextPhase` ends it from "nothing". |
| Main | player | Play, digivolve, attack, option. Ends with Pass (or automatically, see Memory). |

- Assisted turn 1 starts at the breeding phase (no unsuspend or draw for the first player).
- The phase advances itself through unsuspend and draw inside the same command that ends the turn, so one undo step
  covers the whole handoff.

## Memory

- The gauge runs from -10 to +10. Positive is the active player's side.
- The first player starts at 0. Passing the turn sets the next player to +3.
- **Paying a cost** spends memory toward the opponent. Paying needs at least 1 memory on your side. A cost may take
  the gauge past centre (the cost is not limited to your current memory). This is the engine's reading of the rule.
- **Auto-end.** After any command in the main phase, if the gauge is on the opponent's side (memory < 0) and nothing
  is pending, the turn ends. The new active player gets the gauge value flipped (not reset to 3).
- **Pass** (manual end) sets the next player to +3.

## Play

- Digimon go to the battle area and Tamers to the tamer area. Each costs its `playCost` in memory.
- **Option**: pays `playCost`. Every colour in `optionCardColourRequirement` must be on your side (top cards of the
  battle, breeding and tamer areas). Then the card goes to trash. Its effect is applied by hand.
- Digi-Eggs cannot be played from hand.

## Digivolve

- Target: a Digimon in your battle or breeding area (not a Digi-Egg).
- Legal when one `digivolveCondition` entry matches the target's top card: the entry's `level` equals its level and
  the entry's `color` is one of its colours. The cost is that entry's `cost`.
- The stack keeps its suspended state and its "entered this turn" marker.
- **Draw bonus.** A successful digivolution draws 1 card (the spec this build follows).
- Inherited keywords: the `digivolveEffect` of every card under the top card applies to the stack.

## Attack (main phase)

- The attacker is an unsuspended battle Digimon that did not enter play this turn (unless `＜Rush＞`). It suspends.
- Target: the opponent player, or a suspended opponent Digimon.
- **Blocker** (only when attacking the player): the defender may suspend one unsuspended Blocker, which becomes the
  target. The defender may also decline. With no eligible Blocker, the step is skipped.
- **Battle**: DP is the top card's DP plus modifiers. Lower DP is deleted. A tie deletes both. The whole stack goes to
  trash.
- **Direct attack**: the defender performs security checks. Checks = 1 + the sum of the attacker's
  `＜Security A. +N/-N＞`, never below 0.
  - With no security cards left, a direct attack wins for the attacker.
  - Each check turns the top security card over and trashes it.
  - A Digimon security card battles the attacker by DP. The attacker is deleted when it loses or ties.
  - A Tamer or Option security card goes to trash. Its `[Security]` text is a reminder.
- **Piercing**: a blocked attack that deletes the Blocker continues into the security checks.
- **Jamming**: the attacker is not deleted in a battle against a security Digimon.
- **Retaliation**: when this Digimon is deleted in battle, the other battling Digimon is deleted too.

## Keywords

Keywords are read only where they open a line of effect text, so a conditional keyword inside a sentence ("gains
`＜Security A. +1＞` for every 3 colours") does not apply.

- Enforced: `Blocker`, `Rush`, `Piercing`, `Jamming`, `Retaliation`, `Reboot`, `Security A. +N/-N`.
- Parsed but not enforced: everything else (`Raid`, `Draw N`, `Recovery`, `Armor Purge`, `Barrier`, and the rest).
  They show up in reminders, not in automation.
- A manual marker whose name is a keyword (for example `Rush`) also counts.

## Reminders (no automation yet)

A timing tag in the card's text pushes a non-blocking reminder with the card name and the matching line:

- `[On Play]`: a Digimon or Tamer comes into play.
- `[When Digivolving]`: a card digivolves onto the stack.
- `[When Attacking]`: an attack is declared, or a Blocker blocks.
- `[On Deletion]`: a stack is deleted.
- `[Start of Your Turn]`, `[End of Your Turn]`, `[Start of Your Main Phase]`.
- `[Security]`: a Tamer or Option security card is revealed (read from `securityEffect`).
- `[Main]`: an Option is played (read from `effect`).

Not done: `[Your Turn]` and `[All Turns]` are continuous effects. They get no reminder yet.

## Winning

- Loses on drawing from an empty deck.
- Wins by a direct attack when the defender has no security cards left.
- `state.winner` and `state.winReason` are set. Commands are refused until a new game starts.

## Pending decisions (two peers)

- `state.pending` is `block` (owner: defender) or `security` (owner: defender).
- While a decision is pending, only its owner may act, and only to resolve it.
- The defender's client resolves security checks by itself. It reveals the top security card through the normal
  reveal path, so the attacker's client learns the card from the wire.
- Block choices are the defender's: the defender's client shows the prompt and sends `resolveBlock`.

## Force (manual override)

- Board edits (moves, DP, markers, counters, memory, draws, suspend) need **Force** in Assisted mode. A forced command
  skips the rules for that command and is logged as an override.
- Turn commands, play, digivolve, attack, coin, dice and shuffle work without Force.

## Known gaps

- Keyword effects are not automated (Draw, Recovery, Barrier, Armor Purge, Blast Digivolve, Raid, and so on).
- `[Once Per Turn]` is not tracked.
- The rules for memory when a cost exceeds your side, and the first-player memory rule, follow the engine's reading
  above and need checking against the rulebook.
- Digivolve draw bonus follows the task's spec and needs checking against the rulebook.
