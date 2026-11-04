import { NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DigimonCard } from '../../../../models';
import { HoloCard3dComponent } from '../../shared/holo-card-3d.component';
import { Command } from '../core/commands';
import { GameState, MEMORY_MAX, MEMORY_MIN, PHASES, Phase, PlayerIndex } from '../core/types';
import { redactFor } from '../core/view';
import { GameSession } from '../game-session.service';
import { menuItemsFor, MenuItem, MenuTarget } from './menu-items';
import { OnlineBarComponent } from './online-bar.component';
import { PlayerBoardComponent } from './player-board.component';

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

@Component({
  selector: 'digimon-playmat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [NgClass, RouterLink, PlayerBoardComponent, HoloCard3dComponent, OnlineBarComponent],
  template: `
    @if (state(); as s) {
      <div
        class="relative mx-auto flex h-[calc(var(--app-vh)-7.5rem)] w-full max-w-[120rem] flex-col gap-2 overflow-x-hidden overflow-y-auto px-2 py-2 md:h-[calc(var(--app-vh)-5rem)] md:px-4">
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
            <button type="button" class="btn-play btn-primary" (click)="endTurn()">End turn</button>
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

        @if (session.lastError(); as err) {
          <button
            type="button"
            class="absolute left-1/2 top-14 z-[500] -translate-x-1/2 rounded-lg border border-red-500/60 bg-red-950/90 px-3 py-1.5 text-xs text-red-100"
            (click)="session.lastError.set(null)">
            {{ err }}
          </button>
        }

        <div class="flex flex-1 gap-3">
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <!-- Opponent (top, mirrored) -->
            <digimon-player-board
              class="flex min-h-0 flex-1"
              [player]="display()!.players[top()]"
              [owner]="top()"
              [mirrored]="true"
              [active]="s.activePlayer === top()"
              (issue)="act($event)"
              (menu)="openMenu($event.x, $event.y, $event.target)"
              (preview)="previewCard.set($event)" />

            <!-- Memory gauge -->
            <div class="flex items-center gap-2 px-1">
              <span class="w-20 shrink-0 truncate text-right text-[10px] uppercase tracking-wide text-muted">{{
                s.players[top()].name
              }}</span>
              <div
                class="relative flex h-7 flex-1 overflow-hidden rounded-full border border-line bg-ink-2"
                role="group"
                aria-label="Memory gauge">
                @for (v of memoryValues; track v) {
                  <button
                    type="button"
                    class="relative h-full flex-1 border-0 bg-transparent p-0 text-[9px] text-muted transition-colors hover:bg-white/5 md:text-[10px]"
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
              <span class="w-20 shrink-0 truncate text-[10px] uppercase tracking-wide text-muted">{{ s.players[bottom()].name }}</span>
            </div>

            <!-- You (bottom) -->
            <digimon-player-board
              class="flex min-h-0 flex-1"
              [player]="display()!.players[bottom()]"
              [owner]="bottom()"
              [active]="s.activePlayer === bottom()"
              (issue)="act($event)"
              (menu)="openMenu($event.x, $event.y, $event.target)"
              (preview)="previewCard.set($event)" />
          </div>

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
        </div>

        <!-- Hover preview: non-interactive, so it never blocks the board -->
        @if (previewCard(); as card) {
          <div class="pointer-events-none fixed right-4 top-1/2 z-[300] -translate-y-1/2">
            <digimon-holo-card-3d [card]="card" [size]="previewSize" />
          </div>
        }

        <!-- Context menu -->
        @if (menu(); as m) {
          <div
            class="fixed inset-0 z-[600]"
            (click)="closeMenu()"
            (contextmenu)="$event.preventDefault(); closeMenu()"
            role="presentation"></div>
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
        gap: 0.35rem;
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
    `,
  ],
})
export class PlaymatComponent implements OnInit {
  protected readonly session = inject(GameSession);
  private readonly router = inject(Router);

  protected readonly phases = PHASES;
  protected readonly memoryValues = MEMORY_VALUES;
  protected readonly memoryMax = MEMORY_MAX;
  protected readonly previewSize = typeof window !== 'undefined' && window.innerWidth < 768 ? 150 : 230;

  protected readonly state = this.session.state;
  protected readonly bottom = this.session.viewer;
  protected readonly top = computed<PlayerIndex>(() => (this.bottom() === 0 ? 1 : 0));
  protected readonly showAll = signal(false);
  protected readonly logOpen = signal(false);
  protected readonly menu = signal<OpenMenu | null>(null);
  protected readonly previewCard = signal<DigimonCard | null>(null);

  /** What the current viewer may see. Opponent hidden info is redacted unless "show all" is on. */
  protected readonly display = computed<GameState | null>(() => {
    const s = this.state();
    if (!s) return null;
    return this.showAll() ? s : redactFor(s, this.bottom());
  });

  ngOnInit(): void {
    if (!this.session.state()) {
      void this.router.navigateByUrl('/play');
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.closeMenu();
      return;
    }
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'z' && !this.isTypingTarget(event.target)) {
      event.preventDefault();
      this.undo();
    }
  }

  act(cmd: Command): void {
    this.closeMenu();
    this.session.applyLocal(cmd);
  }

  undo(): void {
    this.closeMenu();
    this.session.undo();
  }

  nextPhase(): void {
    this.act({ type: 'nextPhase', player: this.bottom() });
  }

  endTurn(): void {
    const s = this.state();
    if (!s) return;
    const answer = window.prompt('Memory for the next player (-10 to 10, positive = their side).', '3');
    if (answer === null) return;
    const value = Number.parseInt(answer, 10);
    if (!Number.isFinite(value)) {
      this.session.lastError.set('Enter a whole number for memory.');
      return;
    }
    this.act({ type: 'passTurn', player: s.activePlayer, memory: value });
  }

  setMemory(value: number): void {
    this.act({ type: 'setMemory', player: this.bottom(), value });
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

  openMenu(x: number, y: number, target: MenuTarget): void {
    const s = this.state();
    if (!s) return;
    const items = menuItemsFor(target, s);
    this.menu.set({ x, y, target, items });
  }

  closeMenu(): void {
    this.menu.set(null);
  }

  runItem(item: MenuItem): void {
    const m = this.menu();
    this.closeMenu();
    if (item.promptMarker) {
      const name = window.prompt('Marker name')?.trim();
      if (!name) return;
      const owner = m?.target.owner ?? this.bottom();
      this.act({ type: 'addMarker', player: owner, stackId: item.promptMarker, marker: name });
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

  private isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
  }
}
