import { CdkDropListGroup } from '@angular/cdk/drag-drop';
import { NgClass, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DigimonCardStore } from '../../../store/digimon-card.store';
import { Command } from '../core/commands';
import { allCards, getStack } from '../core/game';
import { cardLabel, setCardNameResolver } from '../core/labels';
import { cardInfo, registerCardRecords } from '../core/rules/card-data';
import { digivolveCost, other, stackDp } from '../core/rules/helpers';
import { assistedError } from '../core/rules/validate';
import { CombatResult, GameState, MEMORY_MAX, MEMORY_MIN, PHASES, Phase, PlayerIndex, Stack } from '../core/types';
import { redactFor, HIDDEN_CARD_ID } from '../core/view';
import { GameSession } from '../game-session.service';
import { clearSoloGame, loadSoloGame, SavedSoloGame } from '../core/saved-game';
import { OnlineMatchService } from '../online-match.service';
import { attackReason, menuItemsFor, MenuItem, MenuTarget } from './menu-items';
import { InspectPanelComponent } from './inspect-panel.component';
import { OnlineBarComponent } from './online-bar.component';
import { HoverInfo, PlayerBoardComponent } from './player-board.component';
import { ReminderToastsComponent } from './reminder-toasts.component';

interface OpenMenu {
  x: number;
  y: number;
  target: MenuTarget;
  items: MenuItem[];
}

/** An attack being aimed: the attacking battle stack and its owner. */
interface AttackPlan {
  owner: PlayerIndex;
  stackId: string;
}

interface Notice {
  id: number;
  text: string;
  tone: 'error' | 'info';
}

/** The security check shown big on screen. */
interface SecurityFlash {
  cardId: string;
  lines: string[];
}

interface Outcome {
  headline: string;
  reason: string;
}

const PHASE_LABELS: Record<Phase, string> = {
  unsuspend: 'Unsuspend',
  draw: 'Draw',
  breeding: 'Breeding',
  main: 'Main',
  end: 'End',
};
const MEMORY_VALUES = Array.from({ length: MEMORY_MAX - MEMORY_MIN + 1 }, (_, i) => MEMORY_MIN + i);
/** Delay before a hover preview appears, so passing the pointer over the mat does not flicker. */
const HOVER_DELAY_MS = 150;
/** Width of the floating hover preview. Roughly twice a board card. */
const HOVER_WIDTH_PX = 190;
const CARD_RATIO = 88 / 63;
const DEFAULT_NEXT_MEMORY = 3;
const TURN_BANNER_MS = 1000;
const PHASE_FLASH_MS = 900;
const SECURITY_FLASH_MS = 1500;
const NOTICE_MS = 4500;
const MAX_NOTICES = 3;
const CARD_BACK = 'assets/images/digimon-card-back.webp';

/** A media query as a signal. Falls back to false where matchMedia is not available. */
function media(query: string) {
  const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null;
  const sig = signal(mq?.matches ?? false);
  mq?.addEventListener('change', (e) => sig.set(e.matches));
  return sig;
}

/** True when the target still exists on the board. */
function targetExists(target: MenuTarget, state: GameState): boolean {
  const p = state.players[target.owner];
  if (target.kind === 'stack') return !!getStack(p, target.stackId);
  if (target.kind === 'card') return allCards(p).some((c) => c.uid === target.uid);
  return true;
}

/** Display name of a stack's top card. */
function topName(stack: Stack | null | undefined): string {
  const top = stack?.cards[stack.cards.length - 1];
  return top ? cardLabel(top.cardId) : 'Digimon';
}

function attackCmd(plan: AttackPlan, target: { kind: 'player' } | { kind: 'stack'; stackId: string }): Command {
  return { type: 'attack', player: plan.owner, attackerStackId: plan.stackId, target };
}

@Component({
  selector: 'digimon-playmat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [NgClass, NgTemplateOutlet, RouterLink, CdkDropListGroup, PlayerBoardComponent, OnlineBarComponent, InspectPanelComponent, ReminderToastsComponent],
  template: `
    <!-- Shared fragments, used inline on desktop and inside the "more" sheet on phones -->
    <ng-template #phasesTpl>
      @if (state(); as s) {
        @for (ph of phases; track ph) {
          <span
            class="inline-block rounded px-2 py-0.5 text-xs transition-colors duration-300"
            [class.bg-accent]="ph === s.phase"
            [class.text-accent-ink]="ph === s.phase"
            [class.font-bold]="ph === s.phase"
            [class.bg-ink-2]="ph !== s.phase"
            [class.text-muted]="ph !== s.phase"
            [class.phase-flash]="flashPhase() === ph"
            [attr.aria-current]="ph === s.phase ? 'step' : null"
            >{{ phaseLabel(ph) }}</span
          >
        }
      }
    </ng-template>
    <ng-template #quickTpl>
      <button type="button" class="btn-play" (click)="quick({ type: 'draw', player: bottom(), count: 1 })">Draw 1</button>
      <button type="button" class="btn-play" (click)="quick({ type: 'unsuspendAll', player: bottom() })">Unsuspend all</button>
      <button
        type="button"
        class="btn-play"
        (click)="quick({ type: 'hatch', player: bottom() })"
        [disabled]="!!hatchReason()"
        [title]="hatchReason() ?? 'Hatch an egg into your breeding area'">
        Hatch
      </button>
      <button type="button" class="btn-play" (click)="quick({ type: 'revealSecurity', player: bottom(), position: 'top' })">
        Reveal top security
      </button>
      @if (state()?.turn === 1) {
        <button type="button" class="btn-play" (click)="quick({ type: 'mulligan', player: bottom() })">Mulligan</button>
      }
      <button type="button" class="btn-play" (click)="quick({ type: 'shuffleDeck', player: bottom(), zone: 'deck' })">Shuffle deck</button>
      <span class="mx-1 h-4 w-px bg-line" aria-hidden="true"></span>
      <button type="button" class="btn-play" (click)="quick({ type: 'flipCoin', player: bottom() })">Flip coin</button>
      <button type="button" class="btn-play" (click)="quick({ type: 'rollDice', player: bottom(), sides: 6 })">Roll d6</button>
      @if (state()?.mode === 'assisted') {
        <span class="mx-1 h-4 w-px bg-line" aria-hidden="true"></span>
        <button
          type="button"
          class="btn-play"
          [class.btn-force]="force()"
          [attr.aria-pressed]="force()"
          (click)="toggleForce()"
          title="Force: board edits skip the assisted rules. Each use is logged as an override.">
          Force{{ force() ? ': on' : '' }}
        </button>
      }
    </ng-template>
    <ng-template #payTpl>
      <span class="text-muted">Active pays</span>
      @for (n of payAmounts; track n) {
        <button type="button" class="btn-play px-2 py-0" (click)="changeMemory(-n)">Pay {{ n }}</button>
      }
      <span class="ml-2 text-muted">Gains</span>
      @for (n of gainAmounts; track n) {
        <button type="button" class="btn-play px-2 py-0" (click)="changeMemory(n)">Gain {{ n }}</button>
      }
    </ng-template>
    <!-- The log: each entry is a command's text. Solo only: a selected entry offers "Rewind to here". -->
    <ng-template #logTpl>
      @if (state(); as s) {
        <ol class="m-0 flex min-h-0 flex-1 list-none flex-col-reverse gap-1 overflow-y-auto p-0">
          @for (entry of s.log; track entry.seq) {
            <li class="border-b border-line/50 pb-1 text-muted">
              @if (rewindable(entry.seq)) {
                <button
                  type="button"
                  class="block w-full rounded text-left hover:bg-white/5"
                  [attr.aria-expanded]="logSelected() === entry.seq"
                  (click)="selectLog(entry.seq)">
                  <span class="font-mono text-[10px] text-accent">T{{ entry.turn }}</span>
                  <span class="text-fg"> {{ entry.text }}</span>
                </button>
                @if (logSelected() === entry.seq) {
                  <button type="button" class="btn-play mt-1 px-2 py-0 text-[11px]" (click)="rewindHere(entry.seq)">Rewind to here</button>
                }
              } @else {
                <span class="font-mono text-[10px] text-accent">T{{ entry.turn }}</span>
                <span class="text-fg"> {{ entry.text }}</span>
              }
            </li>
          }
        </ol>
      }
    </ng-template>

    <!-- A solo game saved in this browser, offered when the table opens without a live game -->
    @if (!state() && savedGame(); as saved) {
      <div class="fixed inset-0 z-[600] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="resume-title">
        <div class="w-full max-w-sm rounded-xl border border-line bg-ink-1 p-5 text-center">
          <h2 id="resume-title" class="m-0 font-display text-xl font-bold text-fg">Resume game?</h2>
          <p class="mt-2 text-sm text-muted">
            {{ saved.state.players[0].name }} vs {{ saved.state.players[1].name }}, turn {{ saved.state.turn }}, saved in this browser.
          </p>
          <div class="mt-4 flex flex-wrap justify-center gap-2">
            <button type="button" class="btn-play btn-primary" (click)="resumeSaved()">Resume game</button>
            <button type="button" class="btn-play" (click)="discardSaved()">Discard save</button>
          </div>
        </div>
      </div>
    }

    @if (state(); as s) {
      @if (outcome(); as out) {
        <div class="fixed inset-0 z-[600] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="outcome-title">
          <div class="w-full max-w-sm rounded-xl border border-line bg-ink-1 p-5 text-center">
            <h2 id="outcome-title" class="m-0 font-display text-2xl font-bold text-fg">{{ out.headline }}</h2>
            <p class="mt-2 text-sm text-muted">{{ out.reason }}</p>
            <div class="mt-4 flex flex-wrap justify-center gap-2">
              @if (!online()) {
                <button type="button" class="btn-play btn-primary" (click)="rematch()">Rematch</button>
              }
              <button type="button" class="btn-play" (click)="backToLobby()">Back to lobby</button>
            </div>
          </div>
        </div>
      }

      @if (turnBanner(); as banner) {
        <div class="pointer-events-none fixed inset-x-0 top-1/3 z-[480] flex justify-center" aria-live="assertive">
          <div class="turn-banner rounded-xl border border-accent bg-ink-1/95 px-8 py-4 font-display text-2xl font-bold text-fg shadow-2xl">
            {{ banner }}
          </div>
        </div>
      }

      @if (securityFlash(); as flash) {
        <div class="pointer-events-none fixed inset-0 z-[490] flex flex-col items-center justify-center gap-3 bg-black/50 p-4" aria-live="assertive">
          <img [src]="cardImage(flash.cardId)" alt="" class="security-flip w-48 max-w-[60vw] rounded-xl shadow-2xl shadow-black/70" />
          <div class="max-w-sm rounded-lg border border-line bg-ink-1/95 p-3 text-center text-sm text-fg">
            @for (line of flash.lines; track $index) {
              <p class="m-0 leading-snug">{{ line }}</p>
            }
          </div>
        </div>
      }

      @if (s.pending; as p) {
        @if (p.kind === 'block' && canDecide(p.owner)) {
          <div class="fixed inset-0 z-[500] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="block-title">
            <div class="w-full max-w-md rounded-xl border border-accent bg-ink-1 p-4 text-sm text-fg">
              <h2 id="block-title" class="m-0 text-base font-semibold">Block the attack?</h2>
              <p class="mt-1 text-muted">
                {{ topName(findStack(s, p.attacker, p.attackerStackId)) }} attacks {{ s.players[p.owner].name }}. Choose a
                Blocker to take the hit, or take the attack.
              </p>
              <ul class="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
                @for (id of p.blockers; track id) {
                  <li>
                    <button type="button" class="btn-play w-full justify-between" (click)="resolveBlock(id)">
                      <span class="truncate">{{ topName(findStack(s, p.owner, id)) }}</span>
                      <span class="font-mono">DP {{ dpOfStack(s, p.owner, id) }}</span>
                    </button>
                  </li>
                }
              </ul>
              <button type="button" class="btn-play mt-3 w-full" (click)="resolveBlock(null)">No block (take the attack)</button>
            </div>
          </div>
        } @else if (p.kind === 'block') {
          <div class="fixed inset-x-2 top-14 z-[450] mx-auto flex max-w-md items-center gap-2 rounded-lg border border-accent bg-ink-1 p-3 text-sm text-fg" role="status">
            Waiting for {{ s.players[p.owner].name }} to decide whether to block.
          </div>
        } @else {
          <div class="fixed inset-x-2 top-14 z-[450] mx-auto flex max-w-md items-center gap-2 rounded-lg border border-accent bg-ink-1 p-3 text-sm text-fg" role="status">
            Security check for {{ s.players[p.owner].name }}: {{ p.remaining }} left, resolving.
          </div>
        }
      }

      <!-- Attack target selection: the hint is always visible, Attack player is the touch route to the player -->
      @if (activeTarget(); as t) {
        <div
          class="fixed left-1/2 z-[465] flex max-w-[calc(100vw-1rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-lg border border-accent bg-ink-1 p-2 text-xs text-fg shadow-xl"
          [ngClass]="compact() ? 'top-[3.75rem]' : 'top-16'"
          role="status">
          @if (compact()) {
            <span>Tap a highlighted target ·</span>
          } @else if (targetHint(); as hint) {
            <span>{{ hint }}</span>
          }
          @if (playerTargetable()) {
            <button type="button" class="btn-play btn-primary" (click)="onTargetPick(null)">Attack {{ s.players[other(t.owner)].name }}</button>
          }
          <button type="button" class="btn-play" (click)="cancelAttack()">{{ compact() ? 'Cancel' : 'Cancel (Esc)' }}</button>
        </div>
      }

      <div
        cdkDropListGroup
        class="relative mx-auto flex h-[calc(var(--app-vh)-3.5rem)] w-full max-w-[100rem] flex-col gap-2 overflow-x-hidden px-2 py-2 md:h-[calc(var(--app-vh)-5rem)] md:px-4"
        [class.overflow-hidden]="compact()"
        [class.overflow-y-auto]="!compact()"
        [class.pb-56]="pinned() && !wide() && !compact()"
        [class.force-border]="force() && s.mode === 'assisted'">
        @if (compact()) {
          <!-- Phone and short landscape: one compact row. Everything else lives in the "more" sheet. -->
          <header class="flex h-[3.25rem] shrink-0 items-center gap-1.5 rounded-lg border border-line bg-ink-1 px-2">
            <span class="font-display text-sm font-bold text-fg">T{{ s.turn }}</span>
            <button
              type="button"
              class="btn-play min-w-0 truncate"
              (click)="nextPhase()"
              [disabled]="s.phase === 'end'"
              [attr.aria-label]="'Next phase, currently ' + phaseLabel(s.phase)">
              {{ phaseLabel(s.phase) }}
            </button>
            <button
              type="button"
              class="btn-play btn-primary"
              [class.animate-pulse]="s.memory < 0"
              (click)="toggleEndTurn()"
              [attr.aria-expanded]="endTurnOpen()">
              End turn
            </button>
            <button type="button" class="btn-play px-2.5" (click)="undo()" [disabled]="!session.canUndo()" aria-label="Undo" [title]="undoTitle()">
              <i class="pi pi-undo"></i>
            </button>
            <button type="button" class="btn-play px-2.5" (click)="redo()" [disabled]="!session.canRedo()" aria-label="Redo" [title]="redoTitle()">
              <i class="pi pi-undo redo-icon"></i>
            </button>
            <button
              type="button"
              class="btn-play ml-auto px-2.5"
              (click)="moreOpen.set(true)"
              [attr.aria-expanded]="moreOpen()"
              aria-label="More actions">
              <i class="pi pi-ellipsis-h"></i>
            </button>
          </header>
        } @else {
        <!-- Top bar -->
        <header class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-display text-lg font-semibold text-fg">Turn {{ s.turn }}</span>
          <span class="rounded bg-ink-2 px-2 py-0.5 text-xs text-muted"
            >Active: <b class="text-fg">{{ s.players[s.activePlayer].name }}</b></span
          >
          <span class="rounded bg-ink-2 px-2 py-0.5 text-xs text-muted" [attr.title]="s.mode === 'assisted' ? 'Rules enforced by the app' : 'Free sandbox: no rules enforced'"
            >{{ rulesLabel() }}</span
          >
          <nav class="flex flex-wrap gap-1" aria-label="Phases">
            <ng-container *ngTemplateOutlet="phasesTpl" />
          </nav>
          <div class="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" class="btn-play" (click)="nextPhase()" [disabled]="s.phase === 'end'">Next phase</button>
            <button type="button" class="btn-play btn-primary" (click)="toggleEndTurn()" [attr.aria-expanded]="endTurnOpen()">End turn</button>
            <button type="button" class="btn-play" (click)="undo()" [disabled]="!session.canUndo()" [title]="undoTitle()">
              <i class="pi pi-undo"></i> Undo
            </button>
            <button type="button" class="btn-play" (click)="redo()" [disabled]="!session.canRedo()" [title]="redoTitle()">
              <i class="pi pi-undo redo-icon"></i> Redo
            </button>
            <button type="button" class="btn-play" (click)="toggleShowAll()" [attr.aria-pressed]="showAll()">
              {{ showAll() ? 'Hide opponent info' : 'Show all cards' }}
            </button>
            <button type="button" class="btn-play lg:hidden" (click)="logOpen.set(!logOpen())">Log</button>
            <button type="button" class="btn-play" (click)="toLobby()">Lobby</button>
          </div>
        </header>
        }

        @if (!compact()) {
          <digimon-online-bar />
        }

        @if (endTurnOpen()) {
          <form
            class="flex flex-wrap items-center gap-2 rounded-lg border border-accent/60 bg-ink-1 p-2 text-xs"
            (submit)="$event.preventDefault(); confirmEndTurn()"
            aria-label="End turn">
            <label class="flex items-center gap-2 text-fg">
              Memory for the next player
              <input
                type="number"
                [min]="memoryMin"
                [max]="memoryMax"
                step="1"
                class="w-20 rounded border border-line bg-ink-2 px-2 py-1 font-mono text-fg"
                [value]="nextMemory()"
                (input)="nextMemory.set(toInt($any($event.target).value))" />
            </label>
            <span class="text-muted">{{ nextMemoryHint() }}</span>
            <div class="ml-auto flex gap-1.5">
              <button type="button" class="btn-play" (click)="endTurnOpen.set(false)">Cancel</button>
              <button type="submit" class="btn-play btn-primary">Pass turn</button>
            </div>
          </form>
        }

        <!-- Quick actions for your board (phones: in the "more" sheet) -->
        @if (!compact()) {
          <nav class="flex flex-wrap items-center gap-1.5 md:flex-nowrap" aria-label="Quick actions">
            <span class="mr-1 text-[10px] uppercase tracking-wide text-muted">Quick</span>
            <ng-container *ngTemplateOutlet="quickTpl" />
          </nav>
        }

        <div class="flex min-h-0 flex-1 gap-3">
          <div class="main-col flex min-w-0 flex-1 flex-col gap-2">
            <!-- Opponent: full board, or a compact strip on phones (tap to open the full board) -->
            @if (compact()) {
              <button
                type="button"
                class="opp-strip flex w-full items-center gap-2 overflow-hidden rounded-xl border border-line bg-ink-1 p-1.5 text-left"
                (click)="opponentOpen.set(true)"
                [attr.aria-label]="'Open ' + s.players[top()].name + ' board'">
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-semibold text-fg">{{ s.players[top()].name }}</span>
                  <span class="block truncate font-mono text-[10px] text-muted">
                    Hand {{ display()!.players[top()].hand.length }} · Deck {{ display()!.players[top()].deck.length }} · Sec
                    {{ s.players[top()].security.length }} · Trash {{ s.players[top()].trash.length }}
                  </span>
                </span>
                <span class="thumbs flex shrink-0 items-center gap-1 overflow-x-auto">
                  @for (st of display()!.players[top()].battle; track st.stackId) {
                    <span class="relative block h-10 shrink-0">
                      <img [src]="thumb(st)" alt="" class="block h-full w-auto rounded-[4%] aspect-[63/88]" />
                      @if (dpOf(st); as dp) {
                        <span class="absolute bottom-0 right-0 rounded bg-black/80 px-0.5 font-mono text-[9px] font-bold text-white">{{ dp }}</span>
                      }
                    </span>
                  } @empty {
                    <span class="text-[10px] text-muted">No Digimon</span>
                  }
                </span>
              </button>
            } @else {
              <digimon-player-board
                class="flex min-h-0 flex-1"
                [player]="display()!.players[top()]"
                [owner]="top()"
                [mirrored]="true"
                [active]="s.activePlayer === top()"
                [targeting]="activeTarget() !== null"
                [targetStackIds]="targetStackIds()"
                [playerTargetable]="playerTargetable() && targetOwner() === top()"
                (issue)="act($event)"
                (menu)="openMenu($event.x, $event.y, $event.target)"
                (preview)="onPreview($event)"
                (pin)="pinTarget($event)"
                (targetPick)="onTargetPick($event)" (targetMiss)="onTargetMiss()" />
            }

            <div class="own-col">
            <!-- Memory gauge -->
            <div class="flex flex-col gap-1 px-1" [class.gauge-compact]="compact()">
              <div class="flex items-center gap-2">
                <span
                  class="w-16 shrink-0 truncate text-right text-[10px] uppercase tracking-wide text-muted sm:w-20"
                  [class.hidden]="compact()"
                  >{{ s.players[top()].name }}</span
                >
                <button type="button" class="btn-play px-2" (click)="changeMemory(-1)" aria-label="Memory minus one">−</button>
                <div
                  class="track relative flex min-w-0 flex-1 overflow-hidden rounded-full border border-line bg-ink-2"
                  [class.h-7]="!compact()"
                  role="group"
                  aria-label="Memory gauge">
                  @for (v of memoryValues; track v) {
                    <button
                      type="button"
                      class="relative h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[9px] text-muted transition-colors hover:bg-white/5 md:text-[10px]"
                      [class.border-r]="v !== memoryMax"
                      [class.border-line]="v !== memoryMax"
                      [attr.aria-label]="'Set memory to ' + v"
                      [attr.aria-pressed]="v === s.memory"
                      (click)="setMemory(v)">
                      @if (v % 5 === 0) {
                        <span class="tick pointer-events-none">{{ v > 0 ? '+' + v : v }}</span>
                      }
                    </button>
                  }
                  <span
                    class="token pointer-events-none absolute top-1/2 flex h-5 min-w-[1.75rem] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent px-1 font-mono text-[11px] font-bold text-accent-ink shadow"
                    [style.left.%]="tokenPercent(s.memory)">
                    {{ s.memory > 0 ? '+' + s.memory : s.memory }}
                  </span>
                </div>
                <button type="button" class="btn-play px-2" (click)="changeMemory(1)" aria-label="Memory plus one">+</button>
                <span
                  class="w-16 shrink-0 truncate text-[10px] uppercase tracking-wide text-muted sm:w-20"
                  [class.hidden]="compact()"
                  >{{ s.players[bottom()].name }}</span
                >
              </div>
              @if (!compact()) {
                <div class="flex flex-wrap items-center gap-1.5 pl-16 text-[11px] sm:pl-20 md:flex-nowrap">
                  <ng-container *ngTemplateOutlet="payTpl" />
                  @if (s.memory < 0 && !endTurnOpen()) {
                    <button type="button" class="btn-play btn-hint" (click)="toggleEndTurn()">Memory crossed to their side: pass turn?</button>
                  }
                </div>
              }
            </div>

            <!-- You (bottom) -->
            <digimon-player-board
              class="flex min-h-0 flex-1"
              [player]="display()!.players[bottom()]"
              [owner]="bottom()"
              [active]="s.activePlayer === bottom()"
              [targeting]="activeTarget() !== null"
              [targetStackIds]="targetStackIds()"
              [playerTargetable]="playerTargetable() && targetOwner() === bottom()"
              [digivolveCosts]="digivolveCosts()"
              (issue)="act($event)"
              (menu)="openMenu($event.x, $event.y, $event.target)"
              (preview)="onPreview($event)"
              (pin)="pinTarget($event)"
              (targetPick)="onTargetPick($event)" (targetMiss)="onTargetMiss()"
              (dragHand)="dragHandUid.set($event)" />
            </div>
          </div>

          <!-- Wide screens: side column with the pinned card on top and the log below -->
          @if (wide()) {
            <aside class="flex w-[21rem] shrink-0 flex-col gap-2 overflow-hidden rounded-xl border border-line bg-ink-1 p-3 text-xs">
              @if (pinnedInfo(); as pin) {
                <div class="min-h-0 flex-[3] overflow-y-auto pr-1">
                  <digimon-inspect-panel
                    [target]="pin.target"
                    [state]="pin.state"
                    [editable]="canEdit(pin.target.owner)"
                    [force]="force()"
                    (issue)="act($event)"
                    (attack)="beginAttack(pin.target)"
                    (closed)="unpin()" />
                </div>
              }
              <div
                class="flex min-h-0 flex-col gap-2"
                [ngClass]="pinnedInfo() ? 'flex-[2] border-t border-line pt-2' : 'flex-1'">
                <div class="flex items-center justify-between">
                  <span class="font-semibold text-fg">Log</span>
                  <span class="text-muted">{{ s.log.length }} entries{{ session.localPlayer() === null ? ' · click to rewind' : '' }}</span>
                </div>
                <ng-container *ngTemplateOutlet="logTpl" />
              </div>
            </aside>
          } @else {
            <!-- Tablet and phone: the log is a drawer -->
            <aside
              class="flex w-64 shrink-0 flex-col gap-2 rounded-xl border border-line bg-ink-1 p-2 text-xs"
              [ngClass]="logOpen() ? 'fixed bottom-2 right-2 top-2 z-[400] w-72' : 'hidden'">
              <div class="flex items-center justify-between">
                <span class="font-semibold text-fg">Log</span>
                <span class="text-muted">{{ s.log.length }} entries</span>
              </div>
              <ng-container *ngTemplateOutlet="logTpl" />
            </aside>
          }
        </div>

        <!-- Hover preview: non-interactive, follows the pointer, never covers it. Desktop only. -->
        @if (canHover() && hoverCard(); as hc) {
          <img
            [src]="hc.cardImage"
            alt=""
            class="pointer-events-none fixed z-[300] rounded-lg shadow-2xl shadow-black/60"
            [style.left.px]="previewLeft()"
            [style.top.px]="previewTop()"
            [style.width.px]="previewWidth" />
        }

        <!-- Phone and tablet: pinned card as a bottom sheet with its actions -->
        @if (!wide() && pinnedInfo(); as pin) {
          <section
            class="fixed inset-x-0 bottom-0 z-[450] max-h-[68vh] overflow-y-auto rounded-t-2xl border-t border-line bg-ink-1 p-3 shadow-2xl"
            aria-label="Card inspector">
            <div class="mx-auto mb-2 h-1 w-10 rounded-full bg-line" aria-hidden="true"></div>
            <digimon-inspect-panel
              variant="sheet"
              [target]="pin.target"
              [state]="pin.state"
              [editable]="canEdit(pin.target.owner)"
              [force]="force()"
              (issue)="act($event)"
              (attack)="beginAttack(pin.target)"
              (closed)="unpin()" />
          </section>
        }

        <!-- Phone: the full opponent board as a sheet -->
        @if (compact() && opponentOpen()) {
          <section class="fixed inset-0 z-[440] flex flex-col gap-2 overflow-y-auto bg-ink-0 p-2" aria-label="Opponent board">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-fg">{{ s.players[top()].name }}'s board</span>
              <button type="button" class="btn-play" (click)="opponentOpen.set(false)">Close</button>
            </div>
            <digimon-player-board
              class="flex"
              [player]="display()!.players[top()]"
              [owner]="top()"
              [mirrored]="true"
              [active]="s.activePlayer === top()"
              [targeting]="activeTarget() !== null"
              [targetStackIds]="targetStackIds()"
              [playerTargetable]="playerTargetable() && targetOwner() === top()"
              (issue)="act($event)"
              (menu)="openMenu($event.x, $event.y, $event.target)"
              (preview)="onPreview($event)"
              (pin)="pinTarget($event)"
              (targetPick)="onTargetPick($event)" (targetMiss)="onTargetMiss()" />
          </section>
        }

        <!-- Phone and short landscape: phases, quick actions, memory, view, log, lobby and PvP chat / resign -->
        @if (compact() && moreOpen()) {
          <div class="fixed inset-0 z-[455] bg-black/50" role="presentation" (click)="moreOpen.set(false)"></div>
          <section
            class="fixed inset-x-0 bottom-0 z-[456] flex max-h-[85vh] flex-col gap-3 overflow-y-auto rounded-t-2xl border-t border-line bg-ink-1 p-3 shadow-2xl"
            aria-label="More actions">
            <div class="mx-auto h-1 w-10 rounded-full bg-line" aria-hidden="true"></div>
            <div class="flex items-center justify-between">
              <span class="font-semibold text-fg">Turn {{ s.turn }} · {{ s.players[s.activePlayer].name }} active · {{ rulesLabel() }}</span>
              <button type="button" class="btn-play" (click)="moreOpen.set(false)">Close</button>
            </div>
            <div class="flex flex-col gap-1.5">
              <span class="sheet-label">Phase</span>
              <div class="flex flex-wrap gap-1"><ng-container *ngTemplateOutlet="phasesTpl" /></div>
            </div>
            <div class="flex flex-col gap-1.5">
              <span class="sheet-label">Quick</span>
              <div class="flex flex-wrap gap-1.5"><ng-container *ngTemplateOutlet="quickTpl" /></div>
            </div>
            <div class="flex flex-col gap-1.5">
              <span class="sheet-label">Memory</span>
              <div class="flex flex-wrap items-center gap-1.5 text-[11px]"><ng-container *ngTemplateOutlet="payTpl" /></div>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <button type="button" class="btn-play" (click)="toggleShowAll()" [attr.aria-pressed]="showAll()">
                {{ showAll() ? 'Hide opponent info' : 'Show all cards' }}
              </button>
              <button type="button" class="btn-play" (click)="logOpen.set(true); moreOpen.set(false)">Log</button>
              <button type="button" class="btn-play" (click)="toLobby()">Lobby</button>
            </div>
            <digimon-online-bar />
          </section>
        }

        <!-- Context menu -->
        @if (menu(); as m) {
          <div class="fixed inset-0 z-[600]" (click)="closeMenu()" (contextmenu)="$event.preventDefault(); closeMenu()" role="presentation"></div>
          <ul
            class="fixed z-[601] m-0 max-h-[70vh] min-w-[13rem] list-none overflow-y-auto rounded-lg border border-line bg-ink-1 p-1 text-sm shadow-xl"
            [style.left.px]="menuLeft(m.x)"
            [style.top.px]="menuTop(m.y)"
            role="menu">
            @for (item of m.items; track $index) {
              @if (item.separator) {
                <li class="my-1 border-t border-line" role="separator"></li>
              }
              @if (item.label) {
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    class="block w-full rounded px-2 py-1.5 text-left hover:bg-white/10 disabled:cursor-not-allowed"
                    [class.text-red-300]="item.danger"
                    [class.text-fg]="!item.danger"
                    [class.text-accent]="item.attack && !item.disabled"
                    [class.opacity-45]="!!item.disabled"
                    [disabled]="!!item.disabled"
                    [attr.title]="item.disabled ?? null"
                    (click)="runItem(item)">
                    {{ item.label }}
                  </button>
                </li>
              }
            } @empty {
              <li class="px-2 py-1.5 text-muted">Nothing to do here</li>
            }
          </ul>
        }
      </div>

      <!-- Notices: rejected actions and battle results. Non-blocking; tap to dismiss. -->
      @if (notices().length > 0) {
        <div class="pointer-events-none fixed inset-x-2 z-[510] flex flex-col items-center gap-1.5" [ngClass]="compact() ? 'top-[3.75rem]' : 'top-14'" aria-live="polite">
          @for (n of notices(); track n.id) {
            <button
              type="button"
              class="pointer-events-auto max-w-md rounded-lg border px-3 py-1.5 text-left text-xs shadow-lg"
              [ngClass]="n.tone === 'error' ? 'border-red-500/60 bg-red-950/90 text-red-100' : 'border-line bg-ink-1/95 text-fg'"
              (click)="dismissNotice(n.id)">
              {{ n.text }}
            </button>
          }
        </div>
      }

      <digimon-reminder-toasts [reminders]="s.reminders ?? []" [names]="names()" [top]="compact()" />
    } @else {
      <div class="flex h-[calc(var(--app-vh)-7.5rem)] flex-col items-center justify-center gap-3 p-6 text-center">
        <p class="m-0 text-muted">No game in progress.</p>
        <a routerLink="/play" class="btn-play btn-primary no-underline">Start a game</a>
      </div>
    }
  `,
  styles: [
    `
      /* Full width: the app shell centres its outlet in a flex row, which would otherwise shrink the table to its content. */
      :host {
        display: block;
        width: 100%;
        min-width: 0;
      }
      .main-col {
        min-height: 0;
      }
      /* Desktop/tablet: boards keep their natural height (no squashing that made the opponent's
         hand spill over the memory gauge); the column scrolls if the window is short. */
      @media (min-width: 768px) and (min-height: 501px) {
        .main-col {
          overflow-y: auto;
        }
        .main-col > digimon-player-board,
        .own-col,
        .own-col > digimon-player-board {
          /* !important: Tailwind is configured with important utilities (flex-1) */
          flex: 0 0 auto !important;
        }
      }
      .own-col {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        gap: 0.25rem;
        min-width: 0;
        min-height: 0;
      }
      .sheet-label {
        font-size: 0.6rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--dc-muted, #94a3b8);
      }
      /* Compact gauge: one row, the number is the thing to read. */
      .gauge-compact .track {
        height: 2.25rem;
      }
      .gauge-compact .tick {
        display: none;
      }
      .gauge-compact .token {
        height: 1.75rem;
        min-width: 2.75rem;
        font-size: 0.9rem;
      }
      /* Opponent strip: one line of counts plus battle thumbnails, 56px tall on a phone. */
      .opp-strip {
        height: 3.5rem;
      }
      .opp-strip .thumbs img {
        aspect-ratio: 63 / 88;
      }
      .btn-play {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        min-height: 2.25rem;
        border: 1px solid var(--dc-line, #334155);
        background: var(--dc-ink-2, #1e293b);
        color: var(--dc-fg, #e2e8f0);
        border-radius: 0.5rem;
        padding: 0.3rem 0.6rem;
        font-size: 0.75rem;
        cursor: pointer;
      }
      .btn-play:hover:not(:disabled) {
        border-color: var(--dc-accent, #38bdf8);
      }
      .btn-play:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--dc-accent, #38bdf8);
        color: var(--dc-accent-ink, #0f172a);
        border-color: transparent;
        font-weight: 600;
      }
      .btn-hint {
        border-color: var(--dc-accent, #38bdf8);
        color: var(--dc-accent, #38bdf8);
      }
      /* Force is on: amber, so the override is never on by accident. */
      .btn-force {
        border-color: #f59e0b;
        color: #fcd34d;
      }
      /* Subtle warning frame while the Force override is on (assisted mode). */
      .force-border {
        box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.55);
        border-radius: 0.75rem;
      }
      .redo-icon {
        transform: scaleX(-1);
      }
      .phase-flash {
        animation: phase-flash 0.9s ease-out;
      }
      @keyframes phase-flash {
        0% {
          transform: scale(1.3);
          box-shadow: 0 0 0 0 var(--dc-accent, #38bdf8);
        }
        60% {
          box-shadow: 0 0 0 6px transparent;
        }
        100% {
          transform: scale(1);
        }
      }
      .turn-banner {
        animation: turn-banner 1s ease-out both;
      }
      @keyframes turn-banner {
        0% {
          opacity: 0;
          transform: translateY(-8px) scale(0.95);
        }
        15%,
        80% {
          opacity: 1;
          transform: none;
        }
        100% {
          opacity: 0;
        }
      }
      .security-flip {
        animation: security-flip 0.6s ease-out both;
      }
      @keyframes security-flip {
        from {
          transform: rotateY(180deg) scale(0.9);
          opacity: 0.3;
        }
        to {
          transform: rotateY(0) scale(1);
          opacity: 1;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .phase-flash,
        .turn-banner,
        .security-flip {
          animation: none;
        }
      }
      @media (max-width: 767px) {
        .btn-play {
          min-height: 2.5rem;
        }
      }
      /* Short landscape: opponent strip becomes a left column (about 30% wide), own board takes the rest. */
      @media (max-height: 499px) {
        .main-col {
          flex-direction: row;
          gap: 0.5rem;
        }
        .opp-strip {
          width: 30%;
          height: auto;
          flex-direction: column;
          align-items: stretch;
        }
        .opp-strip .thumbs {
          flex-wrap: wrap;
          overflow: hidden;
        }
      }
    `,
  ],
})
export class PlaymatComponent implements OnInit {
  protected readonly session = inject(GameSession);
  private readonly router = inject(Router);
  private readonly store = inject(DigimonCardStore);
  private readonly match = inject(OnlineMatchService);

  protected readonly phases = PHASES;
  protected readonly memoryValues = MEMORY_VALUES;
  protected readonly memoryMax = MEMORY_MAX;
  protected readonly memoryMin = MEMORY_MIN;
  protected readonly payAmounts = [1, 2, 3, 4, 5];
  protected readonly gainAmounts = [1, 2, 3];
  protected readonly cardBack = CARD_BACK;
  protected readonly other = other;
  protected readonly topName = topName;

  protected readonly state = this.session.state;
  protected readonly bottom = this.session.viewer;
  protected readonly top = computed<PlayerIndex>(() => (this.bottom() === 0 ? 1 : 0));
  protected readonly force = this.session.force;
  protected readonly online = this.session.online;
  protected readonly showAll = signal(false);
  protected readonly logOpen = signal(false);
  protected readonly moreOpen = signal(false);
  protected readonly opponentOpen = signal(false);
  protected readonly menu = signal<OpenMenu | null>(null);

  /** Inline end-turn form. The memory value is for the next player (positive = their side). */
  protected readonly endTurnOpen = signal(false);
  protected readonly nextMemory = signal(DEFAULT_NEXT_MEMORY);

  /** Layout breakpoints. wide: desktop side column. compact: phone portrait or landscape (short height). */
  protected readonly wide = media('(min-width: 1024px)');
  protected readonly compact = media('(max-width: 767px), (max-height: 499px)');
  protected readonly canHover = media('(hover: hover) and (pointer: fine)');

  /** Pinned target from a click. Esc or a click outside a card or panel clears it. */
  protected readonly pinned = signal<MenuTarget | null>(null);
  /** Stack or card under the pointer, for the S shortcut. */
  private readonly hovered = signal<MenuTarget | null>(null);
  /** Card id whose hover preview is showing (after the delay). */
  private readonly hoverCardId = signal<string | null>(null);
  private readonly pointer = signal({ x: 0, y: 0 });
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly previewWidth = HOVER_WIDTH_PX;
  protected readonly previewHeight = Math.round(HOVER_WIDTH_PX * CARD_RATIO);

  // ---- table feedback --------------------------------------------------------------------------
  protected readonly flashPhase = signal<Phase | null>(null);
  protected readonly turnBanner = signal<string | null>(null);
  protected readonly securityFlash = signal<SecurityFlash | null>(null);
  protected readonly notices = signal<Notice[]>([]);
  /** The hand card being dragged (uid), for digivolve highlights. */
  protected readonly dragHandUid = signal<string | null>(null);
  /** The log entry whose "Rewind to here" is open. */
  protected readonly logSelected = signal<number | null>(null);
  /** The attack being aimed, or null. */
  private readonly targeting = signal<AttackPlan | null>(null);
  /** A solo game saved in this browser, offered on open. Null once resumed or discarded. */
  protected readonly savedGame = signal<SavedSoloGame | null>(null);

  /** Names for the reminder toasts and notices. */
  protected readonly names = computed<[string, string]>(() => {
    const s = this.state();
    return [s?.players[0].name ?? 'Player 1', s?.players[1].name ?? 'Player 2'];
  });
  protected readonly rulesLabel = computed(() => (this.state()?.mode === 'assisted' ? 'Assisted' : 'Manual'));

  /** The attack in progress, if its attacker is still on the board. */
  protected readonly activeTarget = computed<AttackPlan | null>(() => {
    const t = this.targeting();
    const s = this.state();
    if (!t || !s) return null;
    return getStack(s.players[t.owner], t.stackId) ? t : null;
  });
  protected readonly targetOwner = computed<PlayerIndex | null>(() => {
    const t = this.activeTarget();
    return t ? other(t.owner) : null;
  });
  /** Battle stacks of the attacked player that the attack may target right now. */
  protected readonly targetStackIds = computed<ReadonlySet<string>>(() => {
    const t = this.activeTarget();
    const s = this.state();
    const out = new Set<string>();
    if (!t || !s) return out;
    for (const st of s.players[other(t.owner)].battle) {
      if (assistedError(s, attackCmd(t, { kind: 'stack', stackId: st.stackId })) === null) out.add(st.stackId);
    }
    return out;
  });
  protected readonly playerTargetable = computed<boolean>(() => {
    const t = this.activeTarget();
    const s = this.state();
    return !!t && !!s && assistedError(s, attackCmd(t, { kind: 'player' })) === null;
  });
  protected readonly targetHint = computed<string | null>(() => {
    const t = this.activeTarget();
    if (!t) return null;
    if (this.targetStackIds().size === 0 && !this.playerTargetable()) {
      return 'No valid target right now. Suspended opponent Digimon and the opponent themselves can be attacked.';
    }
    const parts: string[] = [];
    if (this.targetStackIds().size > 0) parts.push('click a glowing opponent Digimon');
    if (this.playerTargetable()) parts.push("click the opponent's security pile or name");
    return `Choose a target: ${parts.join(', or ')}. Esc cancels.`;
  });

  /** The hand card the digivolve highlights are for: a dragged card, or the pinned one. */
  private readonly handPick = computed<string | null>(() => {
    const drag = this.dragHandUid();
    if (drag) return drag;
    const pin = this.pinned();
    return pin && pin.kind === 'card' && pin.zone === 'hand' && pin.owner === this.bottom() ? pin.uid : null;
  });
  /** Stacks of this device's board that the hand Digimon can digivolve onto, with the memory cost. */
  protected readonly digivolveCosts = computed<ReadonlyMap<string, number>>(() => {
    const out = new Map<string, number>();
    const s = this.state();
    const uid = this.handPick();
    if (!s || !uid || s.mode !== 'assisted') return out;
    const owner = this.bottom();
    const p = s.players[owner];
    const card = p.hand.find((c) => c.uid === uid);
    const info = card ? cardInfo(card.cardId) : undefined;
    if (!info || info.kind !== 'digimon') return out;
    for (const st of [...(p.breeding ? [p.breeding] : []), ...p.battle]) {
      const cost = digivolveCost(st, info);
      if (cost === null) continue;
      if (assistedError(s, { type: 'digivolve', player: owner, handUid: uid, onto: st.stackId }) === null) out.set(st.stackId, cost);
    }
    return out;
  });

  /** Outcome of a finished game: a winner (security, deck-out or resignation). */
  protected readonly outcome = computed<Outcome | null>(() => {
    const s = this.state();
    if (!s) return null;
    const local = this.session.localPlayer();
    const resigned = this.match.resignedBy();
    let winner: PlayerIndex | null = null;
    let reason = '';
    if (s.winner !== null && s.winner !== undefined) {
      winner = s.winner;
      reason = s.winReason ?? 'The game is over.';
    } else if (resigned !== null) {
      winner = other(resigned);
      reason = `${s.players[resigned].name} resigned.`;
    }
    if (winner === null) return null;
    if (local === null) return { headline: `${s.players[winner].name} wins`, reason };
    return { headline: winner === local ? 'Victory' : 'Defeat', reason };
  });

  /** What the current viewer may see. Opponent hidden info is redacted unless "show all" is on. */
  protected readonly display = computed<GameState | null>(() => {
    const s = this.state();
    if (!s) return null;
    return this.showAll() ? s : redactFor(s, this.bottom());
  });

  protected readonly hoverCard = computed(() => {
    const id = this.hoverCardId();
    return id ? (this.store.cardsMap().get(id) ?? null) : null;
  });

  protected readonly previewLeft = computed(() => {
    const { x } = this.pointer();
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const gap = 24;
    const right = x + gap;
    const left = right + this.previewWidth > vw - 8 ? x - gap - this.previewWidth : right;
    return Math.max(8, left);
  });

  protected readonly previewTop = computed(() => {
    const { y } = this.pointer();
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    return Math.min(Math.max(8, y - this.previewHeight / 2), vh - this.previewHeight - 8);
  });

  /** The pinned card or stack with the state it is shown against, or null when it is gone. */
  protected readonly pinnedInfo = computed(() => {
    const target = this.pinned();
    const s = this.display();
    if (!target || !s) return null;
    return targetExists(target, s) ? { target, state: s } : null;
  });

  private prevTurn: number | null = null;
  private prevPhase: Phase | null = null;
  private seenCombat: number | null = null;
  private lastErrorCount = this.session.errorCount();
  private noticeSeq = 0;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private securityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    setCardNameResolver((cardId) => this.store.cardsMap().get(cardId)?.name.english);
    // Assisted rules read card text, cost and colours from the same card list the board uses.
    effect(() => {
      const cards = [...this.store.cardsMap().values()] as unknown as Record<string, unknown>[];
      if (cards.length > 0) registerCardRecords(cards);
    });
    // Phase flash and turn banner on every change of the table.
    effect(() => {
      const s = this.state();
      if (s) untracked(() => this.onTableChange(s.turn, s.phase, s.activePlayer));
    });
    // Battle and security results.
    effect(() => {
      const combat = this.state()?.lastCombat ?? null;
      untracked(() => this.onCombat(combat));
    });
    // Rejections from the session, shown as toasts. Each rejection counts, so repeats still show.
    effect(() => {
      const count = this.session.errorCount();
      untracked(() => {
        if (count === this.lastErrorCount) return;
        this.lastErrorCount = count;
        const text = this.session.lastError();
        if (text) this.notice(text, 'error');
      });
    });
  }

  ngOnInit(): void {
    if (this.session.state()) return;
    const saved = loadSoloGame();
    if (saved) this.savedGame.set(saved);
    else void this.router.navigateByUrl('/play');
  }

  /** Resumes the solo game saved in this browser. */
  protected resumeSaved(): void {
    const saved = this.savedGame();
    if (!saved) return;
    this.session.resumeSolo(saved.state);
    this.savedGame.set(null);
  }

  protected discardSaved(): void {
    clearSoloGame();
    this.savedGame.set(null);
    void this.router.navigateByUrl('/play');
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (this.activeTarget()) {
        this.cancelAttack();
        return;
      }
      this.closeMenu();
      this.unpin();
      this.endTurnOpen.set(false);
      this.opponentOpen.set(false);
      this.moreOpen.set(false);
      return;
    }
    if (this.isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'z') {
      event.preventDefault();
      this.undo();
      return;
    }
    if (((event.ctrlKey || event.metaKey) && key === 'y') || ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'z')) {
      event.preventDefault();
      this.redo();
      return;
    }
    if (key === 's' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const target = this.pinned() ?? this.hovered();
      if (target?.kind === 'stack') {
        event.preventDefault();
        this.toggleSuspendTarget(target);
      }
    }
  }

  /** Clicks outside a card, the inspect panel or a menu clear the pin. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.pinned()) return;
    const el = event.target as Element | null;
    if (el?.closest?.('[data-keep-pin]')) return;
    this.unpin();
  }

  @HostListener('document:pointermove', ['$event'])
  onPointerMove(event: PointerEvent): void {
    this.pointer.set({ x: event.clientX, y: event.clientY });
  }

  act(cmd: Command): void {
    this.closeMenu();
    const before = this.state()?.phase;
    const accepted = this.session.applyLocal(cmd);
    const breedingAction = cmd.type === 'hatch' || cmd.type === 'moveBreedingToBattle';
    if (accepted && before === 'breeding' && breedingAction && this.state()?.phase === 'main') {
      this.notice('Breeding phase done → Main phase', 'info');
    }
  }

  /** Why Hatch cannot be used right now (assisted rules), or null when it can. */
  protected hatchReason(): string | null {
    const s = this.state();
    if (!s || s.mode !== 'assisted' || this.force()) return null;
    return assistedError(s, { type: 'hatch', player: this.bottom() });
  }

  /** A tap on something that is not a valid attack target. */
  protected onTargetMiss(): void {
    if (this.activeTarget()) this.notice('Not a valid target', 'error');
  }

  /** Quick action buttons. Same commands as the menus, one click. */
  quick(cmd: Command): void {
    this.moreOpen.set(false);
    this.act(cmd);
  }

  toggleForce(): void {
    this.session.setForce(!this.force());
  }

  undo(): void {
    this.closeMenu();
    this.session.undo();
  }

  redo(): void {
    this.closeMenu();
    this.session.redo();
  }

  /** Tooltip for the undo buttons: the reason when undo is blocked. */
  protected undoTitle(): string {
    return this.session.undoBlockReason() ?? 'Undo (Ctrl+Z)';
  }

  /** Tooltip for the redo buttons: the reason when redo is blocked. */
  protected redoTitle(): string {
    return this.session.redoBlockReason() ?? 'Redo (Ctrl+Y)';
  }

  /** Online each device answers only its own decisions. Solo answers for both seats. */
  protected canDecide(owner: PlayerIndex): boolean {
    const local = this.session.localPlayer();
    return local === null || local === owner;
  }

  protected resolveBlock(blockerStackId: string | null): void {
    const pending = this.session.state()?.pending;
    if (!pending || pending.kind !== 'block') return;
    this.act({ type: 'resolveBlock', player: pending.owner, blockerStackId });
  }

  protected findStack(s: GameState, owner: PlayerIndex, stackId: string): Stack | null {
    return getStack(s.players[owner], stackId);
  }

  protected dpOfStack(s: GameState, owner: PlayerIndex, stackId: string): number {
    const st = getStack(s.players[owner], stackId);
    return st ? stackDp(st) : 0;
  }

  protected cardImage(cardId: string): string {
    return this.store.cardsMap().get(cardId)?.cardImage || CARD_BACK;
  }

  /** Starts target selection for an attack with a battle Digimon. Blocked attacks say why. */
  protected beginAttack(target: MenuTarget): void {
    this.closeMenu();
    this.unpin();
    if (target.kind !== 'stack') return;
    const s = this.state();
    if (!s) return;
    const reason = attackReason(s, target.owner, target.stackId);
    if (reason) {
      this.notice(reason, 'error');
      return;
    }
    this.targeting.set({ owner: target.owner, stackId: target.stackId });
    if (this.compact()) this.opponentOpen.set(true);
  }

  protected cancelAttack(): void {
    this.targeting.set(null);
  }

  /** A valid target was clicked (stack id, or null for the player). Sends the attack. */
  protected onTargetPick(stackId: string | null): void {
    const t = this.activeTarget();
    if (!t) return;
    this.targeting.set(null);
    this.act(attackCmd(t, stackId === null ? { kind: 'player' } : { kind: 'stack', stackId }));
  }

  protected rematch(): void {
    this.targeting.set(null);
    this.logSelected.set(null);
    this.session.rematch();
  }

  protected backToLobby(): void {
    void this.router.navigateByUrl('/play');
  }

  protected rewindable(seq: number): boolean {
    return this.session.rewindTargetFor(seq) !== null;
  }

  protected selectLog(seq: number): void {
    this.logSelected.update((v) => (v === seq ? null : seq));
  }

  protected rewindHere(seq: number): void {
    if (this.session.rewindToLogEntry(seq)) {
      this.logSelected.set(null);
      this.notice('Rewound. Redo brings the steps back.', 'info');
    }
  }

  dismissNotice(id: number): void {
    this.notices.update((list) => list.filter((n) => n.id !== id));
  }

  nextPhase(): void {
    this.act({ type: 'nextPhase', player: this.bottom() });
  }

  /**
   * Assisted: the memory rule is automatic, so End turn passes at once (the next player gets 3 on their side, or the
   * gauge value that already sits there). Manual: opens the dialog, pre-filled from the gauge.
   */
  toggleEndTurn(): void {
    const s = this.state();
    if (s?.mode === 'assisted') {
      this.endTurnOpen.set(false);
      this.act({ type: 'passTurn', player: this.bottom() });
      return;
    }
    this.endTurnOpen.update((open) => !open);
    this.nextMemory.set(this.suggestedNextMemory());
  }

  /** Manual pass: the next player's gauge value. When the gauge already sits on their side, that value stays; else 3. */
  protected suggestedNextMemory(): number {
    const s = this.state();
    if (!s || s.memory >= 0) return DEFAULT_NEXT_MEMORY;
    return Math.max(MEMORY_MIN, Math.min(MEMORY_MAX, -s.memory));
  }

  /** One line under the Manual pass dialog's value, explaining where the pre-filled number comes from. */
  protected nextMemoryHint(): string {
    const s = this.state();
    if (!s) return '';
    const next = s.activePlayer === 0 ? 1 : 0;
    if (s.memory < 0) return `The gauge already sits on ${s.players[next].name}'s side at ${-s.memory}, so that value is pre-filled.`;
    return `Pre-filled with ${DEFAULT_NEXT_MEMORY}: ${s.players[next].name} starts on their side of the gauge.`;
  }

  confirmEndTurn(): void {
    const s = this.state();
    if (!s) return;
    const value = Math.max(MEMORY_MIN, Math.min(MEMORY_MAX, Math.round(this.nextMemory())));
    this.endTurnOpen.set(false);
    this.act({ type: 'passTurn', player: this.bottom(), memory: value });
  }

  toInt(raw: string): number {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  }

  setMemory(value: number): void {
    this.act({ type: 'setMemory', player: this.bottom(), value });
  }

  changeMemory(delta: number): void {
    this.act({ type: 'changeMemoryBy', player: this.bottom(), delta });
  }

  toggleShowAll(): void {
    this.showAll.update((v) => !v);
  }

  toLobby(): void {
    void this.router.navigateByUrl('/play');
  }

  phaseLabel(ph: Phase): string {
    return PHASE_LABELS[ph];
  }

  tokenPercent(memory: number): number {
    return ((memory - MEMORY_MIN) / (MEMORY_MAX - MEMORY_MIN)) * 100;
  }

  /** Online, only this device's board can be changed. Solo, both boards can. */
  canEdit(owner: PlayerIndex): boolean {
    return !this.session.online() || this.session.localPlayer() === owner;
  }

  /** Top card image for the compact opponent strip. Face-down stacks show the back. */
  thumb(stack: { faceDown?: boolean; cards: { cardId: string }[] }): string {
    const top = stack.cards[stack.cards.length - 1]?.cardId;
    if (stack.faceDown || !top || top === HIDDEN_CARD_ID) return this.cardBack;
    return this.store.cardsMap().get(top)?.cardImage || this.cardBack;
  }

  dpOf(stack: { faceDown?: boolean; dpMod?: number; tempDpMod?: number; cards: { cardId: string }[] }): string | null {
    if (stack.faceDown) return null;
    const top = stack.cards[stack.cards.length - 1]?.cardId;
    const base = Number.parseInt(top ? (this.store.cardsMap().get(top)?.dp ?? '') : '', 10);
    if (!Number.isFinite(base)) return null;
    return `${base + (stack.dpMod ?? 0) + (stack.tempDpMod ?? 0)}`;
  }

  onPreview(info: HoverInfo | null): void {
    this.hovered.set(info?.target ?? null);
    this.scheduleHover(info?.cardId ?? null);
  }

  pinTarget(target: MenuTarget): void {
    this.closeMenu();
    this.pinned.set(target);
  }

  unpin(): void {
    this.pinned.set(null);
  }

  openMenu(x: number, y: number, target: MenuTarget): void {
    const s = this.state();
    if (!s) return;
    this.hideHover();
    this.menu.set({ x, y, target, items: menuItemsFor(target, s, this.force()) });
  }

  closeMenu(): void {
    this.menu.set(null);
  }

  runItem(item: MenuItem): void {
    const m = this.menu();
    this.closeMenu();
    if (item.attack && m) {
      this.beginAttack(m.target);
      return;
    }
    if (item.inspect && m) {
      this.pinTarget(m.target);
      return;
    }
    if (item.cmd) this.act(item.cmd);
  }

  menuLeft(x: number): number {
    const max = typeof window !== 'undefined' ? window.innerWidth - 230 : x;
    return Math.max(4, Math.min(x, max));
  }

  menuTop(y: number): number {
    const max = typeof window !== 'undefined' ? window.innerHeight - 320 : y;
    return Math.max(4, Math.min(y, max));
  }

  /** Phase flash when the phase changes, turn banner when the turn changes. The first look only records. */
  private onTableChange(turn: number, phase: Phase, active: PlayerIndex): void {
    if (this.prevTurn === null || this.prevPhase === null) {
      this.prevTurn = turn;
      this.prevPhase = phase;
      return;
    }
    if (phase !== this.prevPhase) {
      this.flashPhase.set(phase);
      if (this.flashTimer !== null) clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => {
        this.flashTimer = null;
        this.flashPhase.set(null);
      }, PHASE_FLASH_MS);
    }
    if (turn !== this.prevTurn) {
      const viewer = this.session.localPlayer();
      const s = this.state();
      const text =
        viewer === null
          ? `${s?.players[active].name ?? 'Next player'}'s turn`
          : active === viewer
            ? 'Your turn'
            : "Opponent's turn";
      this.turnBanner.set(text);
      if (this.turnTimer !== null) clearTimeout(this.turnTimer);
      this.turnTimer = setTimeout(() => {
        this.turnTimer = null;
        this.turnBanner.set(null);
      }, TURN_BANNER_MS);
    }
    this.prevTurn = turn;
    this.prevPhase = phase;
  }

  /** A new battle result becomes a toast. A new security check is shown big on screen. Older results are skipped. */
  private onCombat(combat: CombatResult | null): void {
    if (!combat) return;
    if (this.seenCombat === null) {
      this.seenCombat = combat.seq;
      return;
    }
    if (combat.seq <= this.seenCombat) return;
    this.seenCombat = combat.seq;
    if (combat.kind === 'battle') {
      this.notice(this.battleText(combat), 'info');
      return;
    }
    this.showSecurity(combat);
  }

  private battleText(c: CombatResult): string {
    const dd = c.defenderDp ?? 0;
    let outcome: string;
    if (c.attackerDeleted && c.defenderDeleted) outcome = 'Both are deleted';
    else if (c.attackerDeleted) outcome = `${c.attackerName} is deleted`;
    else if (c.defenderDeleted) outcome = `${c.defenderName} is deleted`;
    else outcome = 'Neither is deleted';
    return `Battle: ${c.attackerName} (${c.attackerDp} DP) vs ${c.defenderName} (${dd} DP). ${outcome}.`;
  }

  private showSecurity(c: CombatResult): void {
    const cardId = c.revealedCardId ?? '';
    const kind = cardInfo(cardId)?.kind;
    const name = cardLabel(cardId);
    let lines: string[];
    if (c.defenderDp !== null) {
      lines = [
        `Security: ${name}, ${c.defenderDp} DP`,
        `Attacker: ${c.attackerName}, ${c.attackerDp} DP`,
        c.attackerDeleted ? `${c.attackerName} is deleted.` : `${c.attackerName} survives.`,
      ];
    } else {
      lines = [`Security: ${name} (${kind === 'option' ? 'Option' : 'Tamer'}). Its effect is in the reminders.`];
    }
    this.securityFlash.set({ cardId, lines });
    if (this.securityTimer !== null) clearTimeout(this.securityTimer);
    this.securityTimer = setTimeout(() => {
      this.securityTimer = null;
      this.securityFlash.set(null);
    }, SECURITY_FLASH_MS);
  }

  private notice(text: string, tone: 'error' | 'info'): void {
    const id = ++this.noticeSeq;
    this.notices.update((list) => [...list, { id, text, tone }].slice(-MAX_NOTICES));
    setTimeout(() => this.dismissNotice(id), NOTICE_MS);
  }

  private scheduleHover(cardId: string | null): void {
    if (this.hoverTimer !== null) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    if (!cardId) {
      this.hoverCardId.set(null);
      return;
    }
    if (this.hoverCardId() === cardId) return;
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      this.hoverCardId.set(cardId);
    }, HOVER_DELAY_MS);
  }

  private hideHover(): void {
    this.scheduleHover(null);
  }

  /** S on a stack: suspend or unsuspend it, for the board it belongs to. */
  private toggleSuspendTarget(target: MenuTarget): void {
    if (target.kind !== 'stack') return;
    const s = this.state();
    const stack = s ? getStack(s.players[target.owner], target.stackId) : null;
    if (!stack) return;
    this.act({ type: stack.suspended ? 'unsuspend' : 'suspend', player: target.owner, stackId: target.stackId });
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
  }
}
