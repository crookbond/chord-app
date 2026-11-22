import { Platform } from 'react-native';

import { opensInFileViewer } from '@chord/kernel';

import { fetchEmailAttachmentBlobUrl, openEmailAttachmentNative, openEmailFileOnWeb } from '@/api';

/** Open one email attachment: in Chord's viewer when it can show the file
 *  (ADR 0310); otherwise a new tab on web, the share sheet / another app on a phone. */
export async function openEmailAttachment(
  messageId: string,
  att: { id: string; filename: string; mimeType: string },
): Promise<void> {
  if (Platform.OS === 'web') {
    if (opensInFileViewer(att.mimeType, att.filename, 'web')) {
      await openEmailFileOnWeb(messageId, att.id, att.filename, att.mimeType);
      return;
    }
    const url = await fetchEmailAttachmentBlobUrl(messageId, att.id);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  await openEmailAttachmentNative({
    messageId,
    attId: att.id,
    filename: att.filename,
    mimeType: att.mimeType,
  });
}
