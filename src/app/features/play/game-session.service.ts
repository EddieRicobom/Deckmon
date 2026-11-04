import { Injectable, computed, signal } from '@angular/core';
import { Command } from './core/commands';
import { createGame, DeckListEntry } from './core/game';
import { GameHistory, canUndo, createHistory, dispatch, undo } from './core/history';
import { GameState, PlayerIndex } from './core/types';
import { normaliseSeed } from './core/rng';
import { applyResync, buildWire, ResyncPayload, WireCommand } from './core/wire';

/**
 * Networking hook. Online play attaches a transport with `startOnline`. Every accepted local command goes
 * through `send` (as a wire command with reveals), and every accepted undo through `sendUndo`.
 */
export interface CommandTransport {
  send(wire: WireCommand, next: GameState): void;
  sendUndo(count: number, next: GameState): void;
}

export interface StartGameOptions {
  seed?: number;
  decks: [DeckListEntry[], DeckListEntry[]];
  names: [string, string];
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
  readonly canUndo = computed(() => {
    const h = this.history();
    if (!h || !canUndo(h)) return false;
    const local = this.localPlayer();
    if (local === null) return true;
    return h.commands[h.commands.length - 1]?.player === local;
  });
  /** Number of commands in the live history (undo lowers it). */
  readonly commandCount = computed(() => this.history()?.commands.length ?? 0);
  /** The board at the bottom of the mat. Solo: follows the active player. Online: this device's seat. */
  readonly viewer = computed<PlayerIndex>(() => this.localPlayer() ?? this.state()?.activePlayer ?? 0);
  /** Last rejected command, cleared on the next accepted one. */
  readonly lastError = signal<string | null>(null);

  start(options: StartGameOptions): void {
    const seed = normaliseSeed(options.seed ?? Date.now() ^ Math.floor(Math.random() * 0xffffffff));
    const state = createGame(seed, options.decks[0], options.decks[1], options.names);
    this.transport = null;
    this.localPlayer.set(null);
    this.history.set(createHistory(state));
    this.lastError.set(null);
  }

  /** Starts an online game from this device's state (own board real, opponent placeholder). */
  startOnline(state: GameState, local: PlayerIndex, transport: CommandTransport): void {
    this.transport = transport;
    this.localPlayer.set(local);
    this.history.set(createHistory(state));
    this.lastError.set(null);
  }

  /** Applies a command from this client and forwards it to the transport when one is attached. */
  applyLocal(cmd: Command): boolean {
    const local = this.localPlayer();
    if (local !== null) {
      if (cmd.player !== local) {
        this.lastError.set("That board belongs to your opponent.");
        return false;
      }
      if (TURN_COMMANDS.has(cmd.type) && this.state()?.activePlayer !== local) {
        this.lastError.set('Only the active player can change the phase, the turn or memory.');
        return false;
      }
    }
    const prev = this.state();
    const accepted = this.apply(cmd);
    const next = this.state();
    if (accepted && this.transport && prev && next) {
      this.transport.send(buildWire(prev, next, cmd), next);
    }
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
      this.lastError.set('Opponent sent a move for the wrong board.');
      return false;
    }
    const cmd: Command = {
      ...wire.cmd,
      ...(wire.reveals ? { reveals: wire.reveals } : {}),
      ...(wire.board ? { board: wire.board } : {}),
    };
    return this.apply(cmd);
  }

  /** Undo for this device. Online, it is limited to the local player's last command and is sent to the peer. */
  undo(): boolean {
    const h = this.history();
    if (!h || !canUndo(h)) return false;
    if (!this.canUndo()) {
      this.lastError.set('You can only undo your own last move, and only before your opponent moves.');
      return false;
    }
    const count = h.commands.length;
    const next = undo(h);
    this.history.set(next);
    this.lastError.set(null);
    if (this.transport) this.transport.sendUndo(count, next.present);
    return true;
  }

  /** The peer undid its last command. Applies it only when it matches the expected command count and owner. */
  applyRemoteUndo(count: number): boolean {
    const h = this.history();
    const remote = this.remote();
    if (!h || remote === null || !canUndo(h)) return false;
    if (h.commands.length !== count || h.commands[h.commands.length - 1]?.player !== remote) return false;
    this.history.set(undo(h));
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
      this.history.set({ initial: h.initial, commands: h.commands, past: [], present: next });
      this.lastError.set(null);
      return true;
    } catch (err) {
      this.lastError.set(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  clear(): void {
    this.transport = null;
    this.localPlayer.set(null);
    this.history.set(null);
    this.lastError.set(null);
  }

  private remote(): PlayerIndex | null {
    const local = this.localPlayer();
    if (local === null) return null;
    return local === 0 ? 1 : 0;
  }

  private apply(cmd: Command): boolean {
    const h = this.history();
    if (!h) {
      this.lastError.set('No game in progress.');
      return false;
    }
    try {
      this.history.set(dispatch(h, cmd));
      this.lastError.set(null);
      return true;
    } catch (err) {
      this.lastError.set(err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}
