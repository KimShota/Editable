/**
 * A small hand-rolled icon set for the editor — one stroke weight (1.5),
 * one viewBox (0 0 24 24), sized/colored entirely via className. Kept as
 * plain inline SVG rather than a dependency: a dozen icons doesn't
 * justify an icon library, and currentColor means every icon inherits
 * hover/selected/disabled color for free.
 */

type IconProps = { className?: string };

const base = "none";

export const PlayIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} className={className}>
    <path d="M7 5.5v13a1 1 0 0 0 1.53.85l10.4-6.5a1 1 0 0 0 0-1.7l-10.4-6.5A1 1 0 0 0 7 5.5Z" fill="currentColor" />
  </svg>
);

export const PauseIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} className={className}>
    <rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" />
    <rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" />
  </svg>
);

export const SkipStartIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M6 5v14" />
    <path d="M18 6.5v11a1 1 0 0 1-1.55.84L9 13.84a1 1 0 0 1 0-1.68l7.45-4.5A1 1 0 0 1 18 6.5Z" />
  </svg>
);

export const SkipEndIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M18 5v14" />
    <path d="M6 6.5v11a1 1 0 0 0 1.55.84L15 13.84a1 1 0 0 0 0-1.68l-7.45-4.5A1 1 0 0 0 6 6.5Z" />
  </svg>
);

export const FrameBackIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M4 5v14" />
    <path d="M20 6.3v11.4a.9.9 0 0 1-1.38.76L10.5 13.16a.9.9 0 0 1 0-1.52l8.12-5.3A.9.9 0 0 1 20 6.3Z" />
  </svg>
);

export const FrameForwardIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M20 5v14" />
    <path d="M4 6.3v11.4a.9.9 0 0 0 1.38.76l8.12-5.3a.9.9 0 0 0 0-1.52l-8.12-5.3A.9.9 0 0 0 4 6.3Z" />
  </svg>
);

export const ScissorsIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="6.5" cy="6.5" r="2.25" />
    <circle cx="6.5" cy="17.5" r="2.25" />
    <path d="M8.3 8 19 18M8.3 16 19 6" />
  </svg>
);

export const TrashIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M5 7h14" />
    <path d="M9.5 7V5.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
    <path d="M7 7l.8 12a1 1 0 0 0 1 .9h6.4a1 1 0 0 0 1-.9L17 7" />
    <path d="M10.2 10.5v6M13.8 10.5v6" />
  </svg>
);

export const CloseIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className={className}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const ZoomOutIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M20 20l-4.7-4.7M7.7 10.5h5.6" />
  </svg>
);

export const ZoomInIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M20 20l-4.7-4.7M10.5 7.7v5.6M7.7 10.5h5.6" />
  </svg>
);

export const FitIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5V9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15M15 20h3.5a1.5 1.5 0 0 0 1.5-1.5V15" />
  </svg>
);

export const VolumeIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M4 9.5v5h3.2L12 18.5v-13L7.2 9.5H4Z" />
    <path d="M16 9a4 4 0 0 1 0 6" />
    <path d="M18.3 6.7a7.5 7.5 0 0 1 0 10.6" />
  </svg>
);

export const MusicNoteIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M9 17.5V6l9-1.5v11.5" />
    <circle cx="6.5" cy="17.5" r="2.5" />
    <circle cx="15.5" cy="16" r="2.5" />
  </svg>
);

export const UndoIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M8 15 3 10 8 5" />
    <path d="M3 10h9a6 6 0 0 1 6 6v1" />
  </svg>
);

export const RedoIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M16 15 21 10 16 5" />
    <path d="M21 10h-9a6 6 0 0 0-6 6v1" />
  </svg>
);

export const ArrowLeftIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);

export const CheckIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </svg>
);

export const ChevronDownIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill={base} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
