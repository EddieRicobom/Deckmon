import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DigimonCard } from '../../../../models';
import { DigimonCardStore } from '../../../store/digimon-card.store';
import { stackDpMod } from '../core/game';
import { Stack } from '../core/types';
import { HIDDEN_CARD_ID } from '../core/view';

export const CARD_BACK = 'assets/images/digimon-card-back.webp';
/** Vertical offset between digivolution sources peeking out under the top card, in px. */
const SOURCE_PEEK_PX = 12;
/** Card height / width. */
const CARD_RATIO = 88 / 63;

/** Image URL for a card id, or the card back when the card is hidden or unknown. */
export function useCardImage(cardsMap: () => Map<string, DigimonCard>, cardId: () => string, faceDown: () => boolean) {
  return computed(() => {
    const id = cardId();
    if (faceDown() || !id || id === HIDDEN_CARD_ID) return CARD_BACK;
    return cardsMap().get(id)?.cardImage || CARD_BACK;
  });
}

@Component({
  selector: 'digimon-play-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  template: `<img
    [src]="src()"
    alt=""
    draggable="false"
    loading="lazy"
    decoding="async"
    class="block h-full w-full select-none rounded-[4%] object-cover" />`,
  host: {
    class: 'block w-[var(--cw)] aspect-[63/88] shadow-md shadow-black/40',
    '[class.opacity-80]': 'faceDown()',
  },
})
export class PlayCardComponent {
  readonly cardId = input.required<string>();
  readonly faceDown = input(false);
  private readonly store = inject(DigimonCardStore);
  readonly src = useCardImage(
    () => this.store.cardsMap(),
    () => this.cardId(),
    () => this.faceDown(),
  );
}

@Component({
  selector: 'digimon-play-stack',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [PlayCardComponent],
  template: `
    <div class="relative" [style.width]="outerWidth()" [style.height]="outerHeight()">
      <div
        class="absolute left-1/2 top-1/2 origin-center"
        [style.width]="'var(--cw)'"
        [style.height]="innerHeight()"
        [style.transform]="transform()">
        @for (c of stack().cards; track c.uid; let i = $index) {
          <digimon-play-card
            class="absolute left-0 w-full"
            [style.top.px]="i * peek()"
            [style.z-index]="i + 1"
            [cardId]="c.cardId"
            [faceDown]="!!stack().faceDown" />
        }
        @if (dpLabel(); as dp) {
          <span
            class="pointer-events-none absolute bottom-1 right-1 z-[60] rounded bg-black/75 px-1 font-mono text-[0.65rem] font-bold leading-tight text-white"
            [style.transform]="counterTransform()"
            >{{ dp }}</span
          >
        }
        @if (markerCount() > 0) {
          <span
            class="pointer-events-none absolute bottom-1 left-1 z-[60] max-w-[90%] truncate rounded bg-accent/90 px-1 text-[0.6rem] font-semibold text-accent-ink"
            [style.transform]="counterTransform()">
            {{ firstMarker() }}{{ markerCount() > 1 ? ' +' + (markerCount() - 1) : '' }}
          </span>
        }
        @if (stack().counter) {
          <span
            class="pointer-events-none absolute left-1 top-1 z-[60] min-w-[1.1rem] rounded-full bg-sky-500 px-1 text-center font-mono text-[0.6rem] font-bold leading-tight text-white"
            [style.transform]="counterTransform()"
            >{{ stack().counter }}</span
          >
        }
      </div>
    </div>
  `,
  host: { class: 'block' },
})
export class PlayStackComponent {
  readonly stack = input.required<Stack>();
  private readonly store = inject(DigimonCardStore);

  readonly peek = computed(() => SOURCE_PEEK_PX);
  readonly topCardId = computed(() => {
    const cards = this.stack().cards;
    return cards[cards.length - 1]?.cardId ?? '';
  });

  /** Height of the whole stack when upright: one card plus the peeking sources. */
  readonly innerHeight = computed(
    () => `calc(var(--cw) * ${CARD_RATIO.toFixed(3)} + ${(this.stack().cards.length - 1) * SOURCE_PEEK_PX}px)`,
  );
  /** The layout slot swaps width and height when suspended so neighbours do not overlap. */
  readonly outerWidth = computed(() => (this.stack().suspended ? this.innerHeight() : 'var(--cw)'));
  readonly outerHeight = computed(() => (this.stack().suspended ? 'var(--cw)' : this.innerHeight()));
  readonly transform = computed(() => (this.stack().suspended ? 'translate(-50%, -50%) rotate(90deg)' : 'translate(-50%, -50%)'));
  /** Keep badges upright when the stack is rotated. */
  readonly counterTransform = computed(() => (this.stack().suspended ? 'rotate(-90deg)' : 'none'));

  readonly markerCount = computed(() => (this.stack().markers?.length ?? 0) + (this.stack().tempMarkers?.length ?? 0));
  readonly firstMarker = computed(() => this.stack().markers?.[0] ?? this.stack().tempMarkers?.[0] ?? '');

  readonly dpLabel = computed(() => {
    const s = this.stack();
    if (s.faceDown) return null;
    const base = Number.parseInt(this.store.cardsMap().get(this.topCardId())?.dp ?? '', 10);
    const mod = stackDpMod(s);
    if (!Number.isFinite(base) && mod === 0) return null;
    const total = (Number.isFinite(base) ? base : 0) + mod;
    return `${total}`;
  });
}
