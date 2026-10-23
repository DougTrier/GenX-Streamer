import type { SharingApi, SharingHost, SharingSettings } from './contracts';
import { SharingService } from './service';

export function mountSharingSettings(
  container: HTMLElement,
  host: SharingHost,
  options: { api?: SharingApi } = {},
): { service: SharingService; dispose(): Promise<void> } {
  const service = new SharingService(host, options.api);
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Encrypted LAN sharing');
  const title = document.createElement('h3');
  title.textContent = 'Watch on another device';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  const advanced = document.createElement('details');
  advanced.open = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Connection setup';
  advanced.append(summary);
  const form = document.createElement('form');
  const fields = new Map<string, HTMLInputElement>();
  for (const [name, label, type] of [
    ['bindAddress', 'Private interface IPv4 address', 'text'],
    ['port', 'Port', 'number'],
    ['certPath', 'Trusted certificate file', 'text'],
    ['keyPath', 'Certificate private key file', 'text'],
  ]) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const input = document.createElement('input');
    input.name = name;
    input.type = type;
    input.required = true;
    input.autocomplete = 'off';
    if (name === 'port') {
      input.min = '1';
      input.max = '65535';
    }
    wrapper.append(input);
    form.append(wrapper);
    fields.set(name, input);
  }
  const grantLabel = document.createElement('label');
  const grant = document.createElement('input');
  grant.type = 'checkbox';
  grantLabel.append(grant, ' Allow HTTP upstream streams for this sharing session');
  form.append(grantLabel);
  const trust = document.createElement('p');
  trust.textContent =
    'Your other device must trust this certificate. Sharing stays encrypted; no browser trust checks are bypassed.';
  form.append(trust);
  const start = document.createElement('button');
  start.type = 'submit';
  start.textContent = 'Start sharing';
  form.append(start);
  advanced.append(form);
  const stop = document.createElement('button');
  stop.textContent = 'Stop sharing';
  stop.type = 'button';
  const connected = document.createElement('div');
  const address = document.createElement('p');
  const invitation = document.createElement('p');
  const scope = document.createElement('select');
  scope.multiple = true;
  scope.setAttribute('aria-label', 'Channels allowed for phone control');
  const scopeLabel = document.createElement('label');
  scopeLabel.append('Phone control channel scope', scope);
  const scopeSearch = document.createElement('input');
  scopeSearch.type = 'search';
  scopeSearch.setAttribute('aria-label', 'Search channels for phone scope');
  const scopeCount = document.createElement('p');
  const selected = new Set<string>();
  scope.addEventListener('change', () => {
    for (const option of scope.options) {
      if (option.selected) selected.add(option.value);
      else selected.delete(option.value);
    }
    refreshScope();
  });
  const refreshScope = () => {
    scope.replaceChildren();
    const query = scopeSearch.value.trim().toLocaleLowerCase();
    const matches = host
      .channels()
      .filter((channel) => channel.name.toLocaleLowerCase().includes(query));
    scopeCount.textContent = `${matches.length} matches; showing up to 50. ${selected.size} channels selected.`;
    for (const channel of matches.slice(0, 50)) {
      const option = document.createElement('option');
      option.value = channel.id;
      option.textContent = channel.name;
      option.selected = selected.has(channel.id);
      scope.append(option);
    }
  };
  scopeSearch.addEventListener('input', refreshScope);
  refreshScope();
  const viewerInvite = document.createElement('button');
  viewerInvite.textContent = 'New view-only invitation';
  const controllerInvite = document.createElement('button');
  controllerInvite.textContent = 'Invite scoped phone controller';
  const refresh = document.createElement('button');
  refresh.textContent = 'Refresh connected devices';
  const viewers = document.createElement('ul');
  connected.append(
    address,
    invitation,
    viewerInvite,
    scopeSearch,
    scopeCount,
    scopeLabel,
    controllerInvite,
    refresh,
    viewers,
  );
  section.append(title, status, error, advanced, stop, connected);
  container.append(section);
  let closed = false;
  const run = (action: () => Promise<void>) => {
    void action().catch((reason: unknown) => {
      if (!closed)
        error.textContent = reason instanceof Error ? reason.message : 'Sharing action failed.';
    });
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const settings: SharingSettings = {
      bindAddress: fields.get('bindAddress')!.value.trim(),
      port: Number(fields.get('port')!.value),
      certPath: fields.get('certPath')!.value.trim(),
      keyPath: fields.get('keyPath')!.value.trim(),
      allowHttp: grant.checked,
    };
    run(() => service.start(settings));
  });
  stop.addEventListener('click', () => run(() => service.stop()));
  viewerInvite.addEventListener('click', () => run(() => service.invite('viewer')));
  controllerInvite.addEventListener('click', () =>
    run(() => service.invite('controller', [...selected])),
  );
  refresh.addEventListener('click', () => {
    refreshScope();
    run(() => service.refreshViewers());
  });
  const unsubscribe = service.subscribe((snapshot) => {
    const active = snapshot.state === 'sharing';
    status.textContent = active
      ? 'Sharing is on'
      : snapshot.state === 'stopped'
        ? 'Sharing is off'
        : `Sharing: ${snapshot.state}`;
    error.textContent = snapshot.error ?? '';
    start.disabled = snapshot.state !== 'stopped';
    stop.disabled = snapshot.state === 'stopped' || snapshot.state === 'stopping';
    connected.hidden = !active;
    if (active) advanced.open = false;
    address.textContent = snapshot.address ? `Open ${snapshot.address} on your device` : '';
    invitation.textContent = snapshot.invitation
      ? `${snapshot.invitation.role === 'viewer' ? 'View-only' : 'Phone controller'} invitation: ${snapshot.invitation.secret} (single use; expires in two minutes)`
      : '';
    viewers.replaceChildren();
    for (const id of snapshot.viewers) {
      const item = document.createElement('li');
      const revoke = document.createElement('button');
      revoke.textContent = 'Disconnect';
      revoke.addEventListener('click', () => run(() => service.revoke(id)));
      item.append(document.createTextNode(id), revoke);
      viewers.append(item);
    }
  });
  if (host.loadSettings)
    void host
      .loadSettings()
      .then((saved) => {
        if (closed || !saved) return;
        for (const [name, input] of fields)
          if (!input.value) input.value = String(saved[name as keyof SharingSettings]);
        grant.checked = saved.allowHttp;
      })
      .catch(() => {});
  return {
    service,
    async dispose() {
      closed = true;
      unsubscribe();
      section.remove();
      await service.dispose();
    },
  };
}
