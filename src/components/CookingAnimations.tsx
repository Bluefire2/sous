import { useId, type CSSProperties } from 'react';
import './cookingAnimations.css';

/*
 * Ten looping kitchen animations for the Import screen's busy overlay
 * (ImportBusyOverlay). Drawn in a 160 x 160 box for a dark backdrop; the
 * motion lives in cookingAnimations.css. Decorative only: every SVG is
 * aria-hidden, and the overlay's own text says what is happening.
 */

/** Splash and flour particles drift sideways by this much. */
const dx = (value: string) => ({ '--dx': value }) as CSSProperties;

/** A clip-path id that is unique per mounted copy and safe inside url(#…). */
function useSvgId() {
  return 'ca' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Whisk in a bowl. */
function Whisk() {
  return (
    <svg viewBox="0 0 160 160" aria-hidden="true" className="ca-svg">
      <ellipse cx="80" cy="88" rx="52" ry="11" className="ca-st ca-thin" />
      <g className="ca-whisk">
        <line x1="80" y1="18" x2="80" y2="52" className="ca-st" strokeWidth="6" />
        <path className="ca-st ca-thin" d="M80 52 C66 66 64 88 80 98 C96 88 94 66 80 52 Z" />
        <path className="ca-st ca-thin" d="M80 52 C72 66 72 88 80 98 C88 88 88 66 80 52" />
      </g>
      <ellipse cx="80" cy="92" rx="45" ry="7" fill="var(--a-warm)" />
      <path className="ca-swirl" d="M50 92 a30 4.5 0 1 0 60 0 a30 4.5 0 1 0 -60 0" />
      <path className="ca-swirl ca-b" d="M62 92 a18 2.5 0 1 1 36 0 a18 2.5 0 1 1 -36 0" />
      <circle className="ca-splash" cx="70" cy="88" r="3" style={dx('-10px')} />
      <circle className="ca-splash ca-r" cx="92" cy="88" r="2.5" style={dx('10px')} />
      <path d="M28 88 C30 128 52 142 80 142 C108 142 130 128 132 88 C118 96 42 96 28 88 Z" fill="var(--a-fill)" />
      <path className="ca-st" d="M28 88 C30 128 52 142 80 142 C108 142 130 128 132 88" />
      <line x1="64" y1="148" x2="96" y2="148" className="ca-st ca-thin" />
    </svg>
  );
}

/** Simmering pot. */
function SimmeringPot() {
  return (
    <svg viewBox="0 0 160 160" aria-hidden="true" className="ca-svg">
      <path className="ca-steam" d="M62 48 c-6 -8 6 -12 0 -20 c-6 -8 6 -12 0 -18" />
      <path className="ca-steam ca-s2" d="M80 46 c-6 -8 6 -12 0 -20 c-6 -8 6 -12 0 -18" />
      <path className="ca-steam ca-s3" d="M98 48 c-6 -8 6 -12 0 -20 c-6 -8 6 -12 0 -18" />
      <g className="ca-lid">
        <path className="ca-st" d="M38 66 C44 52 116 52 122 66 Z" fill="var(--a-fill)" />
        <rect x="72" y="46" width="16" height="7" rx="3.5" className="ca-st ca-thin" fill="var(--a-warm)" />
      </g>
      <path className="ca-st" d="M36 70 H124 V112 C124 122 116 128 106 128 H54 C44 128 36 122 36 112 Z" fill="var(--a-fill)" />
      <path className="ca-st ca-thin" d="M36 80 H24 M124 80 H136" />
      <line x1="48" y1="90" x2="112" y2="90" className="ca-st ca-thin" strokeOpacity=".35" />
      <path className="ca-flame" d="M62 146 c-6 -6 -3 -14 2 -16 c0 6 6 6 4 12 c-1 3 -4 5 -6 4 Z" />
      <path className="ca-flame ca-f2" d="M78 147 c-7 -7 -3 -17 3 -19 c0 7 7 8 5 14 c-1 4 -5 6 -8 5 Z" />
      <path className="ca-flame ca-f3" d="M96 146 c-6 -6 -3 -14 2 -16 c0 6 6 6 4 12 c-1 3 -4 5 -6 4 Z" />
      <line x1="44" y1="150" x2="116" y2="150" className="ca-st ca-thin" />
    </svg>
  );
}

/** Recipe card writes itself. */
function RecipeCard() {
  return (
    <svg viewBox="0 0 160 160" aria-hidden="true" className="ca-svg">
      <g className="ca-card">
        <rect x="34" y="20" width="92" height="120" rx="10" fill="var(--a-ink)" />
        <rect x="34" y="20" width="92" height="22" rx="10" fill="var(--a-warm)" />
        <rect x="34" y="32" width="92" height="10" fill="var(--a-warm)" />
        <rect className="ca-card-line" x="46" y="27" width="50" height="7" rx="3.5" fill="#292524" style={{ animationDelay: '0s' }} />
        <circle className="ca-card-dot" cx="50" cy="58" r="3.5" fill="var(--a-green)" style={{ animationDelay: '.25s' }} />
        <rect className="ca-card-line" x="58" y="55" width="52" height="6" rx="3" fill="#a8a29e" style={{ animationDelay: '.3s' }} />
        <circle className="ca-card-dot" cx="50" cy="72" r="3.5" fill="var(--a-red)" style={{ animationDelay: '.5s' }} />
        <rect className="ca-card-line" x="58" y="69" width="38" height="6" rx="3" fill="#a8a29e" style={{ animationDelay: '.55s' }} />
        <circle className="ca-card-dot" cx="50" cy="86" r="3.5" fill="var(--a-warm)" style={{ animationDelay: '.75s' }} />
        <rect className="ca-card-line" x="58" y="83" width="46" height="6" rx="3" fill="#a8a29e" style={{ animationDelay: '.8s' }} />
        <rect className="ca-card-line" x="46" y="102" width="68" height="5" rx="2.5" fill="#d6d3d1" style={{ animationDelay: '1.1s' }} />
        <rect className="ca-card-line" x="46" y="112" width="60" height="5" rx="2.5" fill="#d6d3d1" style={{ animationDelay: '1.3s' }} />
        <rect className="ca-card-line" x="46" y="122" width="44" height="5" rx="2.5" fill="#d6d3d1" style={{ animationDelay: '1.5s' }} />
      </g>
    </svg>
  );
}

/** Pancake toss. */
function PancakeToss() {
  return (
    <svg viewBox="0 0 160 160" aria-hidden="true" className="ca-svg">
      <g transform="translate(-17 -8) scale(1.1)">
        <path className="ca-sizzle" d="M54 86 c-3 -4 3 -6 0 -10" />
        <path className="ca-sizzle ca-z2" d="M70 84 c-3 -4 3 -6 0 -10" />
        <path className="ca-sizzle ca-z3" d="M86 86 c-3 -4 3 -6 0 -10" />
        <g className="ca-pan">
          <line x1="112" y1="98" x2="150" y2="86" stroke="var(--a-tile-muted)" strokeWidth="10" strokeLinecap="round" />
          <line x1="113" y1="97.7" x2="150" y2="86" stroke="var(--a-wood)" strokeWidth="7" strokeLinecap="round" />
          <circle cx="145" cy="87.6" r="1.6" fill="var(--a-tile)" />
          <path d="M26 100 C26 116 42 122 70 122 C98 122 114 116 114 100 Z" fill="var(--a-steel-dark)" stroke="var(--a-tile-muted)" strokeWidth="1.5" />
          <ellipse cx="70" cy="100" rx="44" ry="12" fill="var(--a-steel-light)" stroke="var(--a-tile-muted)" strokeWidth="1.5" />
          <ellipse cx="70" cy="101" rx="39" ry="9.5" fill="var(--a-steel)" />
          <path d="M36 97 A38 8 0 0 1 70 91.5" fill="none" stroke="var(--a-tile-ink)" strokeWidth="1.5" strokeLinecap="round" opacity=".45" />
          <ellipse className="ca-lift-shadow" cx="70" cy="102" rx="26" ry="5.5" fill="#000" />
          <g className="ca-cake-move">
            <rect x="42" y="99" width="56" height="4" rx="2" fill="var(--a-brown)" />
            <g className="ca-cake-flip">
              <ellipse cx="70" cy="102.5" rx="30" ry="8" fill="var(--a-brown)" />
              <g className="ca-face-a">
                <ellipse cx="70" cy="100" rx="30" ry="8" fill="var(--a-warm-soft)" />
                <ellipse cx="61" cy="99" rx="4" ry="1.6" fill="var(--a-gold)" opacity=".7" />
                <ellipse cx="76" cy="102" rx="3" ry="1.3" fill="var(--a-gold)" opacity=".7" />
                <ellipse cx="81" cy="97.5" rx="2.4" ry="1" fill="var(--a-gold)" opacity=".7" />
              </g>
              <g className="ca-face-b">
                <ellipse cx="70" cy="100" rx="30" ry="8" fill="var(--a-warm)" />
                <ellipse cx="70" cy="100" rx="19" ry="4.6" fill="var(--a-gold)" />
                <ellipse cx="64" cy="99.5" rx="5" ry="1.6" fill="var(--a-brown)" opacity=".6" />
                <ellipse cx="77" cy="101" rx="3.5" ry="1.2" fill="var(--a-brown)" opacity=".6" />
              </g>
            </g>
          </g>
          <path d="M26 100 A44 12 0 0 0 114 100 L109 101 A39 9.5 0 0 1 31 101 Z" fill="var(--a-steel-light)" stroke="var(--a-tile-muted)" strokeWidth="1.5" strokeLinejoin="round" />
        </g>
      </g>
    </svg>
  );
}

/** Ingredients orbit the pot. */
function IngredientOrbit() {
  return (
    <svg viewBox="0 0 160 160" aria-hidden="true" className="ca-svg">
      <circle className="ca-ring" cx="80" cy="80" r="56" />
      <g className="ca-core">
        <path className="ca-st" d="M54 76 C56 100 66 108 80 108 C94 108 104 100 106 76 Z" fill="var(--a-fill)" />
        <line x1="50" y1="76" x2="110" y2="76" className="ca-st" />
        <path className="ca-st ca-thin" d="M72 66 c-4 -5 4 -8 0 -13 M88 66 c-4 -5 4 -8 0 -13" strokeOpacity=".7" />
      </g>
      <g className="ca-orbit">
        <g><circle cx="80" cy="24" r="9" fill="var(--a-red)" /><path d="M80 15 l3 -4" stroke="var(--a-green)" strokeWidth="3" strokeLinecap="round" /></g>
        <g><path d="M131 63 l-14 22 l4 3 Z" fill="var(--a-warm)" /><path d="M131 63 l4 -6 M131 63 l6 -2" stroke="var(--a-green)" strokeWidth="2.5" strokeLinecap="round" /></g>
        <g><path d="M120 124 c-12 -2 -14 -14 -4 -20 c4 8 10 10 4 20 Z" fill="var(--a-green)" /></g>
        <g><ellipse cx="80" cy="136" rx="9" ry="7" fill="var(--a-ink)" /><path d="M80 129 v-5" stroke="var(--a-ink)" strokeWidth="2.5" strokeLinecap="round" /></g>
        <g><circle cx="35" cy="112" r="7" fill="var(--a-warm-soft)" /><circle cx="35" cy="112" r="3" fill="var(--a-warm)" /></g>
        <g><rect x="22" y="50" width="16" height="12" rx="3" fill="var(--a-ink)" transform="rotate(-12 30 56)" /></g>
      </g>
    </svg>
  );
}

/** Chef's knife. */
function ChefsKnife() {
  const uid = useSvgId();
  return (
    <svg viewBox="0 0 160 160" aria-hidden="true" className="ca-svg">
      <g transform="translate(-6 -22) scale(1.1)">
        <rect x="8" y="112" width="140" height="18" rx="6" fill="var(--a-wood)" />
        <line x1="14" y1="114.5" x2="142" y2="114.5" stroke="var(--a-gold)" strokeWidth="1.5" strokeLinecap="round" opacity=".45" />
        <defs><clipPath id={`${uid}-carrot-clip`}><rect className="ca-carrot-end" x="62" y="90" width="100" height="26" /></clipPath></defs>
        <g className="ca-carrot-fade">
          <g clipPath={`url(#${uid}-carrot-clip)`}>
            <path d="M62 96 H128 C142 97 150 102 150 104 C150 106 142 111 128 112 H62 Z" fill="var(--a-orange)" />
            <path d="M90 99.5 h7 M108 108.5 h8 M126 100.5 h6" stroke="var(--a-wood)" strokeWidth="1.5" strokeLinecap="round" opacity=".45" />
          </g>
          <g className="ca-carrot-end"><ellipse cx="62" cy="104" rx="3.2" ry="8" fill="var(--a-orange)" /><ellipse cx="62" cy="104" rx="1.8" ry="3.4" fill="var(--a-warm-soft)" /></g>
        </g>
        <g className="ca-knife-walk"><g className="ca-knife-rock">
            <path d="M14 112 C28 99 54 86 84 84 V112 C56 113 32 113 14 112 Z" fill="var(--a-tile-ink)" stroke="var(--a-ink)" strokeWidth="2" strokeLinejoin="round" />
            <path d="M22 108.5 C44 106.5 66 106.5 83 106.5" fill="none" stroke="var(--a-tile-muted)" strokeWidth="1.5" strokeLinecap="round" />
            <rect x="83" y="83" width="7" height="20" rx="2" fill="var(--a-tile-muted)" stroke="var(--a-ink)" strokeWidth="2" />
            <rect x="89" y="83.5" width="31" height="12" rx="6" fill="var(--a-wood)" stroke="var(--a-ink)" strokeWidth="2" />
            <circle cx="98" cy="89.5" r="1.6" fill="var(--a-tile-ink)" /><circle cx="111" cy="89.5" r="1.6" fill="var(--a-tile-ink)" />
          </g></g>
        <g className="ca-slice ca-k0"><ellipse cx="66" cy="104" rx="4.5" ry="8" fill="var(--a-orange)" stroke="var(--a-warm-soft)" strokeWidth="1.2" /><ellipse cx="66" cy="104" rx="1.8" ry="3.4" fill="var(--a-warm-soft)" /></g>
        <g className="ca-slice ca-k1"><ellipse cx="74" cy="104" rx="4.5" ry="8" fill="var(--a-orange)" stroke="var(--a-warm-soft)" strokeWidth="1.2" /><ellipse cx="74" cy="104" rx="1.8" ry="3.4" fill="var(--a-warm-soft)" /></g>
        <g className="ca-slice ca-k2"><ellipse cx="82" cy="104" rx="4.5" ry="8" fill="var(--a-orange)" stroke="var(--a-warm-soft)" strokeWidth="1.2" /><ellipse cx="82" cy="104" rx="1.8" ry="3.4" fill="var(--a-warm-soft)" /></g>
        <g className="ca-slice ca-k3"><ellipse cx="90" cy="104" rx="4.5" ry="8" fill="var(--a-orange)" stroke="var(--a-warm-soft)" strokeWidth="1.2" /><ellipse cx="90" cy="104" rx="1.8" ry="3.4" fill="var(--a-warm-soft)" /></g>
      </g>
    </svg>
  );
}

/** Spice hourglass. */
function Hourglass() {
  const uid = useSvgId();
  return (
    <svg viewBox="0 0 160 160" aria-hidden="true" className="ca-svg">
      <defs>
        <clipPath id={`${uid}-hg-top`}><path className="ca-level-top" d="M30 0 H72 L80 8 L88 0 H130 V100 H30 Z" /></clipPath>
        <clipPath id={`${uid}-hg-bot`}><path className="ca-level-bot" d="M30 0 H70 L80 -8 L90 0 H130 V70 H30 Z" /></clipPath>
      </defs>
      <g className="ca-glass">
        <path d="M54 30 C54 58 76 70 77 80 H83 C84 70 106 58 106 30 Z" fill="var(--a-warm-soft)" clipPath={`url(#${uid}-hg-top)`} />
        <line className="ca-stream" x1="80" y1="80" x2="80" y2="130" />
        <path d="M54 130 C54 102 76 90 77 80 H83 C84 90 106 102 106 130 Z" fill="var(--a-warm-soft)" clipPath={`url(#${uid}-hg-bot)`} />
        <path className="ca-st ca-thin" d="M54 30 C54 58 76 70 77 80 C76 90 54 102 54 130 M106 30 C106 58 84 70 83 80 C84 90 106 102 106 130" />
        <line x1="47" y1="30" x2="47" y2="130" stroke="var(--a-wood)" strokeWidth="4" strokeLinecap="round" />
        <line x1="113" y1="30" x2="113" y2="130" stroke="var(--a-wood)" strokeWidth="4" strokeLinecap="round" />
        <rect x="40" y="22" width="80" height="9" rx="4" fill="var(--a-wood)" stroke="var(--a-ink)" strokeWidth="2" />
        <rect x="40" y="129" width="80" height="9" rx="4" fill="var(--a-wood)" stroke="var(--a-ink)" strokeWidth="2" />
      </g>
    </svg>
  );
}

/** Rolling pin. */
function RollingPin() {
  const uid = useSvgId();
  return (
    <svg viewBox="0 0 160 160" aria-hidden="true" className="ca-svg">
      <defs><clipPath id={`${uid}-pin-body`}><rect x="36" y="71" width="88" height="18" rx="7" /></clipPath></defs>
      <rect x="18" y="18" width="124" height="124" rx="12" fill="var(--a-wood)" opacity=".55" />
      <path d="M30 40 h40 M86 52 h40 M28 118 h36 M80 130 h44 M36 86 h10 M118 98 h12" stroke="var(--a-gold)" strokeWidth="1.5" strokeLinecap="round" opacity=".35" />
      <circle cx="34" cy="64" r="1.4" fill="var(--a-ink)" opacity=".6" /><circle cx="126" cy="72" r="1.2" fill="var(--a-ink)" opacity=".6" />
      <circle cx="40" cy="104" r="1" fill="var(--a-ink)" opacity=".6" /><circle cx="122" cy="112" r="1.4" fill="var(--a-ink)" opacity=".6" />
      <g className="ca-dough">
        <ellipse cx="80" cy="80" rx="40" ry="46" fill="var(--a-warm-soft)" stroke="var(--a-warm)" strokeWidth="2.5" />
        <circle cx="68" cy="70" r="1.6" fill="var(--a-ink)" opacity=".7" /><circle cx="92" cy="90" r="1.3" fill="var(--a-ink)" opacity=".7" /><circle cx="86" cy="64" r="1" fill="var(--a-ink)" opacity=".7" />
      </g>
      <g className="ca-pin">
        <rect x="14" y="75.5" width="24" height="9" rx="4.5" fill="var(--a-wood)" stroke="var(--a-ink)" strokeWidth="2" />
        <rect x="122" y="75.5" width="24" height="9" rx="4.5" fill="var(--a-wood)" stroke="var(--a-ink)" strokeWidth="2" />
        <rect x="36" y="71" width="88" height="18" rx="7" fill="var(--a-orange)" />
        <g clipPath={`url(#${uid}-pin-body)`}>
          <g className="ca-pin-turn">
            <path d="M36 51 H124 M36 59 H124 M36 67 H124 M36 75 H124 M36 83 H124 M36 91 H124" stroke="var(--a-wood)" strokeWidth="1.6" opacity=".45" />
          </g>
        </g>
        <rect x="36" y="71" width="88" height="18" rx="7" fill="none" stroke="var(--a-ink)" strokeWidth="2.5" />
        <path d="M42 75 H118" stroke="var(--a-warm-soft)" strokeWidth="2" strokeLinecap="round" opacity=".6" />
      </g>
    </svg>
  );
}

/** Page to card. */
function PageToCard() {
  return (
    <svg viewBox="0 0 160 160" aria-hidden="true" className="ca-svg">
      <rect x="10" y="40" width="60" height="78" rx="6" fill="var(--a-fill)" stroke="var(--a-ink)" strokeWidth="2.5" />
      <line x1="10" y1="52" x2="70" y2="52" stroke="var(--a-ink)" strokeWidth="2" />
      <circle cx="18" cy="46" r="2" fill="var(--a-red)" /><circle cx="25" cy="46" r="2" fill="var(--a-warm)" /><circle cx="32" cy="46" r="2" fill="var(--a-green)" />
      <rect className="ca-page-line" x="18" y="60" width="44" height="6" rx="3" fill="var(--a-tile-ink)" />
      <rect className="ca-page-line ca-l2" x="18" y="74" width="36" height="6" rx="3" fill="var(--a-tile-ink)" />
      <rect className="ca-page-line ca-l3" x="18" y="88" width="40" height="6" rx="3" fill="var(--a-tile-ink)" />
      <rect x="18" y="102" width="28" height="6" rx="3" fill="var(--a-tile-ink)" opacity=".2" />
      <rect x="92" y="36" width="58" height="86" rx="7" fill="var(--a-ink)" />
      <path d="M92 43 Q92 36 99 36 H143 Q150 36 150 43 V52 H92 Z" fill="var(--a-warm)" />
      <rect className="ca-slot" x="100" y="60" width="40" height="6" rx="3" fill="var(--a-green)" />
      <rect className="ca-slot ca-s2" x="100" y="74" width="32" height="6" rx="3" fill="var(--a-red)" />
      <rect className="ca-slot ca-s3" x="100" y="88" width="36" height="6" rx="3" fill="var(--a-warm)" />
      <rect x="100" y="102" width="28" height="6" rx="3" fill="var(--a-tile-muted)" />
      <rect className="ca-hop" x="26" y="59" width="18" height="8" rx="4" fill="var(--a-green)" />
      <rect className="ca-hop ca-h2" x="26" y="73" width="18" height="8" rx="4" fill="var(--a-red)" />
      <rect className="ca-hop ca-h3" x="26" y="87" width="18" height="8" rx="4" fill="var(--a-warm)" />
    </svg>
  );
}

/** Into the bowl. */
function IntoTheBowl() {
  return (
    <svg viewBox="0 0 160 160" aria-hidden="true" className="ca-svg">
      <ellipse cx="80" cy="84" rx="52" ry="11" className="ca-st ca-thin" />
      <ellipse cx="80" cy="88" rx="45" ry="7" fill="var(--a-warm)" />
      <g className="ca-drop"><circle cx="62" cy="82" r="7" fill="var(--a-red)" /><path d="M62 75 l2 -4" stroke="var(--a-green)" strokeWidth="2.5" strokeLinecap="round" /></g>
      <path className="ca-drop ca-d2" d="M82 88 c-10 -2 -12 -12 -2 -18 c4 7 8 9 2 18 Z" fill="var(--a-green)" />
      <rect className="ca-drop ca-d3" x="94" y="77" width="11" height="11" rx="2" fill="var(--a-ink)" />
      <ellipse className="ca-plop" cx="62" cy="88" rx="12" ry="3" />
      <ellipse className="ca-plop ca-d2" cx="81" cy="88" rx="12" ry="3" />
      <ellipse className="ca-plop ca-d3" cx="99" cy="88" rx="12" ry="3" />
      <path d="M28 84 C30 124 52 138 80 138 C108 138 130 124 132 84 C118 93 42 93 28 84 Z" fill="var(--a-fill)" />
      <path className="ca-st" d="M28 84 C30 124 52 138 80 138 C108 138 130 124 132 84" />
      <line x1="64" y1="144" x2="96" y2="144" className="ca-st ca-thin" />
    </svg>
  );
}

export const COOKING_ANIMATIONS = [
  Whisk,
  SimmeringPot,
  RecipeCard,
  PancakeToss,
  IngredientOrbit,
  ChefsKnife,
  Hourglass,
  RollingPin,
  PageToCard,
  IntoTheBowl,
] as const;
