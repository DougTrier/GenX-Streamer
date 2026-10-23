import type { Page } from '@playwright/test';
import known from '../../src/discovery/known-directory-ids.json' with { type: 'json' };

/** Controlled API metadata only. No public repository/content acquisition. */
export async function installOnlineDirectoryFixture(
  page: Page,
  locations: readonly string[],
  options: {
    hold?: boolean;
    failedIds?: readonly number[];
  } = {},
) {
  const repositories: number[] = [],
    requests: string[] = [];
  const releases: (() => void)[] = [];
  let held = options.hold ?? false;
  await page.route('https://api.github.com/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    const match = /^\/repositories\/(\d+)$/u.exec(url.pathname);
    if (match) {
      const id = Number(match[1]);
      repositories.push(id);
      if (!known.repositoryIds.includes(id)) return route.fulfill({ status: 404, body: '{}' });
      if (held) await new Promise<void>((resolve) => releases.push(resolve));
      if (options.failedIds?.includes(id))
        return route.fulfill({ status: 503, body: '{}' }).catch(() => undefined);
      return route
        .fulfill({
          json: {
            id,
            private: false,
            owner: { login: 'Controlled' },
            name: `directory-${id}`,
            full_name: `Controlled/directory-${id}`,
            html_url: `https://github.com/Controlled/directory-${id}`,
            default_branch: 'main',
          },
        })
        .catch(() => undefined);
    }
    const content = /^\/repos\/Controlled\/directory-(\d+)\/contents\/(README.md|readme.md)$/u.exec(
      url.pathname,
    );
    if (content) {
      const id = Number(content[1]),
        path = content[2]!;
      const text =
        id === known.repositoryIds[0]
          ? locations.join('\n')
          : 'No source links in this controlled document.';
      return route
        .fulfill({
          json: {
            type: 'file',
            path,
            name: path,
            url: url.href,
            encoding: 'base64',
            sha: 'a'.repeat(40),
            size: Buffer.byteLength(text),
            content: Buffer.from(text).toString('base64'),
          },
        })
        .catch(() => undefined);
    }
    const tree = /^\/repos\/Controlled\/directory-(\d+)\/git\/trees\/main$/u.exec(url.pathname);
    if (tree)
      return route
        .fulfill({
          json: {
            sha: 'a'.repeat(40),
            truncated: false,
            tree: [],
            url: `https://api.github.com/repos/Controlled/directory-${tree[1]}/git/trees/${'a'.repeat(40)}`,
          },
        })
        .catch(() => undefined);
    return route.fulfill({ status: 404, body: '{}' });
  });
  return {
    repositories,
    requests,
    release() {
      held = false;
      releases.splice(0).forEach((resolve) => resolve());
    },
  };
}
