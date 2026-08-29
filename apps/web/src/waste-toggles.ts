import type { WasteToggleId } from "./api";

export const TOGGLE_PERSIST_FAILED =
  "浪费开关未能保存，也无法刷新当前会话。";

export function nextToggleState(
  toggles: Record<WasteToggleId, boolean>,
  id: WasteToggleId,
  checked: boolean,
): Record<WasteToggleId, boolean> {
  return { ...toggles, [id]: checked };
}

export function persistToggleError(
  patchFailed: boolean,
  refreshFailed: boolean,
): string | null {
  return patchFailed && refreshFailed ? TOGGLE_PERSIST_FAILED : null;
}
