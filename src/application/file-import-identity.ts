import { validateSource, type Source } from '../catalog';

/** A filename is a display label, never an identity or an implicit update. */
export function createFileImportSource(
  filename: string,
  allowHttp: boolean,
  previous?: Source,
  createId: () => string = () => crypto.randomUUID(),
): Source {
  if (previous && previous.kind !== 'file')
    throw new Error('Choose a saved file playlist to update.');
  const id = previous?.id ?? createId();
  return validateSource({
    id,
    name: filename,
    kind: 'file',
    location: previous?.location ?? `import:${id}`,
    allowHttp,
  });
}
