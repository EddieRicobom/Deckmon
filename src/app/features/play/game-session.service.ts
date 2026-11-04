import { Injectable, computed, signal } from '@angular/core';
import { Command } from './core/commands';
import { createGame, DeckListEntry } from './core/game';
import { GameHistory, canRedo, createHistory, dispatch, redo, rewindTo, stepStartIndex, undo, undoCommands, undoableSteps } from './core/history';
import { GameState, PlayerIndex, RulesMode } from './core/types';
import { normaliseSeed } from './core/rng';
import { clearSoloGame, saveSoloGame } from './core/saved-game';
import { applyResync, buildWire, ResyncPayload, WireCommand } from './core/wire';

/**
 * Networking hook. Online play attaches a transport with `startOnline`. Every accepted local command goes
 * through `send` (as a wire command with reveals), and every accepted undo through `sendUndo`.
 */
export interface CommandTransport {
  send(wire: WireCommand, next: GameState): void;
  /** `count` is the command count AFTER the undo (the target length); the peer rewinds its own steps to it. */
  sendUndo(count: number, next: GameState): void;
}

export interface StartGameOptions {
  seed?: number;
  decks: [DeckListEntry[], DeckListEntry[]];
  names: [string, string];
  /** Defaults to assisted. */
  mode?: RulesMode;
  /** Assisted only: resolve card effects automatically (default) or show reminders only. */
  autoEffects?: boolean;
}

/** Commands that change the shared turn. Only the active player may issue them online. */
const TURN_COMMANDS = new Set<Command['type']>(['nextPhase', 'passTurn', 'setMemory', 'changeMemoryBy']);

/**
 * Owns the one live game for this browser tab. The playmat and any future bot or network layer
 * go through here, so the rules core stays the single source of truth.
 *
 * Solo: one screen, both boards, the viewer follows the active player.
 * Online: `localPlayer` is this device's seat. Only commands for that seat are accepted, and turn commands
 * only from the active player. Undo is limited to the local player's own last command.
 */
@Injectable({ providedIn: 'root' })
export class GameSession {
  private readonly history = signal<GameHistory | null>(null);
  private transport: CommandTransport | null = null;

  /** This device's seat in an online game. Null in solo mode. */
  readonly localPlayer = signal<PlayerIndex | null>(null);
  readonly online = computed(() => this.localPlayer() !== null);

  readonly state = computed<GameState | null>(() => this.history()?.present ?? null);
  /** How many steps undo would take back right now (0 when blocked). */
  /**
   * Online, a pending block or security check belongs to the peer's decision, so undo waits for it. Solo, a pending
   * block is this player's own prompt inside the attack's step, so undo takes the whole attack back.
   */
  readonly undoCount = computed(() => {
    const h = this.history();
    if (!h || (this.localPlayer() !== null && this.state()?.pending)) return 0;
    return undoableSteps(h, this.localPlayer());
  });
  readonly canUndo = computed(() => this.undoCount() > 0);
  /** Why undo is disabled, shown on the button. Null when undo is available or there is nothing to undo. */
  readonly undoBlockReason = computed<string | null>(() => {
    const h = this.history();
    if (!h || h.commands.length === 0 || this.undoCount() > 0) return null;
    if (this.localPlayer() !== null && this.state()?.pending) return 'A decision is pending.';
    const newestSnapshot = h.learned.length - 1;
    if (newestSnapshot >= 0 && h.learned[newestSnapshot]) return 'This step revealed hidden information, so it cannot be undone.';
    if (this.localPlayer() !== null) return 'Your opponent has acted since your last move.';
    return null;
  });
  /** Redo exists in solo only. Online steps are already sent to the peer, so they cannot be replayed locally. */
  readonly canRedo = computed(() => {
    const h = this.history();
    return !!h && this.localPlayer() === null && canRedo(h);
  });
  /** The live command log length, for "rewind to here" in the log panel (solo only). */
  readonly historyEntries = computed(() => this.history()?.commands.length ?? 0);
  /** Number of commands in the live history (undo lowers it). */
  readonly commandCount = computed(() => this.history()?.commands.length ?? 0);
  /** The board at the bottom of the mat. Solo: follows the active player. Online: this device's seat. */
  readonly viewer = computed<PlayerIndex>(() => this.localPlayer() ?? this.state()?.activePlayer ?? 0);
  /** Last rejected command, cleared on the next accepted one. */
  readonly lastError = signal<string | null>(null);
  /** Counts every rejection, so the same message shown twice still produces a new toast. */
  readonly errorCount = signal(0);
  /** Assisted manual override: commands skip the rules until it is turned off. Resets on a new game. */
  readonly force = signal(false);
  /** The options of the last solo game, for a rematch. */
  private lastOptions: StartGameOptions | null = null;

  /** Why redo is disabled, shown on the button. Null when redo is available or there is nothing to redo. */
  readonly redoBlockReason = computed<string | null>(() => {
    const h = this.history();
    if (!h || this.canRedo()) return null;
    if (this.localPlayer() !== null) return 'Redo is only available in solo play. Online steps are already sent to your opponent.';
    if (h.future.length === 0) return 'Nothing to redo.';
    return null;
  });

  start(options: StartGameOptions): void {
    const seed = normaliseSeed(options.seed ?? Date.now() ^ Math.floor(Math.random() * 0xffffffff));
    const state = createGame(
      seed,
      options.decks[0],
      options.decks[1],
      options.names,
      options.mode ?? 'assisted',
      options.autoEffects ?? true,
    );
    this.transport = null;
    this.localPlayer.set(null);
    this.setHistory(createHistory(state));
    this.lastOptions = { ...options, seed: undefined };
    this.force.set(false);
    this.lastError.set(null);
  }

  /**
   * Solo only: resumes a saved game from its current state. The undo history starts fresh, and rematch is not
   * available because the saved game does not carry its decks.
   */
  resumeSolo(state: GameState): void {
    this.transport = null;
    this.localPlayer.set(null);
    this.lastOptions = null;
    this.force.set(false);
    this.setHistory(createHistory(state));
    this.lastError.set(null);
  }

  /** Solo only: starts a new game with the same decks and names, and a fresh seed. */
  rematch(): boolean {
    if (!this.lastOptions || this.localPlayer() !== null) return false;
    this.start({ ...this.lastOptions });
    return true;
  }

  /** Turns the manual override on or off. It only has an effect in assisted mode. */
  setForce(on: boolean): void {
    this.force.set(on);
  }

  /** Shows a rejection to the player. Also used by the table for rejected local actions. */
  setError(message: string | null): void {
    this.lastError.set(message);
    if (message !== null) this.errorCount.update((n) => n + 1);
  }

  /** Starts an online game from this device's state (own board real, opponent placeholder). */
  startOnline(state: GameState, local: PlayerIndex, transport: CommandTransport): void {
    this.transport = transport;
    this.localPlayer.set(local);
    this.setHistory(createHistory(state));
    this.lastError.set(null);
  }

  /** Applies a command from this client and forwards it to the transport when one is attached. */
  applyLocal(input: Command): boolean {
    let cmd = input;
    if (this.force() && this.state()?.mode === 'assisted' && !cmd.force) cmd = { ...cmd, force: true };
    const local = this.localPlayer();
    if (local !== null) {
      if (cmd.player !== local) {
        this.setError("That board belongs to your opponent.");
        return false;
      }
      if (TURN_COMMANDS.has(cmd.type) && this.state()?.activePlayer !== local) {
        this.setError('Only the active player can change the phase, the turn or memory.');
        return false;
      }
    }
    const prev = this.state();
    const accepted = this.apply(cmd);
    const next = this.state();
    if (accepted && this.transport && prev && next) {
      this.transport.send(buildWire(prev, next, cmd), next);
    }
    if (accepted) this.autoSecurity();
    return accepted;
  }

  /**
   * Applies a command received from the remote peer. Never forwards it. Returns false when it cannot be applied,
   * which means the two peers have diverged.
   */
  applyRemote(wire: WireCommand): boolean {
    const remote = this.remote();
    if (remote === null) return false;
    if (!wire || !wire.cmd || wire.cmd.player !== remote) {
      this.setError('Opponent sent a move for the wrong board.');
      return false;
    }
    const cmd: Command = {
      ...wire.cmd,
      ...(wire.reveals ? { reveals: wire.reveals } : {}),
      ...(wire.board ? { board: wire.board } : {}),
    };
    const accepted = this.apply(cmd);
    if (accepted) this.autoSecurity();
    return accepted;
  }

  /**
   * Security checks belong to the defender, whose client owns the hidden cards. The defender's client (or the solo
   * device) resolves them without a prompt; the attacker's client only waits for the reveal.
   */
  private autoSecurity(): void {
    for (let guard = 0; guard < 50; guard++) {
      const pend = this.state()?.pending;
      if (!pend || pend.kind !== 'security') return;
      const local = this.localPlayer();
      if (local !== null && pend.owner !== local) return;
      if (!this.applyLocal({ type: 'securityCheck', player: pend.owner })) return;
    }
  }

  /**
   * Undo for this device: up to `steps` (default 1, all available when `steps` is 'all'). Online, only the local
   * player's own trailing steps that revealed nothing are undoable, and the rewind is sent to the peer.
   */
  undo(steps: number | 'all' = 1): boolean {
    const h = this.history();
    if (!h || !this.canUndo()) {
      if (h && h.commands.length > 0) this.setError(this.undoBlockReason() ?? 'Nothing to undo.');
      return false;
    }
    const available = this.undoCount();
    const n = steps === 'all' ? available : Math.min(steps, available);
    const next = undo(h, n);
    this.setHistory(next);
    this.lastError.set(null);
    if (this.transport) this.transport.sendUndo(next.commands.length, next.present);
    this.settleSolo();
    return true;
  }

  /** Redo the most recently undone step (solo only). */
  redo(): boolean {
    const h = this.history();
    if (!h || !this.canRedo()) return false;
    this.setHistory(redo(h));
    this.lastError.set(null);
    this.settleSolo();
    return true;
  }

  /** Solo "rewind to here": rewinds until `length` commands remain. Redo can bring the steps back. */
  rewindTo(length: number): boolean {
    const h = this.history();
    if (!h || this.localPlayer() !== null || this.state()?.pending) return false;
    if (length < 0 || length >= h.commands.length) return false;
    if (h.commands.length - stepStartIndex(h, length) > h.past.length) {
      this.setError('Cannot rewind that far: the earlier steps are no longer kept.');
      return false;
    }
    this.setHistory(rewindTo(h, length));
    this.lastError.set(null);
    this.settleSolo();
    return true;
  }

  /**
   * Safety net after a restore: solo never stays on a pending security check (the solo device resolves those itself).
   * Steps are kept whole, so this normally does nothing.
   */
  private settleSolo(): void {
    if (this.localPlayer() === null) this.autoSecurity();
  }

  /**
   * Solo "rewind to here" for a log entry: undoes the command that wrote the entry, and everything after it.
   * Entries from before the first command (the game start) cannot be rewound to.
   */
  rewindToLogEntry(logIndex: number): boolean {
    const target = this.rewindTargetFor(logIndex);
    return target === null ? false : this.rewindTo(target);
  }

  /** The command count that "rewind to here" returns to for a log entry, or null when it cannot (solo only). */
  rewindTargetFor(logIndex: number): number | null {
    const h = this.history();
    if (!h || this.localPlayer() !== null || this.state()?.pending) return null;
    let owner = -1;
    h.marks.forEach((mark, k) => {
      if (mark <= logIndex) owner = k;
    });
    return owner < 0 ? null : owner;
  }

  /**
   * The peer undid its own trailing steps. `target` is the command count after its undo. Every step being removed
   * must belong to the peer; the peer already checked that its steps revealed nothing to it.
   */
  applyRemoteUndo(target: number): boolean {
    const h = this.history();
    const remote = this.remote();
    if (!h || remote === null || !Number.isInteger(target) || target < 0 || target >= h.commands.length) return false;
    if (h.commands.length - target > h.past.length) return false;
    for (let i = h.commands.length - 1; i >= target; i--) {
      if (h.commands[i].player !== remote) return false;
    }
    this.setHistory(undoCommands(h, h.commands.length - target));
    return true;
  }

  /**
   * Adopts the remote's resync. Keeps this device's own board, takes the remote board and the shared fields.
   * Undo is cleared, but the command count is kept so both peers still count the same commands.
   */
  applyResyncPayload(payload: ResyncPayload, remote: PlayerIndex): boolean {
    const h = this.history();
    if (!h || this.remote() !== remote) return false;
    try {
      const next = applyResync(h.present, remote, payload);
      this.setHistory({
        initial: h.initial,
        commands: h.commands,
        past: [],
        learned: h.learned,
        present: next,
        future: [],
        marks: h.marks,
      });
      this.lastError.set(null);
      return true;
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  clear(): void {
    this.transport = null;
    this.localPlayer.set(null);
    this.setHistory(null);
    this.lastError.set(null);
  }

  /** Every history change goes through here. Solo games are saved on each change; a finished game is dropped. */
  private setHistory(h: GameHistory | null): void {
    this.history.set(h);
    if (this.localPlayer() !== null || !h) return;
    if (h.present.winner !== null && h.present.winner !== undefined) clearSoloGame();
    else saveSoloGame(h.present);
  }

  private remote(): PlayerIndex | null {
    const local = this.localPlayer();
    if (local === null) return null;
    return local === 0 ? 1 : 0;
  }

  private apply(cmd: Command): boolean {
    const h = this.history();
    if (!h) {
      this.setError('No game in progress.');
      return false;
    }
    try {
      this.setHistory(dispatch(h, cmd, this.localPlayer()));
      this.lastError.set(null);
      return true;
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}
