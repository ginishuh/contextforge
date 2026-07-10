const activeChildren = new Set();

export function registerRuntimeChild(child) {
  if (!child || typeof child.kill !== 'function') return () => {};
  activeChildren.add(child);
  let removed = false;
  const unregister = () => {
    if (removed) return;
    removed = true;
    activeChildren.delete(child);
  };
  child.once?.('close', unregister);
  child.once?.('error', unregister);
  return unregister;
}

export function runtimeChildSnapshot() {
  return { active: activeChildren.size };
}

export function terminateRuntimeChildren({ killAfterMs = 1000 } = {}) {
  const children = [...activeChildren];
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      activeChildren.delete(child);
    }
  }
  if (children.length > 0) {
    const timer = setTimeout(() => {
      for (const child of children) {
        if (!activeChildren.has(child)) continue;
        try {
          child.kill('SIGKILL');
        } catch {
          activeChildren.delete(child);
        }
      }
    }, killAfterMs);
    timer.unref?.();
  }
  return { signaled: children.length, killAfterMs };
}
