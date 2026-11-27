// Zoom Inherit: a tab opened from another tab starts at the opener's zoom.
//
// How it works: Chrome normally stores zoom per origin. For an inheriting
// child tab, we switch that tab to "per-tab" zoom scope and set the parent's
// zoom factor, so the child gets the zoom without overwriting the saved zoom
// for the child's site. Chrome resets per-tab zoom on every navigation, so we
// re-apply it after each main-frame commit.

// true:  the inherited zoom sticks with the child tab as it navigates
//        (including any manual zoom changes you make in that tab).
// false: only the first page in the child inherits; later navigations in that
//        tab fall back to Chrome's normal per-site zoom.
const STICKY = true;

const key = (tabId) => `z${tabId}`;
const pending = new Map(); // tabId -> Promise, guards the create/commit race

async function getOwned(tabId) {
  const k = key(tabId);
  return (await chrome.storage.session.get(k))[k];
}
const setOwned = (tabId, zoom) => chrome.storage.session.set({ [key(tabId)]: zoom });
const clearOwned = (tabId) => chrome.storage.session.remove(key(tabId));

function inherit(childId, parentId) {
  if (childId == null || parentId == null || childId === parentId) return;
  const p = (async () => {
    try {
      const zoom = await chrome.tabs.getZoom(parentId);
      await setOwned(childId, zoom);
    } catch {
      // Parent closed or not zoomable (chrome:// pages, etc.). Nothing to inherit.
    }
  })();
  pending.set(childId, p);
  p.finally(() => { if (pending.get(childId) === p) pending.delete(childId); });
}

// Links with target=_blank, middle/ctrl-click, window.open, "Open link in new tab".
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
  inherit(tabId, sourceTabId);
});

// Fallback for anything that sets an opener but skips the event above.
// Skip blank new-tab pages (Ctrl+T can set an opener too).
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null) return;
  const url = tab.pendingUrl || tab.url || "";
  if (/^(chrome:\/\/newtab|chrome-search:|about:blank$)/.test(url)) return;
  if (pending.has(tab.id)) return;
  inherit(tab.id, tab.openerTabId);
});

// Chrome resets per-tab zoom on navigation, so apply it after each commit.
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId }) => {
  if (frameId !== 0) return;
  await pending.get(tabId);
  const zoom = await getOwned(tabId);
  if (zoom == null) return;
  try {
    await chrome.tabs.setZoomSettings(tabId, { mode: "automatic", scope: "per-tab" });
    await chrome.tabs.setZoom(tabId, zoom);
  } catch {
    // Some pages can't be zoomed by extensions; ignore.
  }
  if (!STICKY) await clearOwned(tabId);
});

// Remember manual zoom changes made inside an inheriting tab.
chrome.tabs.onZoomChange.addListener(async ({ tabId, newZoomFactor, zoomSettings }) => {
  if (!STICKY || zoomSettings?.scope !== "per-tab") return;
  if ((await getOwned(tabId)) == null) return;
  await setOwned(tabId, newZoomFactor);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pending.delete(tabId);
  clearOwned(tabId);
});
