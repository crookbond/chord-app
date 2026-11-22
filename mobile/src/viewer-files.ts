/**
 * The app's one registry of files handed to the viewer (see
 * `kernel/src/viewer-files.ts`). A caller registers a file it just made and
 * pushes `/file-viewer?id=<id>`; the route never accepts a file address.
 */
import { router } from 'expo-router';

import { createViewerFileRegistry, type ViewerFile } from '@chord/kernel';

export const viewerFiles = createViewerFileRegistry();

export function openInFileViewer(file: ViewerFile): void {
  const id = viewerFiles.register(file);
  router.push({ pathname: '/file-viewer', params: { id } });
}
