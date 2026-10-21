/* Vanilla click-time loader. Core produces the deferred tags, including inline middleware. */
(() => {
  const root = document.getElementById('gq-support-root');
  if (!root) return;
  const button = root.querySelector('.gq-support-launcher');
  const status = root.querySelector('.gq-support-launcher-status');
  const indicator = root.querySelector('.gq-support-draft-indicator');
  const help = root.querySelector('.gq-support-launcher-help');
  let nodes;
  let next = 0;
  // One load per template node, kept across attempts: a retry waits for a slow node instead of inserting it twice.
  const loads = [];
  // Only the current explicit attempt may report or mount; a timed-out one is abandoned.
  let attempt = 0;
  let loading = false;
  let mounted = false;

  // The panel reports its state; the launcher keeps its own button in sync.
  function onVisibilityChange(visible, hasDraft) {
    button.setAttribute('aria-expanded', String(visible));
    if (visible) button.setAttribute('aria-controls', 'gq-support-panel');
    indicator.hidden = visible || !hasDraft;
    if (!visible) button.focus();
  }

  function showStatus(message, failed) {
    status.textContent = message;
    status.classList.toggle('gq-support-sr-only', !failed);
    if (help) help.hidden = !failed;
  }

  function load(index) {
    if (!loads[index]) {
      const source = nodes[index];
      const tag = source.tagName.toLowerCase();
      const node = document.createElement(tag);
      for (const { name, value } of source.attributes) node.setAttribute(name, value);
      if (tag === 'script' && !source.src) node.textContent = source.textContent;
      // Attach listeners before inserting; inline scripts run synchronously on insertion.
      loads[index] = source.src || (tag === 'link' && source.rel === 'stylesheet')
        ? new Promise((resolve, reject) => {
            node.addEventListener('load', resolve, { once: true });
            node.addEventListener('error', () => {
              node.remove();
              loads[index] = null;
              reject(new Error('Support asset failed'));
            }, { once: true });
          })
        : Promise.resolve();
      document.head.appendChild(node);
    }
    return loads[index];
  }

  function fail(current) {
    if (current !== attempt) return;
    attempt++;
    loading = false;
    showStatus(window.gqSupportLauncher.error, true);
  }

  async function onLauncherClick() {
    if (loading) return;
    if (mounted) {
      window.gqSupportToggle();
      return;
    }
    loading = true;
    const current = ++attempt;
    if (!nodes) {
      const template = document.getElementById('gq-support-app-assets');
      nodes = template ? Array.from(template.content.children) : [];
    }
    showStatus(window.gqSupportLauncher.loading, false);
    // Ten seconds in total per explicit attempt; there is no automatic retry.
    const watchdog = setTimeout(() => fail(current), 10000);
    try {
      while (next < nodes.length) {
        await load(next);
        if (current !== attempt) return;
        next++;
      }
      if (typeof window.gqSupportMount !== 'function') throw new Error('Support app unavailable');
      window.gqSupportMount(root, onVisibilityChange);
      mounted = true;
      loading = false;
      showStatus('', false);
    } catch (error) {
      fail(current);
    } finally {
      clearTimeout(watchdog);
    }
  }
  button.addEventListener('click', onLauncherClick);
  // Leaving the page unmounts the panel; the next click mounts a new one.
  window.addEventListener('pagehide', () => button.removeAttribute('aria-controls'));
})();
