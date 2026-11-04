import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, inject, input } from '@angular/core';
import { DigimonCard } from '../../../../models';
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
    // Only hand cards can digivolve, and only onto a battle stack.
    return target.zone === 'battle' && drag.from === 'hand' ? { type: 'digivolve', player, handUid: uid, onto: target.stackId } : null;
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
  imports: [NgTemplateOutlet, CdkDropListGroup, CdkDropList, CdkDrag, PlayCardComponent, PlayStackComponent],
  template: `
    <section
      cdkDropListGroup
      class="flex flex-1 flex-col gap-2 rounded-xl border bg-ink-1 p-2 transition-colors md:p-3"
      [class.border-accent]="active()"
      [class.border-line]="!active()">
      <header class="flex items-center justify-between gap-2 text-xs text-muted" [class.flex-row-reverse]="mirrored()">
        <span class="flex items-center gap-2 font-semibold text-fg">
          <span class="rounded bg-ink-2 px-2 py-0.5 font-mono">P{{ owner() + 1 }}</span>
          {{ player().name }}
          @if (active()) {
            <span class="rounded bg-accent px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent-ink">Active</span>
          }
        </span>
        <span class="font-mono"
          >Hand {{ player().hand.length }} · Deck {{ player().deck.length }} · Egg {{ player().eggDeck.length }} · Trash
          {{ player().trash.length }}</span
        >
      </header>

      <div class="flex gap-2 md:gap-3" [class.flex-row-reverse]="mirrored()">
        <!-- Left: security and trash -->
        <div class="flex shrink-0 flex-col gap-2">
          <div class="zone-label">Security {{ player().security.length }}</div>
          <div cdkDropList [cdkDropListData]="dropData('security')" (cdkDropListDropped)="onDrop($event)" class="zone-slot">
            @if (securityTop(); as sec) {
              <div
                cdkDrag
                [cdkDragData]="cardDrag(sec.uid, 'security')"
                class="cursor-grab"
                (pointerdown)="press($event, cardTarget(sec.uid, 'security'))"
                (pointerup)="release()"
                (pointerleave)="release()"
                (pointercancel)="release()"
                (cdkDragStarted)="release()"
                (contextmenu)="ctx($event, cardTarget(sec.uid, 'security'))"
                (mouseenter)="hover(sec.faceUp ? sec.cardId : null)"
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
                (pointerdown)="press($event, cardTarget(t.uid, 'trash'))"
                (pointerup)="release()"
                (pointerleave)="release()"
                (cdkDragStarted)="release()"
                (contextmenu)="ctx($event, cardTarget(t.uid, 'trash'))"
                (mouseenter)="hover(t.cardId)"
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
              <div cdkDropList [cdkDropListData]="dropData('breeding')" (cdkDropListDropped)="onDrop($event)" class="zone-slot">
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
            class="zone-row min-h-[calc(var(--cw)*1.6)] flex-1 gap-3">
            @for (s of player().battle; track s.stackId) {
              <div
                cdkDropList
                [cdkDropListData]="dropData('battle', s.stackId)"
                (cdkDropListDropped)="onDrop($event)"
                class="shrink-0 rounded-lg">
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
                (pointerdown)="press($event, cardTarget(r.uid, 'reveal'))"
                (pointerup)="release()"
                (pointerleave)="release()"
                (cdkDragStarted)="release()"
                (contextmenu)="ctx($event, cardTarget(r.uid, 'reveal'))"
                (mouseenter)="hover(r.cardId)"
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
        class="flex min-h-[calc(var(--cw)*1.45)] items-end justify-center overflow-visible pb-1">
        @for (c of player().hand; track c.uid; let i = $index) {
          <div
            cdkDrag
            [cdkDragData]="cardDrag(c.uid, 'hand')"
            class="relative cursor-grab transition-transform duration-150 hover:-translate-y-3 hover:z-50"
            [style.margin-left]="i === 0 ? '0px' : handOverlap"
            [style.z-index]="i + 1"
            (pointerdown)="press($event, cardTarget(c.uid, 'hand'))"
            (pointerup)="release()"
            (pointerleave)="release()"
            (pointercancel)="release()"
            (cdkDragStarted)="release()"
            (contextmenu)="ctx($event, cardTarget(c.uid, 'hand'))"
            (mouseenter)="hover(c.cardId)"
            (mouseleave)="hover(null)"
            (click)="tap(c.cardId)">
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
        class="cursor-pointer"
        (click)="toggleSuspend(s)"
        (pointerdown)="press($event, stackTarget(s.stackId, zone))"
        (pointerup)="release()"
        (pointerleave)="release()"
        (pointercancel)="release()"
        (cdkDragStarted)="release()"
        (contextmenu)="ctx($event, stackTarget(s.stackId, zone))"
        (mouseenter)="hover(s.faceDown ? null : topOf(s))"
        (mouseleave)="hover(null)">
        <digimon-play-stack [stack]="s" />
      </div>
    </ng-template>
  `,
  styles: [
    `
      :host {
        --cw: clamp(1.9rem, min(5.6vh, 8vw), 5.25rem);
        display: flex;
        min-height: auto;
        flex: 1 1 auto;
      }
      :host section {
        width: 100%;
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
      .cdk-drag-placeholder {
        opacity: 0.25;
      }
      .cdk-drop-list-dragging .cdk-drag {
        transition: transform 150ms;
      }
    `,
  ],
})
export class PlayerBoardComponent {
  readonly player = input.required<PlayerState>();
  readonly owner = input.required<PlayerIndex>();
  readonly mirrored = input(false);
  readonly active = input(false);

  /** Emitted for every board action, already translated into a core command. */
  @Output() readonly issue = new EventEmitter<Command>();
  /** Emitted on right-click or long-press with the target to build a menu for. */
  @Output() readonly menu = new EventEmitter<{ x: number; y: number; target: MenuTarget }>();
  /** Emitted when the hovered / tapped card changes. null clears the preview. */
  @Output() readonly preview = new EventEmitter<DigimonCard | null>();

  protected readonly hiddenId = HIDDEN_CARD_ID;
  protected readonly handOverlap = HAND_OVERLAP;
  private readonly cards = inject(DigimonCardStore);
  private readonly memo = new Map<string, unknown>();
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;

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
    const cmd = commandForDrop(event.item.data as DragData, event.container.data);
    if (cmd) this.issue.emit(cmd);
  }

  toggleSuspend(stack: Stack): void {
    if (this.longPressed) {
      this.longPressed = false;
      return;
    }
    this.issue.emit({ type: stack.suspended ? 'unsuspend' : 'suspend', player: this.owner(), stackId: stack.stackId });
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

  hover(cardId: string | null): void {
    this.preview.emit(this.lookup(cardId));
  }

  tap(cardId: string): void {
    this.preview.emit(this.lookup(cardId));
  }

  topOf(stack: Stack): string | null {
    return stack.cards[stack.cards.length - 1]?.cardId ?? null;
  }

  private lookup(cardId: string | null): DigimonCard | null {
    if (!cardId || cardId === HIDDEN_CARD_ID) return null;
    return this.cards.cardsMap().get(cardId) ?? null;
  }

  private cached<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }
}
