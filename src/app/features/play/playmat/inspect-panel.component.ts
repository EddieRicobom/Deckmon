import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { DigimonCard } from '../../../../models';
import { DigimonCardStore } from '../../../store/digimon-card.store';
import { Command } from '../core/commands';
import { allCards, getStack, stackDpMod } from '../core/game';
import { GameState, Stack } from '../core/types';
import { HIDDEN_CARD_ID } from '../core/view';
import { menuItemsFor, MenuItem, MenuTarget } from './menu-items';

/** Quick marker presets for the inspect panel. Custom text is also accepted. */
export const MARKER_PRESETS: readonly string[] = [
  "Can't attack",
  "Can't block",
  'Blocker',
  'Rush',
  'Security Attack +1',
  'Security Attack -1',
  'Piercing',
  'Jamming',
  'Reboot',
  'Retaliation',
  'De-Digivolve',
  'Suspended next turn',
];

/** Strips markup from card text. Returns null for empty or placeholder text. */
export function cleanCardText(text: string | undefined | null): string | null {
  if (!text) return null;
  const plain = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
  return plain && plain !== '-' ? plain : null;
}

/**
 * Large readable view of one pinned card or stack, with inline DP, counter and marker controls for stacks.
 * It only emits commands. The playmat sends them through GameSession, so online play stays in sync.
 */
@Component({
  selector: 'digimon-inspect-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  host: {
    class: 'block',
    'data-keep-pin': '',
  },
  template: `
    @if (card(); as c) {
      <article class="flex flex-col gap-2 text-sm" [class.flex-row]="variant() === 'sheet'" [class.gap-3]="variant() === 'sheet'">
        <img
          [src]="c.cardImage || cardBack"
          [alt]="name()"
          class="shrink-0 rounded-lg object-contain shadow-xl shadow-black/50"
          [class.w-full]="variant() === 'side'"
          [class.w-28]="variant() === 'sheet'" />

        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <header class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h2 class="m-0 break-words font-display text-base font-semibold leading-tight text-fg">{{ name() }}</h2>
              <p class="m-0 font-mono text-[11px] text-muted">{{ c.cardNumber }} · {{ c.cardType }}</p>
            </div>
            <button type="button" class="ip-btn shrink-0" (click)="closed.emit()" aria-label="Close inspector">×</button>
          </header>

          <dl class="m-0 grid grid-cols-3 gap-1 text-xs">
            @if (stack(); as s) {
              <div class="rounded bg-ink-2 px-2 py-1">
                <dt class="text-[10px] uppercase text-muted">DP</dt>
                <dd class="m-0 font-mono text-base font-bold text-fg">
                  {{ dpTotal() ?? '-' }}
                  @if (stackMod() !== 0) {
                    <span class="text-[10px] font-normal" [class.text-emerald-300]="stackMod() > 0" [class.text-red-300]="stackMod() < 0">
                      ({{ stackMod() > 0 ? '+' : '' }}{{ stackMod() }})
                    </span>
                  }
                </dd>
              </div>
            }
            <div class="rounded bg-ink-2 px-2 py-1">
              <dt class="text-[10px] uppercase text-muted">Level</dt>
              <dd class="m-0 font-mono text-fg">{{ c.cardLv || '-' }}</dd>
            </div>
            <div class="rounded bg-ink-2 px-2 py-1">
              <dt class="text-[10px] uppercase text-muted">Play cost</dt>
              <dd class="m-0 font-mono text-fg">{{ c.playCost || '-' }}</dd>
            </div>
            @if (!stack()) {
              <div class="rounded bg-ink-2 px-2 py-1">
                <dt class="text-[10px] uppercase text-muted">Base DP</dt>
                <dd class="m-0 font-mono text-fg">{{ c.dp || '-' }}</dd>
              </div>
            }
          </dl>

          @if (stack(); as s) {
            @if (editable()) {
            <section class="flex flex-col gap-2 rounded-lg border border-line bg-ink-2 p-2" aria-label="Stack controls">
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] uppercase tracking-wide text-muted">DP modifier</span>
                <label class="flex cursor-pointer items-center gap-1 text-[11px] text-muted">
                  <input type="checkbox" class="accent-sky-400" [checked]="temporary()" (change)="temporary.set(!temporary())" />
                  Until end of turn
                </label>
              </div>
              <div class="grid grid-cols-2 gap-1.5">
                <button type="button" class="ip-btn" (click)="dp(-1, $event)" title="-1000 (Shift: -5000)">−1000</button>
                <button type="button" class="ip-btn" (click)="dp(1, $event)" title="+1000 (Shift: +5000)">+1000</button>
              </div>
              <p class="m-0 text-[10px] text-muted">Shift + click changes DP by 5000. Until-end-of-turn changes clear at turn end.</p>

              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] uppercase tracking-wide text-muted">Counter</span>
                <div class="flex items-center gap-1.5">
                  <button type="button" class="ip-btn" (click)="counter(-1)" [disabled]="!s.counter" aria-label="Decrease counter">−</button>
                  <span class="min-w-[2rem] text-center font-mono text-base text-fg" aria-live="polite">{{ s.counter ?? 0 }}</span>
                  <button type="button" class="ip-btn" (click)="counter(1)" aria-label="Increase counter">+</button>
                </div>
              </div>

              <div class="flex flex-col gap-1.5">
                <span class="text-[11px] uppercase tracking-wide text-muted">Markers</span>
                <div class="flex flex-wrap gap-1">
                  @for (m of s.markers ?? []; track $index) {
                    <button type="button" class="chip" (click)="removeMarker(m, false)" [attr.aria-label]="'Remove ' + m">
                      {{ m }} <span aria-hidden="true">×</span>
                    </button>
                  }
                  @for (m of s.tempMarkers ?? []; track $index) {
                    <button
                      type="button"
                      class="chip chip-temp"
                      (click)="removeMarker(m, true)"
                      [attr.aria-label]="'Remove ' + m + ' (until end of turn)'">
                      {{ m }} <span aria-hidden="true">×</span>
                    </button>
                  }
                  @if (!s.markers?.length && !s.tempMarkers?.length) {
                    <span class="text-[11px] text-muted">None</span>
                  }
                </div>
                <div class="flex flex-wrap gap-1">
                  @for (p of presets; track p) {
                    <button type="button" class="ip-btn text-[11px]" (click)="addMarker(p)">+ {{ p }}</button>
                  }
                </div>
                <form class="flex gap-1.5" (submit)="$event.preventDefault(); addMarker(custom())">
                  <input
                    type="text"
                    maxlength="24"
                    placeholder="Custom marker"
                    class="min-w-0 flex-1 rounded border border-line bg-ink-1 px-2 text-xs text-fg placeholder:text-muted"
                    [value]="custom()"
                    (input)="custom.set($any($event.target).value)"
                    aria-label="Custom marker text" />
                  <button type="submit" class="ip-btn" [disabled]="!custom().trim()">Add</button>
                </form>
              </div>

              @if (sources().length) {
                <div class="flex flex-col gap-1">
                  <span class="text-[11px] uppercase tracking-wide text-muted">Digivolution sources</span>
                  <ol class="m-0 list-none space-y-0.5 p-0 text-xs text-fg">
                    @for (src of sources(); track $index) {
                      <li class="flex gap-1.5"><span class="font-mono text-muted">{{ $index + 1 }}.</span> <span class="break-words">{{ src }}</span></li>
                    }
                  </ol>
                </div>
              }
            </section>
            }
          }

          <section class="flex flex-col gap-1.5 text-xs leading-snug text-fg" aria-label="Card text">
            @if (effect(); as t) {
              <div>
                <b class="text-accent">Effect</b>
                <p class="m-0 whitespace-pre-line">{{ t }}</p>
              </div>
            }
            @if (inherited(); as t) {
              <div>
                <b class="text-accent">Inherited effect</b>
                <p class="m-0 whitespace-pre-line">{{ t }}</p>
              </div>
            }
            @if (securityText(); as t) {
              <div>
                <b class="text-accent">Security effect</b>
                <p class="m-0 whitespace-pre-line">{{ t }}</p>
              </div>
            }
            @if (!effect() && !inherited() && !securityText()) {
              <p class="m-0 text-muted">No card text.</p>
            }
          </section>

          @if (editable() && actions().length) {
            <section class="flex flex-wrap gap-1.5" aria-label="Card actions">
              @for (item of actions(); track $index) {
                <button type="button" class="ip-btn" [class.ip-danger]="item.danger" (click)="run(item)">{{ item.label }}</button>
              }
            </section>
          }
        </div>
      </article>
    } @else {
      <p class="m-0 text-sm text-muted">This card is no longer on the board.</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .ip-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 2.5rem;
        min-width: 2.5rem;
        border: 1px solid var(--dc-line, #334155);
        background: var(--dc-ink-1, #0f172a);
        color: var(--dc-fg, #e2e8f0);
        border-radius: 0.5rem;
        padding: 0.25rem 0.6rem;
        font-size: 0.75rem;
        cursor: pointer;
      }
      .ip-btn:hover:not(:disabled) {
        border-color: var(--dc-accent, #38bdf8);
      }
      .ip-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .ip-danger {
        color: #fca5a5;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        min-height: 2rem;
        border-radius: 999px;
        background: var(--dc-accent, #38bdf8);
        color: var(--dc-accent-ink, #0f172a);
        padding: 0.1rem 0.6rem;
        font-size: 0.72rem;
        font-weight: 600;
        border: 0;
        cursor: pointer;
      }
      .chip-temp {
        background: transparent;
        color: var(--dc-accent, #38bdf8);
        border: 1px dashed var(--dc-accent, #38bdf8);
      }
    `,
  ],
})
export class InspectPanelComponent {
  readonly target = input.required<MenuTarget>();
  readonly state = input.required<GameState>();
  readonly variant = input<'side' | 'sheet'>('side');
  /** False when the board belongs to the opponent online: the panel then only shows the card. */
  readonly editable = input(true);

  /** Commands from inline controls and action buttons. The playmat sends them through the session. */
  readonly issue = output<Command>();
  readonly closed = output<void>();

  protected readonly cardBack = 'assets/images/digimon-card-back.webp';
  protected readonly presets = MARKER_PRESETS;
  protected readonly temporary = signal(false);
  protected readonly custom = signal('');
  private readonly store = inject(DigimonCardStore);

  /** The stack this panel is about, when the target is a stack. */
  readonly stack = computed<Stack | null>(() => {
    const t = this.target();
    if (t.kind !== 'stack') return null;
    return getStack(this.state().players[t.owner], t.stackId);
  });

  /** The printed card id shown. Null when the target no longer exists. */
  private readonly cardId = computed<string | null>(() => {
    const t = this.target();
    const p = this.state().players[t.owner];
    if (t.kind === 'stack') {
      const s = this.stack();
      return s ? (s.cards[s.cards.length - 1]?.cardId ?? null) : null;
    }
    if (t.kind === 'card') return allCards(p).find((c) => c.uid === t.uid)?.cardId ?? null;
    return null;
  });

  readonly card = computed<DigimonCard | null>(() => {
    const id = this.cardId();
    if (!id || id === HIDDEN_CARD_ID) return null;
    return this.store.cardsMap().get(id) ?? null;
  });

  readonly name = computed(() => this.card()?.name.english || this.cardId() || 'Card');
  readonly stackMod = computed(() => {
    const s = this.stack();
    return s ? stackDpMod(s) : 0;
  });
  readonly dpTotal = computed(() => {
    const base = Number.parseInt(this.card()?.dp ?? '', 10);
    return Number.isFinite(base) ? base + this.stackMod() : null;
  });
  readonly effect = computed(() => cleanCardText(this.card()?.effect));
  readonly inherited = computed(() => cleanCardText(this.card()?.digivolveEffect));
  readonly securityText = computed(() => cleanCardText(this.card()?.securityEffect));

  /** Digivolution sources, from the card just below the top one down to the bottom of the stack. */
  readonly sources = computed(() => {
    const s = this.stack();
    if (!s) return [];
    return s.cards
      .slice(0, -1)
      .reverse()
      .map((c) => this.store.cardsMap().get(c.cardId)?.name.english || c.cardId);
  });

  /** Action buttons from the same menu the right-click menu uses. DP and marker entries are inline instead. */
  readonly actions = computed<MenuItem[]>(() =>
    menuItemsFor(this.target(), this.state()).filter((i) => !!i.cmd && i.group === undefined),
  );

  dp(sign: 1 | -1, event: MouseEvent): void {
    const t = this.target();
    const s = this.stack();
    if (t.kind !== 'stack' || !s) return;
    const delta = sign * (event.shiftKey ? 5000 : 1000);
    this.issue.emit({ type: 'adjustDp', player: t.owner, stackId: s.stackId, delta, temporary: this.temporary() });
  }

  counter(delta: number): void {
    const t = this.target();
    const s = this.stack();
    if (t.kind !== 'stack' || !s) return;
    this.issue.emit({ type: 'adjustCounter', player: t.owner, stackId: s.stackId, delta });
  }

  addMarker(text: string): void {
    const t = this.target();
    const s = this.stack();
    const marker = text.trim().slice(0, 24);
    if (t.kind !== 'stack' || !s || !marker) return;
    this.issue.emit({ type: 'addMarker', player: t.owner, stackId: s.stackId, marker, temporary: this.temporary() });
    this.custom.set('');
  }

  removeMarker(marker: string, temporary: boolean): void {
    const t = this.target();
    const s = this.stack();
    if (t.kind !== 'stack' || !s) return;
    this.issue.emit({ type: 'removeMarker', player: t.owner, stackId: s.stackId, marker, temporary });
  }

  run(item: MenuItem): void {
    if (item.cmd) this.issue.emit(item.cmd);
  }
}
