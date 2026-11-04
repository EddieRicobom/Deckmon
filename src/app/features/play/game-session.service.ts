import { Injectable, computed, signal } from '@angular/core';
import { Command } from './core/commands';
import { createGame, DeckListEntry } from './core/game';
import { GameHistory, canUndo, createHistory, dispatch, undo } from './core/history';
import { GameState, PlayerIndex } from './core/types';
import { normaliseSeed } from './core/rng';

/**
 * Networking hook. A P2P transport implements this and is attached with `setTransport`.
 * `applyLocal` sends every accepted local command through it; `applyRemote` applies a command
 * received from the other peer without echoing it back.
 */
export interface CommandTransport {
  send(cmd: Command, next: GameState): void;
}

export interface StartGameOptions {
  seed?: number;
  decks: [DeckListEntry[], DeckListEntry[]];
  names: [string, string];
}

/**
 * Owns the one live game for this browser tab. The playmat and any future bot or network layer
 * go through here, so the rules core stays the single source of truth.
 */
@Injectable({ providedIn: 'root' })
export class GameSession {
  private readonly history = signal<GameHistory | null>(null);
  private transport: CommandTransport | null = null;

  readonly state = computed<GameState | null>(() => this.history()?.present ?? null);
  readonly canUndo = computed(() => {
    const h = this.history();
    return !!h && canUndo(h);
  });
  /** Number of commands in the live history (undo lowers it). */
  readonly commandCount = computed(() => this.history()?.commands.length ?? 0);
  /** Solo mode: the board at the bottom of the mat follows the active player. */
  readonly viewer = computed<PlayerIndex>(() => this.state()?.activePlayer ?? 0);
  /** Last rejected command, cleared on the next accepted one. */
  readonly lastError = signal<string | null>(null);

  start(options: StartGameOptions): void {
    const seed = normaliseSeed(options.seed ?? Date.now() ^ Math.floor(Math.random() * 0xffffffff));
    const state = createGame(seed, options.decks[0], options.decks[1], options.names);
    this.history.set(createHistory(state));
    this.lastError.set(null);
  }

  /** Applies a command from this client and forwards it to the transport when one is attached. */
  applyLocal(cmd: Command): boolean {
    const accepted = this.apply(cmd);
    if (accepted && this.transport) {
      this.transport.send(cmd, this.state()!);
    }
    return accepted;
  }

  /** Applies a command received from a remote peer. Never forwards it. */
  applyRemote(cmd: Command): boolean {
    return this.apply(cmd);
  }

  undo(): boolean {
    const h = this.history();
    if (!h || !canUndo(h)) return false;
    this.history.set(undo(h));
    this.lastError.set(null);
    return true;
  }

  setTransport(transport: CommandTransport | null): void {
    this.transport = transport;
  }

  clear(): void {
    this.history.set(null);
    this.lastError.set(null);
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
