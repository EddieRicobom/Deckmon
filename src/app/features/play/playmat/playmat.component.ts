import { NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DigimonCardStore } from '../../../store/digimon-card.store';
import { Command } from '../core/commands';
import { allCards, getStack } from '../core/game';
import { setCardNameResolver } from '../core/labels';
import { GameState, MEMORY_MAX, MEMORY_MIN, PHASES, Phase, PlayerIndex } from '../core/types';
import { redactFor, HIDDEN_CARD_ID } from '../core/view';
import { GameSession } from '../game-session.service';
import { menuItemsFor, MenuItem, MenuTarget } from './menu-items';
import { InspectPanelComponent } from './inspect-panel.component';
import { OnlineBarComponent } from './online-bar.component';
import { HoverInfo, PlayerBoardComponent } from './player-board.component';

interface OpenMenu {
  x: number;
  y: number;
  target: MenuTarget;
  items: MenuItem[];
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

@Component({
  selector: 'digimon-playmat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [NgClass, RouterLink, PlayerBoardComponent, OnlineBarComponent, InspectPanelComponent],
  template: `
    @if (state(); as s) {
      <div
        class="relative mx-auto flex h-[calc(var(--app-vh)-7.5rem)] w-full max-w-[120rem] flex-col gap-2 overflow-x-hidden overflow-y-auto px-2 py-2 md:h-[calc(var(--app-vh)-5rem)] md:px-4"
        [class.pb-56]="pinned() && !wide()">
        <!-- Top bar -->
        <header class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-display text-lg font-semibold text-fg">Turn {{ s.turn }}</span>
          <span class="rounded bg-ink-2 px-2 py-0.5 text-xs text-muted"
            >Active: <b class="text-fg">{{ s.players[s.activePlayer].name }}</b></span
          >
          <nav class="flex flex-wrap gap-1" aria-label="Phases">
            @for (ph of phases; track ph) {
              <span
                class="rounded px-2 py-0.5 text-xs"
                [class.bg-accent]="ph === s.phase"
                [class.text-accent-ink]="ph === s.phase"
                [class.font-bold]="ph === s.phase"
                [class.bg-ink-2]="ph !== s.phase"
                [class.text-muted]="ph !== s.phase"
                >{{ phaseLabel(ph) }}</span
              >
            }
          </nav>
          <div class="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" class="btn-play" (click)="nextPhase()" [disabled]="s.phase === 'end'">Next phase</button>
            <button type="button" class="btn-play btn-primary" (click)="toggleEndTurn()" [attr.aria-expanded]="endTurnOpen()">End turn</button>
            <button type="button" class="btn-play" (click)="undo()" [disabled]="!session.canUndo()" title="Undo (Ctrl+Z)">
              <i class="pi pi-undo"></i> Undo
            </button>
            <button type="button" class="btn-play" (click)="toggleShowAll()" [attr.aria-pressed]="showAll()">
              {{ showAll() ? 'Hide opponent info' : 'Show all cards' }}
            </button>
            <button type="button" class="btn-play lg:hidden" (click)="logOpen.set(!logOpen())">Log</button>
            <button type="button" class="btn-play" (click)="toLobby()">Lobby</button>
          </div>
        </header>

        <digimon-online-bar />

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
            <span class="text-muted">Positive = their side of the gauge, from -10 to 10.</span>
            <div class="ml-auto flex gap-1.5">
              <button type="button" class="btn-play" (click)="endTurnOpen.set(false)">Cancel</button>
              <button type="submit" class="btn-play btn-primary">Pass turn</button>
            </div>
          </form>
        }

        <!-- Quick actions for your board -->
        <nav class="flex flex-wrap items-center gap-1.5" aria-label="Quick actions">
          <span class="mr-1 text-[10px] uppercase tracking-wide text-muted">Quick</span>
          <button type="button" class="btn-play" (click)="quick({ type: 'draw', player: bottom(), count: 1 })">Draw 1</button>
          <button type="button" class="btn-play" (click)="quick({ type: 'unsuspendAll', player: bottom() })">Unsuspend all</button>
          <button type="button" class="btn-play" (click)="quick({ type: 'hatch', player: bottom() })">Hatch</button>
          <button type="button" class="btn-play" (click)="quick({ type: 'revealSecurity', player: bottom(), position: 'top' })">
            Reveal top security
          </button>
          @if (s.turn === 1) {
            <button type="button" class="btn-play" (click)="quick({ type: 'mulligan', player: bottom() })">Mulligan</button>
          }
          <button type="button" class="btn-play" (click)="quick({ type: 'shuffleDeck', player: bottom(), zone: 'deck' })">Shuffle deck</button>
          <span class="mx-1 h-4 w-px bg-line" aria-hidden="true"></span>
          <button type="button" class="btn-play" (click)="quick({ type: 'flipCoin', player: bottom() })">Flip coin</button>
          <button type="button" class="btn-play" (click)="quick({ type: 'rollDice', player: bottom(), sides: 6 })">Roll d6</button>
        </nav>

        @if (session.lastError(); as err) {
          <button
            type="button"
            class="absolute left-1/2 top-14 z-[500] -translate-x-1/2 rounded-lg border border-red-500/60 bg-red-950/90 px-3 py-1.5 text-xs text-red-100"
            (click)="session.lastError.set(null)">
            {{ err }}
          </button>
        }

        <div class="flex min-h-0 flex-1 gap-3">
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <!-- Opponent: full board, or a compact strip on phones (tap to open the full board) -->
            @if (compact()) {
              <button
                type="button"
                class="flex w-full items-center gap-2 overflow-hidden rounded-xl border border-line bg-ink-1 p-2 text-left"
                (click)="opponentOpen.set(true)"
                [attr.aria-label]="'Open ' + s.players[top()].name + ' board'">
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-semibold text-fg">{{ s.players[top()].name }}</span>
                  <span class="block font-mono text-[10px] text-muted">
                    Hand {{ display()!.players[top()].hand.length }} · Deck {{ display()!.players[top()].deck.length }} · Sec
                    {{ s.players[top()].security.length }} · Trash {{ s.players[top()].trash.length }}
                  </span>
                </span>
                <span class="flex shrink-0 items-center gap-1 overflow-x-auto">
                  @for (st of display()!.players[top()].battle; track st.stackId) {
                    <span class="relative block w-9 shrink-0">
                      <img [src]="thumb(st)" alt="" class="block w-full rounded-[4%]" />
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
                (issue)="act($event)"
                (menu)="openMenu($event.x, $event.y, $event.target)"
                (preview)="onPreview($event)"
                (pin)="pinTarget($event)" />
            }

            <!-- Memory gauge -->
            <div class="flex flex-col gap-1 px-1">
              <div class="flex items-center gap-2">
                <span class="w-16 shrink-0 truncate text-right text-[10px] uppercase tracking-wide text-muted sm:w-20">{{
                  s.players[top()].name
                }}</span>
                <button type="button" class="btn-play px-2" (click)="changeMemory(-1)" aria-label="Memory minus one">−</button>
                <div
                  class="relative flex h-7 min-w-0 flex-1 overflow-hidden rounded-full border border-line bg-ink-2"
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
                        <span class="pointer-events-none">{{ v > 0 ? '+' + v : v }}</span>
                      }
                    </button>
                  }
                  <span
                    class="pointer-events-none absolute top-1/2 flex h-5 min-w-[1.75rem] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent px-1 font-mono text-[11px] font-bold text-accent-ink shadow"
                    [style.left.%]="tokenPercent(s.memory)">
                    {{ s.memory > 0 ? '+' + s.memory : s.memory }}
                  </span>
                </div>
                <button type="button" class="btn-play px-2" (click)="changeMemory(1)" aria-label="Memory plus one">+</button>
                <span class="w-16 shrink-0 truncate text-[10px] uppercase tracking-wide text-muted sm:w-20">{{ s.players[bottom()].name }}</span>
              </div>
              <div class="flex flex-wrap items-center gap-1.5 pl-16 text-[11px] sm:pl-20">
                <span class="text-muted">Active pays</span>
                @for (n of payAmounts; track n) {
                  <button type="button" class="btn-play px-2 py-0" (click)="changeMemory(-n)">Pay {{ n }}</button>
                }
                <span class="ml-2 text-muted">Gains</span>
                @for (n of gainAmounts; track n) {
                  <button type="button" class="btn-play px-2 py-0" (click)="changeMemory(n)">Gain {{ n }}</button>
                }
                @if (s.memory < 0 && !endTurnOpen()) {
                  <button type="button" class="btn-play btn-hint" (click)="toggleEndTurn()">Memory crossed to their side: pass turn?</button>
                }
              </div>
            </div>

            <!-- You (bottom) -->
            <digimon-player-board
              class="flex min-h-0 flex-1"
              [player]="display()!.players[bottom()]"
              [owner]="bottom()"
              [active]="s.activePlayer === bottom()"
              (issue)="act($event)"
              (menu)="openMenu($event.x, $event.y, $event.target)"
              (preview)="onPreview($event)"
              (pin)="pinTarget($event)" />
          </div>

          <!-- Wide screens: pinned card above the log, in the side column -->
          @if (wide() && pinnedInfo(); as pin) {
            <aside class="flex w-[22rem] shrink-0 flex-col gap-2 overflow-hidden rounded-xl border border-line bg-ink-1 p-3 text-xs">
              <div class="min-h-0 flex-[3] overflow-y-auto pr-1">
                <digimon-inspect-panel
                  [target]="pin.target"
                  [state]="pin.state"
                  [editable]="canEdit(pin.target.owner)"
                  (issue)="act($event)"
                  (closed)="unpin()" />
              </div>
              <div class="flex min-h-0 flex-[2] flex-col gap-2 border-t border-line pt-2">
                <ol class="m-0 flex min-h-0 flex-1 list-none flex-col-reverse gap-1 overflow-y-auto p-0">
                  @for (entry of s.log; track entry.seq) {
                    <li class="border-b border-line/50 pb-1 text-muted">
                      <span class="font-mono text-[10px] text-accent">T{{ entry.turn }}</span>
                      <span class="text-fg"> {{ entry.text }}</span>
                    </li>
                  }
                </ol>
              </div>
            </aside>
          } @else {
            <!-- Log: side panel on large screens, drawer otherwise -->
            <aside
              class="flex w-64 shrink-0 flex-col gap-2 rounded-xl border border-line bg-ink-1 p-2 text-xs"
              [ngClass]="logOpen() ? 'fixed bottom-2 right-2 top-2 z-[400] w-72' : 'hidden lg:flex'">
              <div class="flex items-center justify-between">
                <span class="font-semibold text-fg">Log</span>
                <span class="text-muted">{{ s.log.length }} entries</span>
              </div>
              <ol class="m-0 flex min-h-0 flex-1 list-none flex-col-reverse gap-1 overflow-y-auto p-0">
                @for (entry of s.log; track entry.seq) {
                  <li class="border-b border-line/50 pb-1 text-muted">
                    <span class="font-mono text-[10px] text-accent">T{{ entry.turn }}</span>
                    <span class="text-fg"> {{ entry.text }}</span>
                  </li>
                }
              </ol>
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
              (issue)="act($event)"
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
              (issue)="act($event)"
              (menu)="openMenu($event.x, $event.y, $event.target)"
              (preview)="onPreview($event)"
              (pin)="pinTarget($event)" />
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
                    class="block w-full rounded px-2 py-1.5 text-left hover:bg-white/10"
                    [class.text-red-300]="item.danger"
                    [class.text-fg]="!item.danger"
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
    } @else {
      <div class="flex h-[calc(var(--app-vh)-7.5rem)] flex-col items-center justify-center gap-3 p-6 text-center">
        <p class="m-0 text-muted">No game in progress.</p>
        <a routerLink="/play" class="btn-play btn-primary no-underline">Start a game</a>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
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
      @media (max-width: 767px) {
        .btn-play {
          min-height: 2.5rem;
        }
      }
    `,
  ],
})
export class PlaymatComponent implements OnInit {
  protected readonly session = inject(GameSession);
  private readonly router = inject(Router);
  private readonly store = inject(DigimonCardStore);

  protected readonly phases = PHASES;
  protected readonly memoryValues = MEMORY_VALUES;
  protected readonly memoryMax = MEMORY_MAX;
  protected readonly memoryMin = MEMORY_MIN;
  protected readonly payAmounts = [1, 2, 3, 4, 5];
  protected readonly gainAmounts = [1, 2, 3];
  protected readonly cardBack = 'assets/images/digimon-card-back.webp';

  protected readonly state = this.session.state;
  protected readonly bottom = this.session.viewer;
  protected readonly top = computed<PlayerIndex>(() => (this.bottom() === 0 ? 1 : 0));
  protected readonly showAll = signal(false);
  protected readonly logOpen = signal(false);
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

  constructor() {
    setCardNameResolver((cardId) => this.store.cardsMap().get(cardId)?.name.english);
  }

  ngOnInit(): void {
    if (!this.session.state()) {
      void this.router.navigateByUrl('/play');
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.closeMenu();
      this.unpin();
      this.endTurnOpen.set(false);
      this.opponentOpen.set(false);
      return;
    }
    if (this.isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'z') {
      event.preventDefault();
      this.undo();
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
    this.session.applyLocal(cmd);
  }

  /** Quick action buttons. Same commands as the menus, one click. */
  quick(cmd: Command): void {
    this.act(cmd);
  }

  undo(): void {
    this.closeMenu();
    this.session.undo();
  }

  nextPhase(): void {
    this.act({ type: 'nextPhase', player: this.bottom() });
  }

  toggleEndTurn(): void {
    this.endTurnOpen.update((open) => !open);
    this.nextMemory.set(DEFAULT_NEXT_MEMORY);
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
    this.menu.set({ x, y, target, items: menuItemsFor(target, s) });
  }

  closeMenu(): void {
    this.menu.set(null);
  }

  runItem(item: MenuItem): void {
    const m = this.menu();
    this.closeMenu();
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
