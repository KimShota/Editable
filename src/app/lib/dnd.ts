/** Custom drag-data MIME type used to drag a Library asset onto a format slot. */
export const LIBRARY_DRAG_MIME = "application/x-editable-library-asset";

export type LibraryDragPayload = { category: string; filename: string; mediaUrl: string };
