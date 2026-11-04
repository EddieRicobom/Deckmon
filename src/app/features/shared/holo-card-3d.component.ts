import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
import { ImgFallbackDirective } from '@directives';
import { DigimonCard } from '@models';

/** c = common, u = uncommon, r = rare, sr = super rare "digital", sec = secret "gold", p = promo "cosmic", aa = alt art / textured "prismatic". */
export type HoloTier = 'c' | 'u' | 'r' | 'sr' | 'sec' | 'p' | 'aa';

interface TiltSpring {
  x: number;
  y: number;
  tx: number;
  ty: number;
}

const TILT_MAX = 14;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

// Alt-art / textured / foil printings override rarity. `variant` is an optional printing type
// (for example an AAs[].type string when an alternate art is shown). In the current data every
// card's `version` is "Normal", so the variant is what makes an alt-art print show as 'aa'.
const ALT_PRINTING = /Alternative|Textured|Foil|Stamp|Box Topper/i;

export function holoTierOf(card: DigimonCard, variant?: string): HoloTier {
  if (ALT_PRINTING.test(`${variant ?? ''} ${card.version ?? ''}`)) return 'aa';
  switch ((card.rarity || '').toUpperCase()) {
    case 'UR':
    case 'SEC':
      return 'sec';
    case 'SR':
      return 'sr';
    case 'R':
      return 'r';
    case 'U':
      return 'u';
    case 'P':
      return 'p';
    default:
      return 'c';
  }
}

/**
 * Single card with pointer tilt, holo layers by rarity tier, idle shimmer and click/keyboard flip to a CSS-drawn back.
 * Only the card under the pointer runs the tilt animation loop; the loop stops once the spring settles.
 */
@Component({
  selector: 'digimon-holo-card-3d',
  standalone: true,
  imports: [ImgFallbackDirective],
  styleUrls: ['./holo-card-3d.component.scss'],
  host: {
    '[style.width]': 'hostWidth',
  },
  template: `
    <div
      #tilt
      class="tilt is-live"
      role="button"
      tabindex="0"
      [attr.aria-label]="card.name.english + (flipped ? ' (back, click to show front)' : ' (click to flip)')"
      (click)="flip()"
      (keydown.enter)="onKey($event)"
      (keydown.space)="onKey($event)">
      <div class="flip" [class.is-flipped]="flipped">
        <div class="face front" [class]="'holo-' + tier">
          <img
            class="art"
            [digimonImgFallback]="imageSrc"
            [alt]="card.cardNumber + ' ' + card.name.english"
            loading="lazy"
            decoding="async"
            draggable="false" />
          <div class="shine"></div>
          <div class="fx"></div>
          <div class="glare"></div>
          <div class="sparkle"></div>
        </div>
        <div class="face back" aria-hidden="true">
          <div class="back-title">DIGIMON</div>
          <div class="back-sub">CARD GAME</div>
        </div>
      </div>
    </div>
  `,
})
export class HoloCard3dComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input({ required: true }) card!: DigimonCard;
  /** Overrides the card's own image (for example an alternate art URL). */
  @Input() imageUrl?: string;
  /** Width in px. Omit to fill the parent width. Height follows the 63:88 card ratio. */
  @Input() size?: number;
  /** Printing type of the shown art (for example an alt-art type string). Makes alt-art prints use the 'aa' foil. */
  @Input() variant?: string;

  @ViewChild('tilt', { static: true }) tiltRef!: ElementRef<HTMLElement>;

  private readonly zone = inject(NgZone);
  private readonly reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly spring: TiltSpring = { x: 0, y: 0, tx: 0, ty: 0 };
  private frame = 0;

  tier: HoloTier = 'c';
  flipped = false;

  get imageSrc(): string {
    return this.imageUrl || this.card.cardImage;
  }

  get hostWidth(): string {
    return this.size ? `${this.size}px` : '100%';
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['card'] || changes['variant']) && this.card) {
      this.tier = holoTierOf(this.card, this.variant);
      if (!changes['card'].firstChange) this.flipped = false;
    }
  }

  ngAfterViewInit(): void {
    const el = this.tiltRef.nativeElement;
    this.zone.runOutsideAngular(() => {
      el.addEventListener('pointermove', this.onPointerMove);
      el.addEventListener('pointerleave', this.onPointerRelease);
      el.addEventListener('pointercancel', this.onPointerRelease);
      el.addEventListener('pointerup', this.onPointerUp);
    });
  }

  ngOnDestroy(): void {
    // Guard: ngOnDestroy also runs during server prerendering, where rAF does not exist.
    if (this.frame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.frame);
    this.frame = 0;
    const el = this.tiltRef?.nativeElement;
    el?.removeEventListener('pointermove', this.onPointerMove);
    el?.removeEventListener('pointerleave', this.onPointerRelease);
    el?.removeEventListener('pointercancel', this.onPointerRelease);
    el?.removeEventListener('pointerup', this.onPointerUp);
  }

  flip(): void {
    this.flipped = !this.flipped;
  }

  onKey(event: Event): void {
    event.preventDefault();
    this.flip();
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const el = this.tiltRef.nativeElement;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    const y = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
    this.setTarget(x, y);
  };

  private readonly onPointerRelease = (): void => {
    this.setTarget(0, 0);
  };

  // Touch has no hover: release the tilt once the finger lifts.
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') this.setTarget(0, 0);
  };

  private setTarget(x: number, y: number): void {
    const el = this.tiltRef.nativeElement;
    this.spring.tx = x;
    this.spring.ty = y;
    el.classList.add('is-active');
    if (this.reduceMotion) {
      // No spring for reduced motion: jump straight to the target.
      this.spring.x = x;
      this.spring.y = y;
      this.write(x, y);
      if (x === 0 && y === 0) el.classList.remove('is-active');
      return;
    }
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (): void => {
    this.frame = 0;
    const el = this.tiltRef.nativeElement;
    const s = this.spring;
    s.x += (s.tx - s.x) * 0.14;
    s.y += (s.ty - s.y) * 0.14;
    const settled = s.tx === 0 && s.ty === 0 && Math.abs(s.x) < 0.001 && Math.abs(s.y) < 0.001;
    if (settled) {
      s.x = 0;
      s.y = 0;
      this.write(0, 0);
      el.classList.remove('is-active');
      return;
    }
    this.write(s.x, s.y);
    this.frame = requestAnimationFrame(this.tick);
  };

  // Writes the holo custom properties read by the card layers in the stylesheet.
  private write(x: number, y: number): void {
    const el = this.tiltRef.nativeElement;
    const max = this.reduceMotion ? 0 : TILT_MAX;
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
