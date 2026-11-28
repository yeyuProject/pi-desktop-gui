const root = document.documentElement;
let resizeTimer: number | undefined;

export function pauseGlassForResize() {
  root.dataset.resizing = '';
  window.clearTimeout(resizeTimer);
  if (!document.body.classList.contains('resizing-columns'))
    resizeTimer = window.setTimeout(() => delete root.dataset.resizing, 150);
}

const popovers = [
  '.modal',
  '.context-menu',
  '.model-picker',
  '.approval-menu',
  '.goal-budget-popover',
  '.message-menu-popover',
  '.selection-menu',
  '.context-popover',
  '.command-picker',
  '.file-picker',
  '.attention-menu[open] > div',
  '.turn-panel',
].join(', ');

/**
 * 1. 浮层增删、开合或目录淡出结束后才重选。
 * 2. 玻璃留给最上面的可见浮层，目录完全淡出后才释放。
 * 3. 关闭玻璃后清除标记和监听。
 */
export function watchGlassLayers() {
  let current: HTMLElement | undefined;
  const selectLayer = () => {
    // 2. 目录收起后仍在 DOM 中，淡出期间仍算可见。弹窗和目录按外框层级排序。
    let top: HTMLElement | undefined;
    let topZ = -Infinity;
    for (const popup of document.querySelectorAll<HTMLElement>(popovers)) {
      if (!popup.getClientRects().length || popup.parentElement?.closest('.modal')) continue;
      if (
        popup.matches('.turn-panel') &&
        !popup.closest('.turn-outline.expanded') &&
        getComputedStyle(popup).opacity === '0'
      )
        continue;
      const layer = popup.closest('.modal-backdrop, .turn-outline') ?? popup;
      const z = Number(getComputedStyle(layer).zIndex) || 0;
      if (z < topZ) continue;
      top = popup;
      topZ = z;
    }
    if (current === top) return;
    current?.removeAttribute('data-glass-layer');
    current = top;
    if (current) current.dataset.glassLayer = '';
  };
  const affected = (node: Node) =>
    node instanceof Element && (node.matches(popovers) || node.querySelector(popovers) !== null);
  const observer = new MutationObserver((records) => {
    // 1. 目录和提醒列表开合时仍在 DOM 中，需要监听状态变化。
    if (
      records.some(({ target, type, addedNodes, removedNodes }) =>
        type === 'attributes'
          ? (target as Element).matches('.turn-outline, .attention-menu') || target === current
          : Array.from(addedNodes).some(affected) || Array.from(removedNodes).some(affected),
      ) ||
      (current && !current.isConnected)
    )
      selectLayer();
  });
  const onPanelFade = (event: TransitionEvent) => {
    if (
      event.propertyName === 'opacity' &&
      event.target instanceof Element &&
      event.target.matches('.turn-panel')
    )
      selectLayer();
  };
  selectLayer();
  document.addEventListener('transitionend', onPanelFade);
  document.addEventListener('transitioncancel', onPanelFade);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'open', 'hidden'],
  });
  // 3. 换主题或系统要求降级时，后续消息更新不再触发这个监听。
  return () => {
    observer.disconnect();
    document.removeEventListener('transitionend', onPanelFade);
    document.removeEventListener('transitioncancel', onPanelFade);
    current?.removeAttribute('data-glass-layer');
  };
}
