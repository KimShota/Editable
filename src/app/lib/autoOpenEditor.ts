/**
 * When a video the founder was watching finishes, the editor opens by itself
 * (the next thing they do is look at it). Not on a phone: the editor is built
 * for a wide screen, and sending someone there to a cramped page is worse than
 * leaving them where they were.
 */
export const canAutoOpenEditor = (): boolean => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;

/** The editor for a card's finished video (founder: from internal review; customer: once sent to them). */
export const editorPath = (cardId: string): string => `/videos/${cardId}/edit`;
