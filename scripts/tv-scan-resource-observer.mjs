// Pure parsers only. No ADB, process launch, file writes or application mutation.
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const incomplete = (reason) => ({ status: 'incomplete', reason, rendererPids: [] });
export function parseSelectedWebViewProvider(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) return null;
  const match =
    /Current WebView package \(name, version\):\s*\(([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+),/.exec(
      text,
    );
  return match && match[1].length <= 256 ? match[1] : null;
}
export function parseRendererBindings(
  processes,
  services,
  appPid,
  expectedPackage = 'com.tmg.tv',
  verifiedProviderPackage,
) {
  // The runner separately pins APK/PID/start ticks. AM records prove service
  // association only; this parser cannot infer a process's creation epoch.
  const packageName = expectedPackage;
  if (
    !Number.isSafeInteger(appPid) ||
    appPid <= 0 ||
    !['com.tmg.tv', 'com.tmg.tv.scanproof'].includes(packageName) ||
    (verifiedProviderPackage !== undefined &&
      (typeof verifiedProviderPackage !== 'string' ||
        verifiedProviderPackage.length > 256 ||
        !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(verifiedProviderPackage))) ||
    typeof processes !== 'string' ||
    typeof services !== 'string' ||
    processes.length > 8 * 1024 * 1024 ||
    services.length > 8 * 1024 * 1024
  )
    return incomplete('invalid-input');
  const blocks = processes.split(/(?=^\s*\*APP\b)/m);
  const owned = blocks.filter((block) =>
    new RegExp(
      `^\\s*\\*APP[^\\n]*ProcessRecord\\{[^}]*\\b${appPid}:${escape(packageName)}(?:/|\\})`,
      'm',
    ).test(block),
  );
  if (owned.length !== 1 || !/\bmConnections\b/.test(owned[0]))
    return incomplete('owned-connections-unavailable');
  const components = [
    ...new Set(
      [
        ...owned[0].matchAll(
          /ConnectionRecord\{[^\r\n]*?([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+\/org\.chromium\.content\.app\.SandboxedProcessService\d+(?::\d+)?)(?=:[\s}@]|:$|[\s}]|$)/gm,
        ),
      ]
        .map((match) => match[1])
        .filter(
          (component) =>
            verifiedProviderPackage === undefined ||
            [packageName, verifiedProviderPackage].includes(component.split('/')[0]),
        ),
    ),
  ];
  if (!components.length || components.length > 16)
    return incomplete('renderer-connections-unavailable');
  const serviceBlocks = services.split(/(?=^\s*\*\s*ServiceRecord\{)/m);
  const pids = new Set();
  for (const component of components) {
    const matched = serviceBlocks.filter((block) =>
      new RegExp(
        `^\\s*\\*\\s*ServiceRecord\\{[^\\r\\n]*\\s${escape(component)}(?=[\\s}])`,
        'm',
      ).test(block),
    );
    if (matched.length !== 1) return incomplete('service-link-ambiguous');
    const binding = /\bapp=ProcessRecord\{[^}]*?\b(\d+):([^\s/}]+)/.exec(matched[0]);
    if (
      !binding ||
      !/:sandboxed_process\d+(?::|$)/.test(binding[2]) ||
      (verifiedProviderPackage !== undefined &&
        ![packageName, verifiedProviderPackage].includes(binding[2].split(':')[0]))
    )
      return incomplete('renderer-process-unavailable');
    const pid = Number(binding[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === appPid)
      return incomplete('renderer-identity-invalid');
    pids.add(pid);
  }
  return {
    status: 'measured',
    reason: 'service-connections',
    rendererPids: [...pids].sort((a, b) => a - b),
  };
}
export function parseProcessMemory(text) {
  const pss = /TOTAL PSS:\s*(\d+)/.exec(text) ?? /^\s*TOTAL\s+(\d+)\s+/m.exec(text);
  const rss = /TOTAL RSS:\s*(\d+)/.exec(text);
  const native = /^\s*Native Heap\s+(\d+)\b/m.exec(text);
  const dalvik = /^\s*Dalvik Heap\s+(\d+)\b/m.exec(text);
  return {
    pssKiB: pss ? Number(pss[1]) : null,
    rssKiB: rss ? Number(rss[1]) : null,
    nativeHeapPssKiB: native ? Number(native[1]) : null,
    dalvikHeapPssKiB: dalvik ? Number(dalvik[1]) : null,
  };
}
export function scanResourceSample(mainHeap, app, rendererBinding, renderers) {
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const main = {
    usedSize: finite(mainHeap?.usedSize) ? mainHeap.usedSize : null,
    totalSize: finite(mainHeap?.totalSize) ? mainHeap.totalSize : null,
    embedderHeapUsedSize: finite(mainHeap?.embedderHeapUsedSize)
      ? mainHeap.embedderHeapUsedSize
      : null,
    backingStorageSize: finite(mainHeap?.backingStorageSize) ? mainHeap.backingStorageSize : null,
  };
  const complete =
    main.usedSize !== null &&
    main.totalSize !== null &&
    finite(app?.pssKiB) &&
    rendererBinding.status === 'measured' &&
    rendererBinding.rendererPids.length > 0 &&
    rendererBinding.rendererPids.length === renderers.length &&
    renderers.every(
      (row) => rendererBinding.rendererPids.includes(row.pid) && finite(row.pssKiB),
    ) &&
    new Set(renderers.map((row) => row.pid)).size === renderers.length;
  return {
    coverage: complete ? 'measured' : 'incomplete',
    mainHeap: main,
    app,
    rendererBinding,
    renderers,
    attributablePssKiB: complete
      ? app.pssKiB + renderers.reduce((sum, row) => sum + row.pssKiB, 0)
      : null,
  };
}
