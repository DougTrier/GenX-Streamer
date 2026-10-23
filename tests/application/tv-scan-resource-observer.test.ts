import { expect, it } from 'vitest';
import {
  parseSelectedWebViewProvider,
  parseRendererBindings,
  parseProcessMemory,
  scanResourceSample,
  // @ts-expect-error Pure root-executed JavaScript parser has no declaration file.
} from '../../scripts/tv-scan-resource-observer.mjs';
const processes = `*APP UID 10111 ProcessRecord{aa 100:com.tmg.tv/u0a111}
 mConnections:
 ConnectionRecord{bb com.tmg.tv/org.chromium.content.app.SandboxedProcessService0:0}
*APP UID 10112 ProcessRecord{cc 101:foreign.app/u0a112}
 mConnections:
 ConnectionRecord{dd foreign.app/org.chromium.content.app.SandboxedProcessService1:0}`;
const services = `* ServiceRecord{ee u0 com.tmg.tv/org.chromium.content.app.SandboxedProcessService0:0}
 app=ProcessRecord{ff 200:com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0/u0i1}
* ServiceRecord{gg u0 foreign.app/org.chromium.content.app.SandboxedProcessService1:0}
 app=ProcessRecord{hh 201:com.google.android.webview:sandboxed_process1:org.chromium.content.app.SandboxedProcessService1:0/u0i2}`;
it('attributes only a service connected to the exact owned app, without parent-PID assumptions', () => {
  expect(parseRendererBindings(processes, services, 100)).toEqual({
    status: 'measured',
    reason: 'service-connections',
    rendererPids: [200],
  });
  expect(parseRendererBindings(processes, services, 101).status).toBe('incomplete');
});
it('refuses missing, ambiguous, or incorrectly named renderer links', () => {
  for (const text of [
    '',
    services + '\n' + services,
    services.replace('sandboxed_process0', 'other_process'),
  ])
    expect(parseRendererBindings(processes, text, 100).status).toBe('incomplete');
  expect(
    parseRendererBindings(processes.replace('mConnections', 'unknown'), services, 100).status,
  ).toBe('incomplete');
});
it('keeps missing memory as null and sums only complete positively attributed PSS', () => {
  const app = parseProcessMemory(
    'TOTAL PSS: 100\nTOTAL RSS: 500\n Native Heap 30\n Dalvik Heap 20',
  );
  expect(app.pssKiB).toBe(100);
  expect(parseProcessMemory('').pssKiB).toBeNull();
  const binding = parseRendererBindings(processes, services, 100);
  const heap = { usedSize: 30, totalSize: 60 };
  expect(
    scanResourceSample(heap, app, binding, [{ pid: 200, pssKiB: 40 }]).attributablePssKiB,
  ).toBe(140);
  expect(scanResourceSample(heap, app, binding, []).coverage).toBe('incomplete');
  expect(
    scanResourceSample({}, app, binding, [{ pid: 200, pssKiB: 40 }]).attributablePssKiB,
  ).toBeNull();
});

it('accepts provider-declared/caller-executed and caller-declared/provider-executed only through the owned connection', () => {
  const provider = parseSelectedWebViewProvider(
    'Current WebView package (name, version): (com.google.android.webview, 109.0.5414.117)',
  );
  expect(provider).toBe('com.google.android.webview');
  const providerConnections = processes.replaceAll(
    'com.tmg.tv/org.chromium.content.app.',
    'com.google.android.webview/org.chromium.content.app.',
  );
  const providerServices = services.replaceAll(
    'com.tmg.tv/org.chromium.content.app.',
    'com.google.android.webview/org.chromium.content.app.',
  );
  const callerExecuted = providerServices.replace(
    '200:com.google.android.webview:',
    '200:com.tmg.tv:',
  );
  expect(
    parseRendererBindings(providerConnections, callerExecuted, 100, 'com.tmg.tv', provider)
      .rendererPids,
  ).toEqual([200]);
  expect(
    parseRendererBindings(processes, services, 100, 'com.tmg.tv', provider).rendererPids,
  ).toEqual([200]);
  expect(
    parseRendererBindings(
      providerConnections,
      providerServices.replace('200:com.google.android.webview:', '200:foreign.app:'),
      100,
      'com.tmg.tv',
      provider,
    ).status,
  ).toBe('incomplete');
  expect(
    parseRendererBindings(
      providerConnections.replace('100:com.tmg.tv/', '100:foreign.app/'),
      providerServices,
      100,
      'com.tmg.tv',
      provider,
    ).status,
  ).toBe('incomplete');
});
it('does not infer an installed provider from a missing or malformed update receipt', () => {
  expect(parseSelectedWebViewProvider('missing')).toBeNull();
  expect(
    parseSelectedWebViewProvider('Current WebView package (name, version): (not/a.package, 1)'),
  ).toBeNull();
});
it('matches Android14 connection-record colon delimiters without changing the service instance', () => {
  for (const suffix of [':}', ':@abcd}']) {
    const android14 = processes.replace(
      'SandboxedProcessService0:0}',
      `SandboxedProcessService0:0${suffix}`,
    );
    expect(parseRendererBindings(android14, services, 100).rendererPids).toEqual([200]);
  }
  const wrong = processes.replace('SandboxedProcessService0:0}', 'SandboxedProcessService0:1:}');
  expect(parseRendererBindings(wrong, services, 100).status).toBe('incomplete');
  const extra = processes.replace('SandboxedProcessService0:0}', 'SandboxedProcessService0:0:1}');
  expect(parseRendererBindings(extra, services, 100).status).toBe('incomplete');
});
it('refuses two service records for one exact connection rather than selecting an alias', () => {
  const android14 = processes.replace(
    'SandboxedProcessService0:0}',
    'SandboxedProcessService0:0:}',
  );
  const duplicate = services + '\n' + services.replace('200:', '300:');
  expect(parseRendererBindings(android14, duplicate, 100).status).toBe('incomplete');
});

it('admits the exact isolated package explicitly while keeping production as the default', () => {
  const isolatedProcesses = processes.replaceAll('com.tmg.tv', 'com.tmg.tv.scanproof');
  const isolatedServices = services.replaceAll('com.tmg.tv', 'com.tmg.tv.scanproof');
  expect(parseRendererBindings(isolatedProcesses, isolatedServices, 100).status).toBe('incomplete');
  const binding = parseRendererBindings(
    isolatedProcesses,
    isolatedServices,
    100,
    'com.tmg.tv.scanproof',
    'com.google.android.webview',
  );
  expect(binding.rendererPids).toEqual([200]);
  expect(
    scanResourceSample({ usedSize: 30, totalSize: 60 }, { pssKiB: 100 }, binding, [
      { pid: 200, pssKiB: 40 },
    ]).attributablePssKiB,
  ).toBe(140);
  expect(parseRendererBindings(processes, services, 100, 'com.tmg.tv.scanproof').status).toBe(
    'incomplete',
  );
});

it('refuses arbitrary package configuration and lookalike package substrings', () => {
  for (const pkg of [
    '',
    ' ',
    'foreign.app',
    'com.tmg.tv.scanproof.extra',
    'com.tmg.tv/scanproof',
    null,
    100,
  ])
    expect(parseRendererBindings(processes, services, 100, pkg).status).toBe('incomplete');
  const isolatedProcesses = processes.replaceAll('com.tmg.tv', 'com.tmg.tv.scanproof');
  const lookalikeServices = services.replace('com.tmg.tv/', 'foreign.com.tmg.tv.scanproof/');
  expect(
    parseRendererBindings(isolatedProcesses, lookalikeServices, 100, 'com.tmg.tv.scanproof').status,
  ).toBe('incomplete');
  expect(
    parseRendererBindings(processes, services.replace('com.tmg.tv/', 'foreign.com.tmg.tv/'), 100)
      .status,
  ).toBe('incomplete');
});

it('refuses reused app PID under a different package, renderer self PID and wrong provider', () => {
  const isolatedProcesses = processes.replaceAll('com.tmg.tv', 'com.tmg.tv.scanproof');
  const isolatedServices = services.replaceAll('com.tmg.tv', 'com.tmg.tv.scanproof');
  const parse = (p: string, s: string) =>
    parseRendererBindings(p, s, 100, 'com.tmg.tv.scanproof', 'com.google.android.webview');
  expect(
    parse(
      isolatedProcesses.replace('100:com.tmg.tv.scanproof/', '100:com.tmg.tv/'),
      isolatedServices,
    ).status,
  ).toBe('incomplete');
  expect(
    parse(
      isolatedProcesses,
      isolatedServices.replace(
        '200:com.google.android.webview:',
        '100:com.google.android.webview:',
      ),
    ).status,
  ).toBe('incomplete');
  expect(
    parse(
      isolatedProcesses,
      isolatedServices.replace('200:com.google.android.webview:', '200:foreign.app:'),
    ).status,
  ).toBe('incomplete');
  expect(
    parse(
      isolatedProcesses,
      isolatedServices.replace('200:com.google.android.webview:', '200:com.tmg.tv:'),
    ).status,
  ).toBe('incomplete');
});

it('requires one exact isolated owner and service instance instead of choosing an ambiguous link', () => {
  const isolatedProcesses = processes.replaceAll('com.tmg.tv', 'com.tmg.tv.scanproof');
  const isolatedServices = services.replaceAll('com.tmg.tv', 'com.tmg.tv.scanproof');
  expect(
    parseRendererBindings(
      isolatedProcesses + '\n' + isolatedProcesses,
      isolatedServices,
      100,
      'com.tmg.tv.scanproof',
    ).status,
  ).toBe('incomplete');
  expect(
    parseRendererBindings(
      isolatedProcesses,
      isolatedServices + '\n' + isolatedServices.replace('200:', '300:'),
      100,
      'com.tmg.tv.scanproof',
    ).status,
  ).toBe('incomplete');
  expect(
    parseRendererBindings(
      isolatedProcesses,
      isolatedServices.replace('SandboxedProcessService0:0}', 'SandboxedProcessService0:1}'),
      100,
      'com.tmg.tv.scanproof',
    ).status,
  ).toBe('incomplete');
});
