import { NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, effect, input, signal, untracked } from '@angular/core';
import { Reminder } from '../core/types';

/** How long an unpinned reminder stays on screen. */
export const REMINDER_AUTO_HIDE_MS = 8000;
/** Most reminders on screen at once. The oldest unpinned one leaves first. */
const MAX_VISIBLE = 4;

interface Toast {
  key: string;
  reminder: Reminder;
  pinned: boolean;
}

/** Stable identity of a reminder. Ids alone can repeat after an undo, so the text is part of the key. */
function keyOf(r: Reminder): string {
  return `${r.id}|${r.player}|${r.cardName}|${r.timing}|${r.text}`;
}

/**
 * Non-blocking stack of effect reminders. New reminders from the table appear here, bottom-left on desktop and at
 * the top on phones. Each one hides after a few seconds unless it is pinned. Nothing here changes the game.
 */
@Component({
  selector: 'digimon-reminder-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [NgClass],
  template: `
    @if (toasts().length > 0) {
      <div
        class="pointer-events-none fixed z-[350] flex max-w-[calc(100vw-1rem)] flex-col gap-2"
        [ngClass]="top() ? 'inset-x-2 top-[4.25rem]' : 'bottom-4 left-4 w-72'"
        aria-live="polite"
        aria-label="Effect reminders">
        @for (t of toasts(); track t.key) {
          <div class="pointer-events-auto rounded-lg border border-accent/60 bg-ink-1/95 p-2 text-xs text-fg shadow-xl">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="truncate font-semibold">{{ t.reminder.cardName }}</span>
                  <span class="rounded bg-accent px-1.5 py-px text-[10px] font-bold text-accent-ink">[{{ t.reminder.timing }}]</span>
                </div>
                <p class="m-0 mt-1 whitespace-pre-line leading-snug text-fg">{{ t.reminder.text }}</p>
                <p class="m-0 mt-1 text-[10px] text-muted">{{ ownerName(t.reminder) }}</p>
              </div>
              <div class="flex shrink-0 flex-col gap-1">
                <button
                  type="button"
                  class="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-fg"
                  [class.text-accent]="t.pinned"
                  [attr.aria-pressed]="t.pinned"
                  (click)="togglePin(t.key)">
                  {{ t.pinned ? 'Pinned' : 'Pin' }}
                </button>
                <button
                  type="button"
                  class="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-fg"
                  (click)="dismiss(t.key)"
                  aria-label="Dismiss reminder">
                  ×
                </button>
              </div>
            </div>
          </div>
        }
      </div>
    }
  `,
})
export class ReminderToastsComponent implements OnDestroy {
  /** The table's reminder list (state.reminders). */
  readonly reminders = input<readonly Reminder[]>([]);
  /** Player display names, index 0 and 1. */
  readonly names = input<readonly [string, string]>(['Player 1', 'Player 2']);
  /** Phones: the stack sits under the top bar instead of the bottom-left corner. */
  readonly top = input(false);

  protected readonly toasts = signal<Toast[]>([]);
  private readonly seen = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private primed = false;

  constructor() {
    effect(() => {
      const list = this.reminders();
      untracked(() => this.absorb(list));
    });
  }

  protected ownerName(r: Reminder): string {
    return this.names()[r.player] ?? `Player ${r.player + 1}`;
  }

  protected togglePin(key: string): void {
    const pinned = this.toasts().find((t) => t.key === key)?.pinned ?? false;
    this.toasts.update((list) => list.map((t) => (t.key === key ? { ...t, pinned: !pinned } : t)));
    if (pinned) {
      this.schedule(key);
    } else {
      this.cancel(key);
    }
  }

  protected dismiss(key: string): void {
    this.cancel(key);
    this.toasts.update((list) => list.filter((t) => t.key !== key));
  }

  ngOnDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Shows the reminders that are new since the last look. The first look only records what already exists. */
  private absorb(list: readonly Reminder[]): void {
    if (!this.primed) {
      this.primed = true;
      for (const r of list) this.seen.add(keyOf(r));
      return;
    }
    const fresh: Toast[] = [];
    for (const r of list) {
      const key = keyOf(r);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      fresh.push({ key, reminder: r, pinned: false });
    }
    if (fresh.length === 0) return;
    this.toasts.update((current) => {
      const next = [...current, ...fresh];
      while (next.length > MAX_VISIBLE) {
        const idx = next.findIndex((t) => !t.pinned);
        const drop = idx === -1 ? 0 : idx;
        this.cancel(next[drop].key);
        next.splice(drop, 1);
      }
      return next;
    });
    for (const t of fresh) this.schedule(t.key);
  }

  private schedule(key: string): void {
    this.cancel(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.toasts.update((list) => list.filter((t) => t.key !== key));
      }, REMINDER_AUTO_HIDE_MS),
    );
  }

  private cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
  }
}
