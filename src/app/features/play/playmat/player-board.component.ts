import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, inject, input } from '@angular/core';
import { DigimonCardStore } from '../../../store/digimon-card.store';
import { Command } from '../core/commands';
import { PlayerIndex, PlayerState, Stack, StackZone, Zone } from '../core/types';
import { HIDDEN_CARD_ID } from '../core/view';
import { MenuTarget } from './menu-items';
import { PlayCardComponent, PlayStackComponent } from './play-card.component';

/** Where a drop can land. `stackId` is set for the individual stacks inside the battle area. */
export interface DropData {
  owner: PlayerIndex;
  zone: Zone;
  stackId?: string;
}

/** What is being dragged: a loose card, or a whole stack. */
export type DragData =
  { kind: 'card'; owner: PlayerIndex; uid: string; from: Zone } | { kind: 'stack'; owner: PlayerIndex; stackId: string; from: StackZone };

const LONG_PRESS_MS = 450;
/** Pointer travel in px above which a press counts as a drag, so its click does not pin. */
const DRAG_SLOP_PX = 6;
/** Deck counts at or below this are shown as a warning. */
const DECK_WARN_AT = 5;

/**
 * A battle stack dragged onto the opponent's board: onto one of their battle stacks, or onto their security pile.
 * The engine checks the rest (suspended target, eligible attacker, turn). Null for any other drop.
 */
export function attackForDrop(drag: DragData, target: DropData): Command | null {
  if (drag.kind !== 'stack' || drag.from !== 'battle' || drag.owner === target.owner) return null;
  if (target.zone === 'security') {
    return { type: 'attack', player: drag.owner, attackerStackId: drag.stackId, target: { kind: 'player' } };
  }
  if (target.zone === 'battle' && target.stackId) {
    return { type: 'attack', player: drag.owner, attackerStackId: drag.stackId, target: { kind: 'stack', stackId: target.stackId } };
  }
  return null;
}

/** What the pointer is over: the visible card id (null when hidden) and the stack or card it belongs to. */
export interface HoverInfo {
  cardId: string | null;
  target: MenuTarget;
}
const HAND_OVERLAP = 'calc(var(--cw) * -0.42)';

/**
 * Translates a drag and drop into a core command. Returns null when the drop does nothing.
 * Kept free of Angular so the mapping can be reasoned about (and tested) on its own.
 */
export function commandForDrop(drag: DragData, target: DropData): Command | null {
  if (drag.owner !== target.owner) return null;
  const player = drag.owner;

  if (drag.kind === 'stack') {
    switch (target.zone) {
      case 'trash':
        return { type: 'trashStack', player, stackId: drag.stackId };
      case 'hand':
        return { type: 'returnToHand', player, stackId: drag.stackId };
      case 'deck':
        return { type: 'stackToDeck', player, stackId: drag.stackId, position: 'top' };
      case 'battle':
        return drag.from === 'breeding' && !target.stackId ? { type: 'moveBreedingToBattle', player } : null;
      default:
        return null;
    }
  }

  const uid = drag.uid;
  if (target.stackId) {
    // Only hand cards can digivolve, and only onto a battle or breeding stack.
    const onStack = target.zone === 'battle' || target.zone === 'breeding';
    return onStack && drag.from === 'hand' ? { type: 'digivolve', player, handUid: uid, onto: target.stackId } : null;
  }
  if (drag.from === target.zone) return null;

  switch (target.zone) {
    case 'battle':
    case 'tamer':
    case 'option':
      return drag.from === 'hand'
        ? { type: 'playFromHand', player, uid, to: target.zone }
        : { type: 'moveCard', player, uid, to: target.zone };
    case 'security':
      return { type: 'moveCard', player, uid, to: 'security', position: 'top', faceUp: false };
    case 'deck':
    case 'eggDeck':
      return { type: 'moveCard', player, uid, to: target.zone, position: 'top' };
    default:
      return { type: 'moveCard', player, uid, to: target.zone };
  }
}

@Component({
  selector: 'digimon-player-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [NgTemplateOutlet, CdkDropList, CdkDrag, PlayCardComponent, PlayStackComponent],
  template: `
    <section
      class="board-section flex flex-1 flex-col gap-2 rounded-xl border bg-ink-1 p-2 transition-colors md:p-3"
      [class.border-accent]="active()"
      [class.border-line]="!active()">
      <header class="flex items-center justify-between gap-2 text-xs text-muted" [class.flex-row-reverse]="mirrored()">
        <span class="flex items-center gap-2 font-semibold text-fg" [class.target-ok]="playerTargetable()" (click)="pickPlayer()">
          <span class="rounded bg-ink-2 px-2 py-0.5 font-mono">P{{ owner() + 1 }}</span>
          {{ player().name }}
          @if (active()) {
            <span class="rounded bg-accent px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent-ink">Active</span>
          }
        </span>
        <span class="flex flex-wrap items-center justify-end gap-x-2 font-mono">
          <span>Hand {{ player().hand.length }}</span>
          <span
            [class.text-amber-300]="deckWarn()"
            [class.text-red-400]="player().deck.length === 0"
            [class.font-bold]="deckWarn() || player().deck.length === 0"
            >Deck {{ player().deck.length }}</span
          >
          <span>Egg {{ player().eggDeck.length }}</span>
          <span>Trash {{ player().trash.length }}</span>
          <span>Security {{ player().security.length }}</span>
        </span>
      </header>

      <div class="flex gap-2 md:gap-3" [class.flex-row-reverse]="mirrored()">
        <!-- Left: security and trash -->
        <div class="flex shrink-0 flex-col gap-2">
          <div class="zone-label">Security {{ player().security.length }}</div>
          <div
            cdkDropList
            [cdkDropListData]="dropData('security')"
            (cdkDropListDropped)="onDrop($event)"
            (click)="pickPlayer()"
            class="zone-slot"
            [class.target-ok]="playerTargetable()">
            @if (securityTop(); as sec) {
              <div
                cdkDrag
                [cdkDragData]="cardDrag(sec.uid, 'security')"
                class="cursor-grab"
                data-keep-pin
                (pointerdown)="press($event, cardTarget(sec.uid, 'security'))"
                (pointerup)="release()"
                (pointerleave)="release()"
                (pointercancel)="release()"
                (cdkDragStarted)="release()"
                (contextmenu)="ctx($event, cardTarget(sec.uid, 'security'))"
                (click)="sec.faceUp && pinClick($event, cardTarget(sec.uid, 'security'))"
                (mouseenter)="hover(sec.faceUp ? sec.cardId : null, cardTarget(sec.uid, 'security'))"
                (mouseleave)="hover(null)">
                <digimon-play-card [cardId]="sec.faceUp ? sec.cardId : hiddenId" [faceDown]="!sec.faceUp" />
              </div>
            } @else {
              <div class="empty-slot" (contextmenu)="ctx($event, pileTarget('security'))">Empty</div>
            }
          </div>
          <div class="zone-label">Trash {{ player().trash.length }}</div>
          <div cdkDropList [cdkDropListData]="dropData('trash')" (cdkDropListDropped)="onDrop($event)" class="zone-slot">
            @if (trashTop(); as t) {
              <div
                cdkDrag
                [cdkDragData]="cardDrag(t.uid, 'trash')"
                data-keep-pin
                (pointerdown)="press($event, cardTarget(t.uid, 'trash'))"
                (pointerup)="release()"
                (pointerleave)="release()"
                (cdkDragStarted)="release()"
                (contextmenu)="ctx($event, cardTarget(t.uid, 'trash'))"
                (click)="pinClick($event, cardTarget(t.uid, 'trash'))"
                (mouseenter)="hover(t.cardId, cardTarget(t.uid, 'trash'))"
                (mouseleave)="hover(null)">
                <digimon-play-card [cardId]="t.cardId" />
              </div>
            } @else {
              <div class="empty-slot">Empty</div>
            }
          </div>
        </div>

        <!-- Centre: breeding, tamers / options, battle area -->
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div class="flex gap-2 md:gap-3" [class.flex-row-reverse]="mirrored()">
            <div class="flex shrink-0 flex-col gap-1">
              <div class="zone-label">Breeding</div>
              <div
                cdkDropList
                [cdkDropListData]="player().breeding ? dropData('breeding', player().breeding!.stackId) : dropData('breeding')"
                (cdkDropListDropped)="onDrop($event)"
                class="zone-slot">
                @if (player().breeding; as b) {
                  <ng-container *ngTemplateOutlet="stackTpl; context: { $implicit: b, zone: 'breeding' }" />
                } @else {
                  <div class="empty-slot">Egg</div>
                }
              </div>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <div class="zone-label">Tamers / Options</div>
              <div class="flex flex-wrap gap-2">
                <div
                  cdkDropList
                  [cdkDropListData]="dropData('tamer')"
                  (cdkDropListDropped)="onDrop($event)"
                  class="zone-row min-h-[calc(var(--cw)*1.4)] flex-1">
                  @for (s of player().tamer; track s.stackId) {
                    <ng-container *ngTemplateOutlet="stackTpl; context: { $implicit: s, zone: 'tamer' }" />
                  }
                  @if (player().tamer.length === 0) {
                    <div class="empty-slot">Tamer</div>
                  }
                </div>
                <div
                  cdkDropList
                  [cdkDropListData]="dropData('option')"
                  (cdkDropListDropped)="onDrop($event)"
                  class="zone-row min-h-[calc(var(--cw)*1.4)] flex-1">
                  @for (s of player().option; track s.stackId) {
                    <ng-container *ngTemplateOutlet="stackTpl; context: { $implicit: s, zone: 'option' }" />
                  }
                  @if (player().option.length === 0) {
                    <div class="empty-slot">Option</div>
                  }
                </div>
              </div>
            </div>
          </div>

          <div class="zone-label">Battle area</div>
          <div
            cdkDropList
            [cdkDropListData]="dropData('battle')"
            (cdkDropListDropped)="onDrop($event)"
            class="zone-row battle-row min-h-[calc(var(--cw)*1.6)] flex-1 gap-3">
            @for (s of player().battle; track s.stackId) {
              <div
                cdkDropList
                [cdkDropListData]="dropData('battle', s.stackId)"
                (cdkDropListDropped)="onDrop($event)"
                class="shrink-0 rounded-lg"
                [class.target-ok]="targetStackIds().has(s.stackId)"
                [class.target-dim]="targeting() && !targetStackIds().has(s.stackId)">
                <ng-container *ngTemplateOutlet="stackTpl; context: { $implicit: s, zone: 'battle' }" />
              </div>
            }
            @if (player().battle.length === 0) {
              <div class="empty-slot">Drop Digimon here</div>
            }
          </div>
        </div>

        <!-- Right: deck and egg deck side by side, reveal underneath -->
        <div class="flex shrink-0 flex-col gap-1">
          <div class="flex gap-1.5">
            <div class="flex flex-col gap-0.5">
              <div class="zone-label">Deck {{ player().deck.length }}</div>
              <div
                cdkDropList
                [cdkDropListData]="dropData('deck')"
                (cdkDropListDropped)="onDrop($event)"
                class="zone-slot"
                (contextmenu)="ctx($event, pileTarget('deck'))"
                (pointerdown)="press($event, pileTarget('deck'))"
                (pointerup)="release()"
                (pointerleave)="release()">
                @if (player().deck.length) {
                  <digimon-play-card [cardId]="hiddenId" [faceDown]="true" />
                } @else {
                  <div class="empty-slot">Empty</div>
                }
              </div>
            </div>
            <div class="flex flex-col gap-0.5">
              <div class="zone-label">Egg {{ player().eggDeck.length }}</div>
              <div
                cdkDropList
                [cdkDropListData]="dropData('eggDeck')"
                (cdkDropListDropped)="onDrop($event)"
                class="zone-slot"
                (contextmenu)="ctx($event, pileTarget('eggDeck'))"
                (pointerdown)="press($event, pileTarget('eggDeck'))"
                (pointerup)="release()"
                (pointerleave)="release()">
                @if (player().eggDeck.length) {
                  <digimon-play-card [cardId]="hiddenId" [faceDown]="true" />
                } @else {
                  <div class="empty-slot">Empty</div>
                }
              </div>
            </div>
          </div>
          <div class="zone-label">Reveal {{ player().reveal.length }}</div>
          <div cdkDropList [cdkDropListData]="dropData('reveal')" (cdkDropListDropped)="onDrop($event)" class="zone-slot">
            @if (revealTop(); as r) {
              <div
                cdkDrag
                [cdkDragData]="cardDrag(r.uid, 'reveal')"
                data-keep-pin
                (pointerdown)="press($event, cardTarget(r.uid, 'reveal'))"
                (pointerup)="release()"
                (pointerleave)="release()"
                (cdkDragStarted)="release()"
                (contextmenu)="ctx($event, cardTarget(r.uid, 'reveal'))"
                (click)="pinClick($event, cardTarget(r.uid, 'reveal'))"
                (mouseenter)="hover(r.cardId, cardTarget(r.uid, 'reveal'))"
                (mouseleave)="hover(null)">
                <digimon-play-card [cardId]="r.cardId" />
              </div>
            } @else {
              <div class="empty-slot">Empty</div>
            }
          </div>
        </div>
      </div>

      <!-- Hand -->
      <div class="zone-label">Hand {{ player().hand.length }}</div>
      <div
        cdkDropList
        cdkDropListOrientation="horizontal"
        [cdkDropListSortingDisabled]="true"
        [cdkDropListData]="dropData('hand')"
        (cdkDropListDropped)="onDrop($event)"
        class="hand-row flex items-end justify-center overflow-visible">
        @for (c of player().hand; track c.uid; let i = $index) {
          <div
            cdkDrag
            [cdkDragData]="cardDrag(c.uid, 'hand')"
            class="relative cursor-grab transition-transform duration-150 hover:-translate-y-3 hover:z-50"
            [style.margin-left]="i === 0 ? '0px' : handOverlap"
            [style.z-index]="i + 1"
            data-keep-pin
            (pointerdown)="press($event, cardTarget(c.uid, 'hand'))"
            (pointerup)="release()"
            (pointerleave)="release()"
            (pointercancel)="release()"
            (cdkDragStarted)="release(); dragHand.emit(c.uid)"
            (cdkDragEnded)="dragHand.emit(null)"
            (contextmenu)="ctx($event, cardTarget(c.uid, 'hand'))"
            (mouseenter)="hover(c.cardId, cardTarget(c.uid, 'hand'))"
            (mouseleave)="hover(null)"
            (click)="pinClick($event, cardTarget(c.uid, 'hand'))">
            <digimon-play-card [cardId]="c.cardId" />
          </div>
        }
      </div>
    </section>

    <!-- Shared stack template: a stack is clickable (toggles suspend) and long-press / right-click opens its menu -->
    <ng-template #stackTpl let-s let-zone="zone">
      <div
        cdkDrag
        [cdkDragData]="stackDrag(s, zone)"
        class="relative cursor-pointer rounded-lg"
        data-keep-pin
        [class.digi-ok]="digivolveCosts().has(s.stackId)"
        (click)="pinClick($event, stackTarget(s.stackId, zone))"
        (dblclick)="toggleSuspend(s)"
        (pointerdown)="press($event, stackTarget(s.stackId, zone))"
        (pointerup)="release()"
        (pointerleave)="release()"
        (pointercancel)="release()"
        (cdkDragStarted)="release()"
        (contextmenu)="ctx($event, stackTarget(s.stackId, zone))"
        (mouseenter)="hover(s.faceDown ? null : topOf(s), stackTarget(s.stackId, zone))"
        (mouseleave)="hover(null)">
        <digimon-play-stack [stack]="s" />
        @if (digivolveCosts().get(s.stackId); as cost) {
          <span class="digi-badge">Digivolve {{ cost }}</span>
        }
      </div>
    </ng-template>
  `,
  styles: [
    `
      :host {
        --cw: clamp(1.9rem, min(5.6vh, 8vw), 5.25rem);
        display: flex;
        min-height: 0;
        flex: 1 1 auto;
      }
      :host section {
        width: 100%;
      }
      /* Hand row reserves its full height: cards, the hover lift (in the top padding) and nothing below. */
      .hand-row {
        box-sizing: border-box;
        height: calc(var(--cw) * 1.4 + 1rem);
        padding: 0.75rem 0.25rem 0.25rem;
      }
      .hand-row > * {
        height: calc(var(--cw) * 1.4);
      }
      .zone-label {
        font-size: 0.6rem;
        line-height: 1;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--dc-muted, #94a3b8);
      }
      .zone-slot {
        width: var(--cw);
        min-height: calc(var(--cw) * 1.4);
        position: relative;
        border-radius: 0.5rem;
      }
      .zone-row {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        padding: 0.25rem;
        border-radius: 0.5rem;
        flex-wrap: wrap;
        align-content: flex-start;
      }
      .empty-slot {
        display: flex;
        align-items: center;
        justify-content: center;
        width: var(--cw);
        aspect-ratio: 63 / 88;
        border: 1px dashed rgba(148, 163, 184, 0.35);
        border-radius: 0.5rem;
        font-size: 0.6rem;
        color: rgba(148, 163, 184, 0.7);
        text-align: center;
        padding: 0.2rem;
      }
      .cdk-drag-preview {
        opacity: 0.9;
        pointer-events: none;
      }
      /* Target selection (attack): valid targets glow, the rest dim. */
      .target-ok {
        outline: 2px solid var(--dc-accent, #38bdf8);
        outline-offset: 2px;
        border-radius: 0.5rem;
        animation: target-pulse 1.2s ease-in-out infinite;
        cursor: crosshair;
      }
      .target-dim {
        opacity: 0.45;
      }
      /* Digivolve targets for the Digimon in hand (pinned or dragged). */
      .digi-ok {
        box-shadow: 0 0 0 2px var(--dc-accent, #38bdf8);
      }
      .digi-badge {
        position: absolute;
        top: -0.35rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 5;
        white-space: nowrap;
        border-radius: 999px;
        background: var(--dc-accent, #38bdf8);
        color: var(--dc-accent-ink, #0f172a);
        padding: 0 0.4rem;
        font-size: 0.6rem;
        font-weight: 700;
        line-height: 1.2rem;
        pointer-events: none;
      }
      @keyframes target-pulse {
        0%,
        100% {
          outline-color: var(--dc-accent, #38bdf8);
        }
        50% {
          outline-color: transparent;
        }
      }
      .cdk-drag-placeholder {
        opacity: 0.25;
      }
      .cdk-drop-list-dragging .cdk-drag {
        transition: transform 150ms;
      }
      /*
       * Phone portrait and short landscape: piles are small (44px wide, 62px tall), battle cards are wide enough to
       * read their DP, the hand is a scrollable tray at the bottom. The board area scrolls if it still runs out of room.
       */
      @media (max-width: 767px), (max-height: 499px) {
        :host {
          --cw: 2.75rem;
        }
        .board-section {
          min-height: 0;
          overflow-y: auto;
        }
        .battle-row {
          flex-wrap: nowrap;
          overflow-x: auto;
          scroll-snap-type: x mandatory;
          --cw: 6.25rem;
        }
        .battle-row > * {
          scroll-snap-align: start;
          flex-shrink: 0;
        }
        .hand-row {
          --cw: 5rem;
          justify-content: flex-start;
          overflow-x: auto;
          scroll-snap-type: x proximity;
        }
        .hand-row > * {
          scroll-snap-align: center;
          flex-shrink: 0;
        }
      }
      /* Short landscape: scale every size to the height so a phone on its side still fits the board. */
      @media (max-height: 499px) {
        :host {
          --cw: min(2.75rem, 10.5vh);
        }
        .battle-row {
          --cw: min(6.25rem, 19vh);
        }
        .hand-row {
          --cw: min(5rem, 15vh);
        }
      }
    `,
  ],
})
export class PlayerBoardComponent {
  readonly player = input.required<PlayerState>();
  readonly owner = input.required<PlayerIndex>();
  readonly mirrored = input(false);
  readonly active = input(false);
  /** Attack target selection is running: valid stacks and the player are highlighted and clicks pick them. */
  readonly targeting = input(false);
  /** Battle stacks on this board that are valid attack targets while targeting. */
  readonly targetStackIds = input<ReadonlySet<string>>(new Set());
  /** True when this board's player can be attacked directly (while targeting). */
  readonly playerTargetable = input(false);
  /** Stacks on this board that a Digimon in hand can digivolve onto, with the memory cost. */
  readonly digivolveCosts = input<ReadonlyMap<string, number>>(new Map());

  /** Emitted for every board action, already translated into a core command. */
  @Output() readonly issue = new EventEmitter<Command>();
  /** Emitted on right-click or long-press with the target to build a menu for. */
  @Output() readonly menu = new EventEmitter<{ x: number; y: number; target: MenuTarget }>();
  /** Emitted when the pointer enters or leaves a stack or card. cardId is null for hidden cards. */
  @Output() readonly preview = new EventEmitter<HoverInfo | null>();
  /** Emitted on a click (not a drag) on a visible card or stack. The playmat pins it in the inspect panel. */
  @Output() readonly pin = new EventEmitter<MenuTarget>();
  /** Target chosen while targeting: a stack id, or null for the player. */
  @Output() readonly targetPick = new EventEmitter<string | null>();
  /** A hand card drag started (uid) or ended (null). */
  @Output() readonly dragHand = new EventEmitter<string | null>();

  protected readonly hiddenId = HIDDEN_CARD_ID;
  protected readonly handOverlap = HAND_OVERLAP;
  private readonly cards = inject(DigimonCardStore);
  private readonly memo = new Map<string, unknown>();
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;
  private pressX = 0;
  private pressY = 0;

  readonly securityTop = computed(() => {
    const sec = this.player().security;
    return sec[sec.length - 1] ?? null;
  });
  readonly trashTop = computed(() => {
    const t = this.player().trash;
    return t[t.length - 1] ?? null;
  });
  readonly revealTop = computed(() => {
    const r = this.player().reveal;
    return r[r.length - 1] ?? null;
  });

  dropData(zone: Zone, stackId?: string): DropData {
    return this.cached(`drop:${zone}:${stackId ?? ''}`, () => ({ owner: this.owner(), zone, stackId }));
  }

  cardDrag(uid: string, from: Zone): DragData {
    return this.cached(`drag:card:${uid}:${from}`, () => ({ kind: 'card', owner: this.owner(), uid, from }) as DragData);
  }

  stackDrag(stack: Stack, from: unknown): DragData {
    const zone = from as StackZone;
    return this.cached(
      `drag:stack:${stack.stackId}:${zone}`,
      () => ({ kind: 'stack', owner: this.owner(), stackId: stack.stackId, from: zone }) as DragData,
    );
  }

  onDrop(event: CdkDragDrop<DropData, DropData, DragData>): void {
    if (event.previousContainer === event.container) return;
    const drag = event.item.data as DragData;
    const cmd = commandForDrop(drag, event.container.data) ?? attackForDrop(drag, event.container.data);
    if (cmd) this.issue.emit(cmd);
  }

  /** Double-click on a stack toggles suspend. A single click pins the stack instead. */
  toggleSuspend(stack: Stack): void {
    if (this.targeting()) return;
    this.issue.emit({ type: stack.suspended ? 'unsuspend' : 'suspend', player: this.owner(), stackId: stack.stackId });
  }

  /** Attack target click on the player (security pile or name). Ignored unless this board can be attacked. */
  pickPlayer(): void {
    if (this.targeting() && this.playerTargetable()) this.targetPick.emit(null);
  }

  /**
   * A click pins the target. Ignored after a long-press (the menu is open) or when the pointer moved (a drag).
   * While targeting, a click picks a valid target instead and never pins.
   */
  pinClick(event: MouseEvent, target: MenuTarget): void {
    if (this.targeting()) {
      event.stopPropagation();
      if (target.kind === 'stack' && this.targetStackIds().has(target.stackId)) this.targetPick.emit(target.stackId);
      if (target.kind === 'card' && target.zone === 'security' && this.playerTargetable()) this.targetPick.emit(null);
      return;
    }
    if (this.longPressed) {
      this.longPressed = false;
      return;
    }
    if (Math.hypot(event.clientX - this.pressX, event.clientY - this.pressY) > DRAG_SLOP_PX) return;
    this.pin.emit(target);
  }

  cardTarget(uid: string, zone: Zone): MenuTarget {
    return { kind: 'card', owner: this.owner(), uid, zone };
  }

  stackTarget(stackId: string, zone: unknown): MenuTarget {
    return { kind: 'stack', owner: this.owner(), stackId, zone: zone as StackZone };
  }

  pileTarget(zone: 'deck' | 'eggDeck' | 'security' | 'reveal' | 'trash' | 'hand'): MenuTarget {
    return { kind: 'pile', owner: this.owner(), zone };
  }

  press(event: PointerEvent, target: MenuTarget): void {
    if (event.button !== 0) return;
    this.longPressed = false;
    this.release();
    const x = event.clientX;
    const y = event.clientY;
    this.pressX = x;
    this.pressY = y;
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.longPressed = true;
      this.menu.emit({ x, y, target });
    }, LONG_PRESS_MS);
  }

  release(): void {
    if (this.pressTimer !== null) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
  }

  ctx(event: MouseEvent, target: MenuTarget): void {
    event.preventDefault();
    this.release();
    this.longPressed = false;
    this.menu.emit({ x: event.clientX, y: event.clientY, target });
  }

  hover(cardId: string | null, target?: MenuTarget): void {
    if (!target) {
      this.preview.emit(null);
      return;
    }
    this.preview.emit({ cardId: this.visibleId(cardId), target });
  }

  deckWarn(): boolean {
    const n = this.player().deck.length;
    return n > 0 && n <= DECK_WARN_AT;
  }

  topOf(stack: Stack): string | null {
    return stack.cards[stack.cards.length - 1]?.cardId ?? null;
  }

  private visibleId(cardId: string | null): string | null {
    if (!cardId || cardId === HIDDEN_CARD_ID) return null;
    return this.cards.cardsMap().has(cardId) ? cardId : null;
  }

  private cached<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }
}
