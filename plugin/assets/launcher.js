/* Vanilla click-time loader. Core produces the deferred tags, including inline middleware. */
(() => {
  const root = document.getElementById('gq-support-root');
  if (!root) return;
  const button = root.querySelector('.gq-support-launcher');
  const status = root.querySelector('.gq-support-launcher-status');
  const indicator = root.querySelector('.gq-support-draft-indicator');
  let nodes;
  let next = 0;
  let loading = false;
  let mounted = false;

  // The panel reports its state; the launcher keeps its own button in sync.
  function onVisibilityChange(visible, hasDraft) {
    button.setAttribute('aria-expanded', String(visible));
    indicator.hidden = visible || !hasDraft;
    if (!visible) button.focus();
  }

  function showStatus(message, visible) {
    status.textContent = message;
    status.classList.toggle('gq-support-sr-only', !visible);
  }

  async function onLauncherClick() {
    if (loading) return;
    if (mounted) {
      window.gqSupportToggle();
      return;
    }
    loading = true;
    if (!nodes) {
      const template = document.getElementById('gq-support-app-assets');
      nodes = template ? Array.from(template.content.children) : [];
    }
    showStatus(window.gqSupportLauncher.loading, false);
    try {
      while (next < nodes.length) {
        const source = nodes[next];
        const tag = source.tagName.toLowerCase();
        const node = document.createElement(tag);
        for (const { name, value } of source.attributes) node.setAttribute(name, value);
        if (tag === 'script' && !source.src) node.textContent = source.textContent;
        // Attach listeners before inserting; inline scripts run synchronously on insertion.
        const pending = source.src || (tag === 'link' && source.rel === 'stylesheet')
          ? new Promise((resolve, reject) => {
              node.addEventListener('load', resolve, { once: true });
              node.addEventListener('error', reject, { once: true });
            })
          : null;
        document.head.appendChild(node);
        if (pending) {
          try {
            await pending;
          } catch (error) {
            node.remove();
            throw error;
          }
        }
        next++;
      }
      if (typeof window.gqSupportMount !== 'function') throw new Error('Support app unavailable');
      window.gqSupportMount(root, onVisibilityChange);
      mounted = true;
      button.setAttribute('aria-controls', 'gq-support-panel');
      showStatus('', false);
    } catch (error) {
      showStatus(window.gqSupportLauncher.error, true);
    } finally {
      loading = false;
    }
  }
  button.addEventListener('click', onLauncherClick);
})();
