import { NgTemplateOutlet } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  inject,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  Output,
  ViewChild,
} from '@angular/core';
import { DigimonCard, IDeckCard } from '@models';

export type HoloTier = 'common' | 'rare' | 'super';

export interface Deck3DEntry {
  card: DigimonCard;
  count: number;
  tier: HoloTier;
}

interface TiltSpring {
  x: number;
  y: number;
  tx: number;
  ty: number;
  max: number;
}

type OrientationCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
};

const CARD_RATIO = 88 / 63;
const TILT_MAX = 14;
const TILT_MAX_FOCUS = 20;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function tierOf(card: DigimonCard): HoloTier {
  const rarity = (card.rarity || '').toUpperCase();
  const version = card.version || '';
  const altArt = /Foil|Alternative|Textured/i.test(version);
  if (rarity === 'SEC' || rarity === 'SR' || rarity === 'UR' || altArt) return 'super';
  if (rarity === 'R' || rarity === 'P' || /Reprint|Stamp|Pre-Release/i.test(version)) return 'rare';
  return 'common';
}

function toEntries(cards: IDeckCard[]): Deck3DEntry[] {
  const byId = new Map<string, Deck3DEntry>();
  for (const card of cards) {
    if (!card || !(card.count > 0)) continue;
    const existing = byId.get(card.id);
    if (existing) {
      existing.count += card.count;
    } else {
      byId.set(card.id, { card, count: card.count, tier: tierOf(card) });
    }
  }
  return [...byId.values()];
}

@Component({
  selector: 'digimon-deck-3d-viewer',
  standalone: true,
  imports: [NgTemplateOutlet],
  styleUrls: ['./deck-3d-viewer.component.scss'],
  template: `
    <div #root class="d3-root" role="dialog" aria-modal="true" aria-label="3D deck view">
      <header class="d3-top">
        <p class="d3-title">
          <strong>3D deck view</strong> · {{ entries.length }} unique · {{ totalCopies }} cards
        </p>
        <div class="d3-controls" role="group" aria-label="Layout">
          <button type="button" class="d3-btn" [attr.aria-pressed]="mode === 'ring'" (click)="setMode('ring')">Carousel</button>
          <button type="button" class="d3-btn" [attr.aria-pressed]="mode === 'grid'" (click)="setMode('grid')">Grid</button>
          @if (motionPromptVisible) {
            <button type="button" class="d3-btn" (click)="enableMotion()">Enable tilt</button>
          }
          <button type="button" class="d3-btn" aria-label="Close 3D view" (click)="close()">Close</button>
        </div>
      </header>

      @if (!entries.length) {
        <p class="d3-empty">This deck has no cards yet.</p>
      } @else if (mode === 'ring') {
        <div #stage class="d3-stage">
          <div #ring class="d3-ring">
            @for (entry of entries; track entry.card.id; let i = $index) {
              <div
                class="card3d"
                tabindex="0"
                role="button"
                [attr.aria-label]="entry.card.name.english + ' x' + entry.count"
                [style.width.px]="cardWidth"
                [style.height.px]="cardHeight"
                [style.margin-left.px]="-cardWidth / 2"
                [style.margin-top.px]="-cardHeight / 2"
                [style.transform]="ringTransform(i)"
                (click)="onCardClick(i)"
                (keydown.enter)="onCardClick(i)">
                <ng-container *ngTemplateOutlet="holoTpl; context: { $implicit: entry, focus: false }"></ng-container>
              </div>
            }
          </div>
          <p class="d3-hint">Drag, scroll or use the arrow keys to spin · click a card to inspect</p>
        </div>
      } @else {
        <div class="d3-grid">
          @for (entry of entries; track entry.card.id; let i = $index) {
            <div
              class="card3d flat"
              tabindex="0"
              role="button"
              [attr.aria-label]="entry.card.name.english + ' x' + entry.count"
              (click)="onCardClick(i)"
              (keydown.enter)="onCardClick(i)">
              <ng-container *ngTemplateOutlet="holoTpl; context: { $implicit: entry, focus: false }"></ng-container>
            </div>
          }
        </div>
      }

      @if (focusEntry) {
        <div class="d3-focus" (click)="closeFocus()">
          <div
            class="d3-focus-card"
            role="button"
            tabindex="0"
            aria-label="Flip card"
            (click)="$event.stopPropagation(); flip()"
            (keydown.enter)="flip()">
            <ng-container *ngTemplateOutlet="holoTpl; context: { $implicit: focusEntry, focus: true }"></ng-container>
          </div>
          <p class="d3-hint">Click the card to flip · click outside or press Esc to return</p>
        </div>
      }
    </div>

    <ng-template #holoTpl let-entry let-focus="focus">
      <div class="tilt" [class.is-focus]="focus">
        <div class="flip" [class.is-flipped]="focus && flipped">
          <div class="face front" [class.tier-rare]="entry.tier === 'rare'" [class.tier-super]="entry.tier === 'super'">
            <img
              class="art"
              [src]="entry.card.cardImage"
              [alt]="entry.card.cardNumber + ' ' + entry.card.name.english"
              loading="lazy"
              decoding="async"
              draggable="false" />
            <div class="shine"></div>
            <div class="glare"></div>
            <div class="sparkle"></div>
            @if (entry.count > 1) {
              <span class="count">x{{ entry.count }}</span>
            }
          </div>
          <div class="face back" aria-hidden="true">
            <div class="back-title">DIGIMON</div>
            <div class="back-sub">CARD GAME</div>
          </div>
        </div>
      </div>
    </ng-template>
  `,
})
export class Deck3dViewerComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() cards: IDeckCard[] = [];
  @Output() closed = new EventEmitter<void>();

  @ViewChild('root', { static: true }) rootRef!: ElementRef<HTMLElement>;
  @ViewChild('stage') stageRef?: ElementRef<HTMLElement>;
  @ViewChild('ring') ringRef?: ElementRef<HTMLElement>;

  private readonly zone = inject(NgZone);
  private readonly orientationCtor = typeof DeviceOrientationEvent !== 'undefined' ? (DeviceOrientationEvent as OrientationCtor) : undefined;

  entries: Deck3DEntry[] = [];
  totalCopies = 0;
  mode: 'ring' | 'grid' = 'ring';
  focusEntry: Deck3DEntry | null = null;
  flipped = false;
  motionPromptVisible = !!this.orientationCtor?.requestPermission;

  cardWidth = 172;
  cardHeight = Math.round(172 * CARD_RATIO);
  radius = 0;
  step = 0;

  private rotation = 0;
  private velocity = 0;
  private rotTarget: number | null = null;
  private dragging = false;
  private dragMoved = 0;
  private lastX = 0;
  private lastY = 0;
  private suppressClick = false;
  private lastInteraction = 0;
  private lastFront = -1;
  private hoverEl: HTMLElement | null = null;
  private readonly springs = new Map<HTMLElement, TiltSpring>();
  private readonly reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private frame = 0;

  ngOnChanges(): void {
    this.entries = toEntries(this.cards ?? []);
    this.totalCopies = this.entries.reduce((sum, entry) => sum + entry.count, 0);
    this.layoutRing();
    this.rootRef?.nativeElement.querySelectorAll('.is-front').forEach((el) => el.classList.remove('is-front'));
    this.lastFront = -1;
  }

  ngAfterViewInit(): void {
    const root = this.rootRef.nativeElement;
    this.zone.runOutsideAngular(() => {
      root.addEventListener('pointerdown', this.onRootDown);
      root.addEventListener('pointermove', this.onRootMove);
      root.addEventListener('pointerleave', this.onRootLeave);
      window.addEventListener('pointermove', this.onWindowMove);
      window.addEventListener('pointerup', this.onWindowUp);
      window.addEventListener('pointercancel', this.onWindowUp);
      window.addEventListener('wheel', this.onWheel, { passive: false });
      this.frame = requestAnimationFrame(this.tick);
    });
    // Android and other non-iOS touch devices need no permission. iOS shows a button instead.
    if (this.orientationCtor && !this.orientationCtor.requestPermission && navigator.maxTouchPoints > 0) {
      this.startOrientation();
    }
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frame);
    const root = this.rootRef?.nativeElement;
    root?.removeEventListener('pointerdown', this.onRootDown);
    root?.removeEventListener('pointermove', this.onRootMove);
    root?.removeEventListener('pointerleave', this.onRootLeave);
    window.removeEventListener('pointermove', this.onWindowMove);
    window.removeEventListener('pointerup', this.onWindowUp);
    window.removeEventListener('pointercancel', this.onWindowUp);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('deviceorientation', this.onOrientation);
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.focusEntry) {
        this.closeFocus();
      } else {
        this.close();
      }
      return;
    }
    if (this.focusEntry) {
      if (event.key === ' ') {
        event.preventDefault();
        this.flip();
      }
      return;
    }
    if (this.mode === 'ring' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      this.snap(event.key === 'ArrowRight');
    }
  }

  close(): void {
    this.closed.emit();
  }

  setMode(mode: 'ring' | 'grid'): void {
    this.mode = mode;
    this.releaseHover();
    this.lastFront = -1;
  }

  ringTransform(index: number): string {
    return `rotateY(${(index * this.step).toFixed(3)}deg) translateZ(${this.radius.toFixed(1)}px)`;
  }

  onCardClick(index: number): void {
    if (this.suppressClick) return;
    this.releaseHover();
    this.velocity = 0;
    this.rotTarget = null;
    this.flipped = false;
    this.focusEntry = this.entries[index] ?? null;
  }

  flip(): void {
    if (this.focusEntry) this.flipped = !this.flipped;
  }

  closeFocus(): void {
    this.focusEntry = null;
    this.flipped = false;
    this.releaseHover();
  }

  async enableMotion(): Promise<void> {
    const ctor = this.orientationCtor;
    const request = ctor?.requestPermission;
    if (!ctor || !request) return;
    try {
      const result = await request.call(ctor);
      if (result === 'granted') this.startOrientation();
    } catch {
      // Permission request failed or was dismissed: keep the static view.
    }
    this.motionPromptVisible = false;
  }

  private layoutRing(): void {
    const n = this.entries.length;
    this.cardWidth = typeof window !== 'undefined' && window.innerWidth < 640 ? 128 : 172;
    this.cardHeight = Math.round(this.cardWidth * CARD_RATIO);
    if (n <= 1) {
      this.step = 0;
      this.radius = 0;
      return;
    }
    this.step = 360 / n;
    const fitted = (this.cardWidth * 0.62) / Math.sin(Math.PI / n);
    this.radius = Math.min(Math.max(fitted, this.cardWidth * 0.9), this.cardWidth * 8);
  }

  private snap(next: boolean): void {
    if (this.step === 0) return;
    const base = Math.round(this.rotation / this.step) * this.step;
    // Front card index i sits at rotation -i * step, so "next" moves the target one step negative.
    const target = base + (next ? -this.step : this.step);
    this.velocity = 0;
    this.lastInteraction = performance.now();
    if (this.reduceMotion) {
      this.rotation = target;
      this.rotTarget = null;
    } else {
      this.rotTarget = target;
    }
  }

  private startOrientation(): void {
    this.zone.runOutsideAngular(() => window.addEventListener('deviceorientation', this.onOrientation));
  }

  private readonly onOrientation = (event: DeviceOrientationEvent): void => {
    if (!this.focusEntry || event.beta === null || event.gamma === null) return;
    const el = this.rootRef.nativeElement.querySelector<HTMLElement>('.d3-focus .tilt');
    if (!el) return;
    const x = clamp(event.gamma / 25, -1, 1);
    const y = clamp((event.beta - 45) / 25, -1, 1);
    this.setTarget(el, x, y);
  };

  private readonly onRootDown = (event: PointerEvent): void => {
    this.suppressClick = false;
    const stage = this.stageRef?.nativeElement;
    if (this.mode !== 'ring' || this.focusEntry || !stage || !stage.contains(event.target as Node)) return;
    this.dragging = true;
    this.dragMoved = 0;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.rotTarget = null;
    this.velocity = 0;
    this.lastInteraction = performance.now();
  };

  private readonly onRootMove = (event: PointerEvent): void => {
    const hit = (event.target as Element | null)?.closest<HTMLElement>('.tilt') ?? null;
    if (this.hoverEl && this.hoverEl !== hit) this.setTarget(this.hoverEl, 0, 0);
    this.hoverEl = hit;
    if (hit && !this.dragging) this.aimAt(hit, event.clientX, event.clientY);
  };

  private readonly onRootLeave = (): void => {
    this.releaseHover();
  };

  private readonly onWindowMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = event.clientX - this.lastX;
    this.dragMoved += Math.abs(dx) + Math.abs(event.clientY - this.lastY);
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    const delta = dx * 0.32;
    this.rotation += delta;
    this.velocity = this.reduceMotion ? 0 : delta;
    this.lastInteraction = performance.now();
  };

  private readonly onWindowUp = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.suppressClick = this.dragMoved > 6;
    this.lastInteraction = performance.now();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.mode !== 'ring' || this.focusEntry) return;
    event.preventDefault();
    this.rotTarget = null;
    this.lastInteraction = performance.now();
    if (this.reduceMotion) {
      this.rotation += event.deltaY * 0.08;
    } else {
      this.velocity = clamp(this.velocity + event.deltaY * 0.012, -10, 10);
    }
  };

  private readonly tick = (): void => {
    this.frame = requestAnimationFrame(this.tick);
    const now = performance.now();
    const ring = this.ringRef?.nativeElement;

    if (!this.dragging && !this.focusEntry && this.mode === 'ring') {
      if (this.rotTarget !== null) {
        const diff = this.rotTarget - this.rotation;
        this.rotation += diff * 0.12;
        if (Math.abs(diff) < 0.05) {
          this.rotation = this.rotTarget;
          this.rotTarget = null;
        }
      } else {
        this.rotation += this.velocity;
        this.velocity *= 0.94;
        if (Math.abs(this.velocity) < 0.005) this.velocity = 0;
        if (!this.reduceMotion && now - this.lastInteraction > 2500) this.rotation += 0.035;
      }
    }

    if (ring && this.mode === 'ring') {
      ring.style.transform = `rotateY(${this.rotation.toFixed(3)}deg)`;
      const n = this.entries.length;
      if (n > 1 && this.step > 0 && !this.focusEntry) {
        const front = ((Math.round(-this.rotation / this.step) % n) + n) % n;
        if (front !== this.lastFront) {
          this.setFrontClass(ring, this.lastFront, false);
          this.setFrontClass(ring, front, true);
          this.lastFront = front;
        }
      }
    }

    this.springs.forEach((spring, el) => {
      if (!el.isConnected) {
        this.springs.delete(el);
        return;
      }
      spring.x += (spring.tx - spring.x) * 0.14;
      spring.y += (spring.ty - spring.y) * 0.14;
      const idle = spring.tx === 0 && spring.ty === 0 && Math.abs(spring.x) < 0.001 && Math.abs(spring.y) < 0.001;
      if (idle) {
        this.springs.delete(el);
        el.classList.remove('is-active');
        this.writeTilt(el, 0, 0, spring.max);
        return;
      }
      this.writeTilt(el, spring.x, spring.y, spring.max);
    });
  };

  private setFrontClass(ring: HTMLElement, index: number, on: boolean): void {
    if (index < 0) return;
    const tilt = ring.children.item(index)?.querySelector('.tilt');
    tilt?.classList.toggle('is-front', on);
  }

  private aimAt(el: HTMLElement, clientX: number, clientY: number): void {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = clamp(((clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    const y = clamp(((clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
    this.setTarget(el, x, y);
  }

  private setTarget(el: HTMLElement, x: number, y: number): void {
    let spring = this.springs.get(el);
    if (!spring) {
      spring = {
        x: 0,
        y: 0,
        tx: 0,
        ty: 0,
        max: el.classList.contains('is-focus') ? TILT_MAX_FOCUS : TILT_MAX,
      };
      this.springs.set(el, spring);
    }
    spring.tx = x;
    spring.ty = y;
    el.classList.add('is-active');
  }

  private releaseHover(): void {
    if (this.hoverEl) {
      this.setTarget(this.hoverEl, 0, 0);
      this.hoverEl = null;
    }
  }

  // Writes the holo custom properties read by the card layers in the stylesheet.
  private writeTilt(el: HTMLElement, x: number, y: number, max: number): void {
    const hyp = Math.min(1, Math.hypot(x, y));
    const px = (50 + x * 50).toFixed(2);
    const py = (50 + y * 50).toFixed(2);
    el.style.setProperty('--mx', px);
    el.style.setProperty('--my', py);
    el.style.setProperty('--posx', px);
    el.style.setProperty('--posy', py);
    el.style.setProperty('--hyp', hyp.toFixed(3));
    el.style.setProperty('--rx', `${(-y * max).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${(x * max).toFixed(2)}deg`);
  }
}
